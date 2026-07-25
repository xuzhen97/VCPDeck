import { resolve } from "node:path";
import {
	readdir,
	stat,
	readFile,
	writeFile,
	mkdir,
	rm,
	rename,
	realpath,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";
import type { JobDone } from "@vcpdeck/shared";

/** 路径安全校验 + 规范化 */
export async function resolveSafePath(
	rootDir: string,
	userPath: string,
): Promise<string> {
	const resolvedRoot = resolve(rootDir).replace(/\\/g, "/").toLowerCase();
	const resolved = resolve(resolvedRoot, userPath)
		.replace(/\\/g, "/")
		.toLowerCase();

	if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
		throw {
			code: FileErrorCode.PATH_NOT_ALLOWED,
			message: "Path escapes rootDir",
		};
	}

	// realpath 防 symlink 逃逸（仅在文件已存在时有效）
	try {
		const real = (await realpath(resolved)).replace(/\\/g, "/").toLowerCase();
		if (!real.startsWith(resolvedRoot + "/") && real !== resolvedRoot) {
			throw {
				code: FileErrorCode.PATH_NOT_ALLOWED,
				message: "Symlink escapes rootDir",
			};
		}
	} catch {
		// 文件不存在时 realpath 抛错，前缀检查已覆盖
	}

	return resolved;
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

/** 处理轻量 fs 操作 */
export async function handleFileOp(
	job: {
		jobId: string;
		type: string;
		payload: Record<string, unknown>;
		timeout?: number;
	},
	socket: Socket,
) {
	const { jobId, type, payload } = job;
	const rootDir = payload.rootDir as string;

	try {
		switch (type) {
			case "file.list": {
				const safe = await resolveSafePath(rootDir, payload.path as string);
				const dirents = await readdir(safe, { withFileTypes: true });
				const entries = await Promise.all(
					dirents.map(async (d) => {
						const st = await stat(resolve(safe, d.name));
						return {
							name: d.name,
							kind: (d.isDirectory() ? "dir" : "file") as "dir" | "file",
							size: st.size,
							mtime: st.mtime.toISOString(),
						};
					}),
				);
				emitDone(socket, jobId, type, { entries });
				return;
			}
			case "file.stat": {
				const safe = await resolveSafePath(rootDir, payload.path as string);
				const st = await stat(safe);
				emitDone(socket, jobId, type, {
					name: (payload.path as string).split(/[/\\]/).pop() || "",
					kind: (st.isDirectory() ? "dir" : "file") as "dir" | "file",
					size: st.size,
					mtime: st.mtime.toISOString(),
				});
				return;
			}
			case "file.readText": {
				const maxBytes = (payload.maxBytes as number) ?? 262144;
				const safe = await resolveSafePath(rootDir, payload.path as string);
				const st = await stat(safe);
				if (st.size > maxBytes) {
					emitError(
						socket,
						jobId,
						type,
						FileErrorCode.SIZE_EXCEEDED,
						`File larger than ${maxBytes} bytes`,
					);
					return;
				}
				const content = await readFile(safe, "utf8");
				emitDone(socket, jobId, type, { content, size: st.size });
				return;
			}
			case "file.writeText": {
				const safe = await resolveSafePath(rootDir, payload.path as string);
				const content = payload.content as string;
				const tmpPath = `${safe}.vcpdeck-tmp-${randomUUID()}`;
				await writeFile(tmpPath, content, "utf8");
				await rename(tmpPath, safe);
				emitDone(socket, jobId, type, { path: safe });
				return;
			}
			case "file.mkdir": {
				const safe = await resolveSafePath(rootDir, payload.path as string);
				await mkdir(safe, { recursive: true });
				emitDone(socket, jobId, type, { path: safe });
				return;
			}
			case "file.delete": {
				const safe = await resolveSafePath(rootDir, payload.path as string);
				const recursive = payload.recursive === true;
				if (!recursive) {
					const st = await stat(safe).catch(() => null);
					if (st?.isDirectory()) {
						const ents = await readdir(safe);
						if (ents.length > 0) {
							emitError(
								socket,
								jobId,
								type,
								FileErrorCode.PATH_CONFLICT,
								"Directory not empty; set recursive=true",
							);
							return;
						}
					}
				}
				await rm(safe, { recursive, force: true });
				emitDone(socket, jobId, type, { path: safe });
				return;
			}
			case "file.move": {
				const src = await resolveSafePath(rootDir, payload.source as string);
				const dest = await resolveSafePath(
					rootDir,
					payload.destination as string,
				);
				const overwrite = payload.overwrite === true;
				if (!overwrite) {
					try {
						await stat(dest);
						emitError(
							socket,
							jobId,
							type,
							FileErrorCode.PATH_CONFLICT,
							"Destination exists; set overwrite=true",
						);
						return;
					} catch {
						// dest 不存在，OK
					}
				}
				await rename(src, dest);
				emitDone(socket, jobId, type, { path: dest });
				return;
			}
			default:
				throw new Error(`Unknown file op: ${type}`);
		}
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
