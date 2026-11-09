import { createReadStream, createWriteStream } from "node:fs";
import { stat, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";
import type { JobDone, FileRef, FileExportSession } from "@vcpdeck/shared";
import { resolveSafePath } from "./file-handler.js";

const SERVER_BASE = process.env.VCPDECK_SERVER || "http://localhost:3001";

const CLIENT_PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
const EXPORT_CONTROL_HEADERS = {
	"content-type": "application/json",
	"x-vcpdeck-psk": CLIENT_PSK,
};

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

// ── 直传（阿里云 OSS 分片） ──
const PART_RETRIES = 2;

/** 读取 OSS 错误体中的 Code/Message/RequestId；失败时返回空串，避免掩盖原始错误。 */
async function readUploadErrorDetail(res: Response): Promise<string> {
	try {
		const text = await res.text();
		const pick = (tag: string) => {
			const startTag = `<${tag}>`;
			const endTag = `</${tag}>`;
			const start = text.indexOf(startTag);
			const end = text.indexOf(endTag);
			const value =
				start >= 0 && end > start
					? text.slice(start + startTag.length, end)
					: "";
			return value.replace(/[ \t\r\n]+/g, " ").trim().slice(0, 200);
		};
		const code = pick("Code");
		const message = pick("Message");
		const requestId = pick("RequestId");
		const detail = [code, message, requestId ? `RequestId=${requestId}` : ""]
			.filter(Boolean)
			.join(" ");
		if (detail) return ` (${detail})`;
		const compact = text.replace(/[ \t\r\n]+/g, " ").trim().slice(0, 300);
		return compact ? ` (${compact})` : "";
	} catch {
		return "";
	}
}

/** 顺序 PUT 分片：阿里云盘要求分片串行上传，并发会在后续分片返回 HTTP 400。 */
async function uploadParts(
	parts: Array<{ partNumber: number; url: string }>,
	size: number,
	opts: {
		readPart(partNumber: number, start: number, end: number): Promise<BodyInit>;
		onProgress?(loaded: number): void;
		signal?: AbortSignal;
		partSize: number;
		refreshUrl(partNumber: number): Promise<string>;
	},
): Promise<void> {
	const partSize = opts.partSize;
	let loaded = 0;
	const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
	for (const part of ordered) {
		const start = (part.partNumber - 1) * partSize;
		const end = Math.min(size, start + partSize);
		const length = end - start;
		if (length <= 0) {
			throw new Error(`分片 ${part.partNumber} 超出文件范围`);
		}
		let url = part.url;
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(url, {
				method: "PUT",
				body: await opts.readPart(part.partNumber, start, end),
				headers: { "content-length": String(length) },
				signal: opts.signal,
				duplex: "half",
			} as unknown as RequestInit);
			if (res.ok) break;
			if (res.status === 403 && attempt < PART_RETRIES) {
				url = await opts.refreshUrl(part.partNumber);
				continue;
			}
			if ((res.status === 429 || res.status >= 500) && attempt < PART_RETRIES) {
				continue;
			}
			const detail = await readUploadErrorDetail(res);
			throw new Error(
				`分片 ${part.partNumber} 上传失败: HTTP ${res.status}${detail}`,
			);
		}
		loaded += length;
		opts.onProgress?.(loaded);
	}
}

/** 协商导出直传会话（Server 建阿里云分片任务） */
async function negotiateExportSession(
	jobId: string,
	size: number,
): Promise<FileExportSession> {
	const res = await fetch(absUrl("/api/files/client-export-sessions"), {
		method: "POST",
		headers: EXPORT_CONTROL_HEADERS,
		body: JSON.stringify({ jobId, size }),
	});
	if (!res.ok) throw new Error(`Export session failed: HTTP ${res.status}`);
	return (await res.json()) as FileExportSession;
}

/** 续期指定分片的上传 URL */
async function refreshExportPartUrl(
	jobId: string,
	partNumber: number,
): Promise<string> {
	const res = await fetch(
		absUrl(`/api/files/client-export-sessions/${jobId}/part-urls`),
		{
			method: "POST",
			headers: EXPORT_CONTROL_HEADERS,
			body: JSON.stringify({ partNumbers: [partNumber] }),
		},
	);
	if (!res.ok) throw new Error(`刷新分片 URL 失败: HTTP ${res.status}`);
	const parts = (await res.json()) as Array<{
		partNumber: number;
		url: string;
	}>;
	const part = parts.find((p) => p.partNumber === partNumber);
	if (!part?.url) throw new Error("刷新分片 URL 未返回新地址");
	return part.url;
}

