import { createReadStream, createWriteStream } from "node:fs";
import { stat, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";
import type { JobDone, FileRef } from "@vcpdeck/shared";
import { resolveSafePath } from "./file-handler.js";

const SERVER_BASE = process.env.VCPDECK_SERVER || "http://localhost:3001";

/** 将相对 URL 转为绝对 URL；绝对 URL 必须与 Server 同源，防止拉取任意内网地址 */
function absUrl(path: string): string {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		let base: URL;
		let target: URL;
		try {
			base = new URL(SERVER_BASE);
			target = new URL(path);
		} catch {
			throw new Error("Invalid transfer URL");
		}
		if (target.origin !== base.origin) {
			throw new Error(`Blocked URL outside server origin: ${target.origin}`);
		}
		return path;
	}
	return `${SERVER_BASE}${path}`;
}

function emitDone(
	socket: Socket,
	jobId: string,
	type: string,
	result: Record<string, unknown>,
) {
	socket.emit(Events.JOB_DONE, { jobId, type, result } satisfies JobDone);
}

function emitError(
	socket: Socket,
	jobId: string,
	type: string,
	code: string,
	message: string,
) {
	socket.emit(Events.JOB_DONE, {
		jobId,
		type,
		error: { code, message },
	} satisfies JobDone);
}

export async function handleTransfer(
	job: {
		jobId: string;
		type: string;
		payload: Record<string, unknown>;
		timeout?: number;
	},
	socket: Socket,
) {
	const { jobId, type, payload } = job;

	try {
		if (type === "file.export") {
			const path = payload.path as string;
			const rootDir = payload.rootDir as string;
			const uploadRef = payload.uploadRef as FileRef;

			await handleExport(jobId, path, rootDir, uploadRef, socket);
			return;
		}

		if (type === "file.import") {
			const targetPath = payload.targetPath as string;
			const rootDir = payload.rootDir as string;
			const downloadRef = payload.downloadRef as FileRef;
			const expectedSha256 = payload.sha256 as string;
			const expectedSize = Number(payload.size ?? 0);
			const overwrite = payload.overwrite === true;

			await handleImport(
				jobId,
				targetPath,
				rootDir,
				downloadRef,
				expectedSha256,
				expectedSize,
				overwrite,
				socket,
			);
			return;
		}

		throw new Error(`Unknown transfer type: ${type}`);
	} catch (err: any) {
		if (err.code && typeof err.code === "string") {
			emitError(socket, jobId, type, err.code, err.message);
			return;
		}
		const code =
			(err as NodeJS.ErrnoException).code === "ENOENT"
				? FileErrorCode.PATH_NOT_FOUND
				: FileErrorCode.IO_ERROR;
		emitError(
			socket,
			jobId,
			type,
			code,
			code === FileErrorCode.PATH_NOT_FOUND ? "Path not found" : err.message,
		);
	}
}

