import { createReadStream, createWriteStream } from "node:fs";
import { stat, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, PassThrough } from "node:stream";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";
import type { JobDone, FileRef } from "@vcpdeck/shared";
import { resolveSafePath } from "./file-handler.js";

const SERVER_BASE =
	process.env.VCPDECK_SERVER || "http://localhost:3001";

/** 将相对 URL 转为绝对 URL */
function absUrl(path: string): string {
	if (path.startsWith("http://") || path.startsWith("https://")) return path;
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

			await handleImport(
				jobId,
				targetPath,
				rootDir,
				downloadRef,
				expectedSha256,
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

	const fileStream = createReadStream(safe);
	const countingStream = new PassThrough();
	countingStream.on("data", (chunk: Buffer) => hash.update(chunk));
	fileStream.pipe(countingStream);

	// safe: uploadRef.url 由 Server 签发并校验签名，非任意 URL
	const webStream = Readable.toWeb(countingStream) as ReadableStream<Uint8Array>;
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

	const sha256 = hash.digest("hex");
	emitDone(socket, jobId, "file.export", {
		fileId: uploadRef.id,
		key: uploadRef.key,
		size: fileStat.size,
		sha256,
	});
}

async function handleImport(
	jobId: string,
	targetPath: string,
	rootDir: string,
	downloadRef: FileRef,
	expectedSha256: string,
	socket: Socket,
) {
	const safe = await resolveSafePath(rootDir, targetPath);
	const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
	const hash = createHash("sha256");

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

		const countingStream = new PassThrough();
		countingStream.on("data", (chunk: Buffer) => hash.update(chunk));
		// fetch body 是 web ReadableStream，转为 Node stream 后再 pipe
		const webBody = res.body as ReadableStream<Uint8Array>;
		const nodeBody = Readable.fromWeb(webBody as any);
		nodeBody.pipe(countingStream);
		await pipeline(countingStream, createWriteStream(tmpPath));

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

		await rename(tmpPath, safe);
		emitDone(socket, jobId, "file.import", {
			path: safe,
			size: downloadRef.expiresAt, // ponytail: 实际 size 从下载端获得，首版用 downloadRef 附带
			sha256,
		});
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}