/** 完成导出直传，返回真实 storage key */
async function completeExportUpload(
	jobId: string,
	uploadedBytes: number,
): Promise<string> {
	const res = await fetch(
		absUrl(`/api/files/client-export-sessions/${jobId}/complete`),
		{
			method: "POST",
			headers: EXPORT_CONTROL_HEADERS,
			body: JSON.stringify({ uploadedBytes }),
		},
	);
	if (!res.ok) throw new Error(`Export complete failed: HTTP ${res.status}`);
	const body = (await res.json()) as { key?: string };
	return body.key ?? "";
}

/** 顺序读整个文件计算 SHA-256（分片直传完成后统一计算，避免分片流打乱哈希顺序）。 */
function computeFileSha256(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk: Buffer) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
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

/** 正在执行的传输 Job；心跳据此上报租约，避免服务端把长传输误判为丢失。 */
const activeTransfers = new Set<string>();

/** 正在执行的传输 Job id 快照（供心跳与状态上报合并）。 */
export function getActiveTransferJobIds(): string[] {
	return [...activeTransfers];
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

	// 传输不在 executor 的 activeJobs 里：不登记的话服务端心跳租约对账
	// 会把正在跑的几十 GB 导出/导入当成孤儿 Job 直接判死。
	activeTransfers.add(jobId);
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
			const expectedSize = Number(payload.size ?? 0);
			const overwrite = payload.overwrite === true;

			await handleImport(
				jobId,
				targetPath,
				rootDir,
				downloadRef,
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
	} finally {
		activeTransfers.delete(jobId);
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
	const total = fileStat.size;

	// 直连模式：Client stat 文件后协商直传会话，分片 PUT 到 OSS，最后完成导出
	if (uploadRef.direct) {
		const session = await negotiateExportSession(jobId, total);
		await uploadParts(session.parts, total, {
			partSize: session.partSize,
			readPart: async (_n, start, end): Promise<BodyInit> =>
				Readable.toWeb(
					createReadStream(safe, { start, end: end - 1 }),
				) as unknown as BodyInit,
			onProgress: (loaded) =>
				socket.emit(Events.JOB_PROGRESS, { jobId, loaded, total }),
			refreshUrl: (partNumber) => refreshExportPartUrl(jobId, partNumber),
		});
		const key = await completeExportUpload(jobId, total);
		const sha256 = await computeFileSha256(safe);
		emitDone(socket, jobId, "file.export", {
			fileId: uploadRef.id,
			key,
			size: total,
			sha256,
		});
		return;
	}

	const fileStream = createReadStream(safe);
	// 传输段进度 + sha256：用 Transform 计数（toWeb 与 data 监听器在同一流上互斥，
	// 此前 hash 恒为空摘要且进度无法上报）
	const hash = createHash("sha256");
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
	expectedSize: number,
	overwrite: boolean,
	socket: Socket,
) {
	const safe = await resolveSafePath(rootDir, targetPath);
	const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
	let loaded = 0;
	let lastEmitAt = 0;
	let lastEmitBytes = 0;

	try {
		// safe: downloadRef.url 由 Server 签发（proxy）或由阿里云 getDownloadUrl 生成（direct）
		const res = await fetch(
			downloadRef.direct ? downloadRef.url : absUrl(downloadRef.url),
			{ method: "GET" },
		);
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
				loaded += buffer.length;
				const now = Date.now();
				if (now - lastEmitAt >= 500 || loaded - lastEmitBytes >= 1024 * 1024) {
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

		if (loaded !== expectedSize) {
			await unlink(tmpPath).catch(() => {});
			emitError(
				socket,
				jobId,
				"file.import",
				FileErrorCode.IO_ERROR,
				`Size mismatch: expected ${expectedSize}, got ${loaded}`,
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
			key: downloadRef.key,
			size: loaded,
		});
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}