async function handleExport(
	jobId: string,
	path: string,
	rootDir: string,
	uploadRef: FileRef,
	socket: Socket,
) {
	const safe = await resolveSafePath(rootDir, path);
	const fileStat = await stat(safe);
	const hash = createHash("sha256");
	const total = fileStat.size;

	const fileStream = createReadStream(safe);
	// 传输段进度 + sha256：用 Transform 计数（toWeb 与 data 监听器在同一流上互斥，
	// 此前 hash 恒为空摘要且进度无法上报）
	let loaded = 0;
	let lastEmitAt = 0;
	let lastEmitBytes = 0;
	const hashTransform = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			loaded += chunk.length;
			const now = Date.now();
			if (now - lastEmitAt >= 500 || loaded - lastEmitBytes >= 1024 * 1024) {
				lastEmitAt = now;
				lastEmitBytes = loaded;
				socket.emit(Events.JOB_PROGRESS, { jobId, loaded, total });
			}
			callback(null, chunk);
		},
		flush(callback) {
			if (loaded !== lastEmitBytes) {
				lastEmitBytes = loaded;
				socket.emit(Events.JOB_PROGRESS, { jobId, loaded, total });
			}
			callback();
		},
	});
	fileStream.pipe(hashTransform);

	// safe: uploadRef.url 由 Server 签发并校验签名，非任意 URL
	const webStream = Readable.toWeb(hashTransform) as ReadableStream<Uint8Array>;
	const res = await fetch(absUrl(uploadRef.url), {
		method: "PUT",
		body: webStream,
		duplex: "half",
	} as any);
	if (!res.ok) {
		emitError(
			socket,
			jobId,
			"file.export",
			FileErrorCode.IO_ERROR,
			`Upload failed: HTTP ${res.status}`,
		);
		return;
	}

	// 真实存储 key：阿里云盘后端上传后以 fileId 作为 key，由 Server 响应返回；
	// 忽略响应会导致后续下载签名使用错误 key（本地后端响应 key 与原 key 相同）
	const uploaded = (await res.json().catch(() => null)) as {
		key?: string;
		size?: number;
	} | null;
	const sha256 = hash.digest("hex");
	emitDone(socket, jobId, "file.export", {
		fileId: uploadRef.id,
		key: uploaded?.key || uploadRef.key,
		size: uploaded?.size ?? fileStat.size,
		sha256,
	});
}

async function handleImport(
	jobId: string,
	targetPath: string,
	rootDir: string,
	downloadRef: FileRef,
	expectedSha256: string,
	expectedSize: number,
	overwrite: boolean,
	socket: Socket,
) {
	const safe = await resolveSafePath(rootDir, targetPath);
	const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
	const hash = createHash("sha256");
	let loaded = 0;
	let lastEmitAt = 0;
	let lastEmitBytes = 0;

	try {
		// safe: downloadRef.url 由 Server 签发并校验签名，非任意 URL
		const res = await fetch(absUrl(downloadRef.url), { method: "GET" });
		if (!res.ok) {
			emitError(
				socket,
				jobId,
				"file.import",
				FileErrorCode.IO_ERROR,
				`Download failed: HTTP ${res.status}`,
			);
			return;
		}

		const tracker = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				hash.update(buffer);
				loaded += buffer.length;
				const now = Date.now();
				if (
					now - lastEmitAt >= 500 ||
					loaded - lastEmitBytes >= 1024 * 1024
				) {
					lastEmitAt = now;
					lastEmitBytes = loaded;
					socket.emit(Events.JOB_PROGRESS, {
						jobId,
						loaded,
						total: expectedSize,
					});
				}
				callback(null, buffer);
			},
			flush(callback) {
				if (loaded !== lastEmitBytes) {
					lastEmitBytes = loaded;
					socket.emit(Events.JOB_PROGRESS, {
						jobId,
						loaded,
						total: expectedSize,
					});
				}
				callback();
			},
		});
		// fetch body 是 web ReadableStream，转为 Node stream 后再写入临时文件。
		const webBody = res.body as ReadableStream<Uint8Array>;
		if (!webBody) throw new Error("Download response has no body");
		const nodeBody = Readable.fromWeb(webBody as any);
		await pipeline(nodeBody, tracker, createWriteStream(tmpPath));

		const sha256 = hash.digest("hex");
		if (sha256 !== expectedSha256) {
			await unlink(tmpPath).catch(() => {});
			emitError(
				socket,
				jobId,
				"file.import",
				FileErrorCode.SHA256_MISMATCH,
				"SHA-256 mismatch",
			);
			return;
		}

		const existing = await stat(safe).catch(() => null);
		if (existing?.isDirectory() || (existing && !overwrite)) {
			await unlink(tmpPath).catch(() => {});
			emitError(
				socket,
				jobId,
				"file.import",
				FileErrorCode.PATH_CONFLICT,
				"Destination exists; set overwrite=true",
			);
			return;
		}
		if (existing && overwrite) await unlink(safe);
		await rename(tmpPath, safe);
		emitDone(socket, jobId, "file.import", {
			path: safe,
			size: loaded,
			sha256,
		});
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}
