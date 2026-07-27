import type {
	FileChangeResult,
	FileListResult,
	FileReadTextResult,
	FileRootsResult,
	FileStatResult,
	FileTransferResult,
	JobCreate,
} from "@vcpdeck/shared";
import type { createJobsApi } from "./jobs.js";

type JobsApi = ReturnType<typeof createJobsApi>;

/** 创建远程文件 Job API。 */
export function createFilesApi(jobs: Pick<JobsApi, "create" | "wait">) {
	async function run<T>(input: JobCreate, signal?: AbortSignal): Promise<T> {
		const created = await jobs.create(input, signal);
		const job = await jobs.wait(created.jobId, { signal });
		if (job.status !== "done") throw job;
		return job.result as T;
	}

	return {
		roots: async (clientId: string, signal?: AbortSignal) =>
			(
				await run<FileRootsResult>(
					{ clientId, type: "file.roots", payload: {} },
					signal,
				)
			).roots,
		list: (
			clientId: string,
			rootDir: string,
			path: string,
			signal?: AbortSignal,
		) =>
			run<FileListResult>(
				{ clientId, type: "file.list", payload: { rootDir, path } },
				signal,
			),
		stat: (
			clientId: string,
			rootDir: string,
			path: string,
			signal?: AbortSignal,
		) =>
			run<FileStatResult>(
				{ clientId, type: "file.stat", payload: { rootDir, path } },
				signal,
			),
		readText: (
			clientId: string,
			rootDir: string,
			path: string,
			maxBytes = 262144,
			signal?: AbortSignal,
		) =>
			run<FileReadTextResult>(
				{
					clientId,
					type: "file.readText",
					payload: { rootDir, path, maxBytes },
				},
				signal,
			),
		writeText: (
			clientId: string,
			payload: { rootDir: string; path: string; content: string },
			signal?: AbortSignal,
		) =>
			run<FileChangeResult>(
				{ clientId, type: "file.writeText", payload },
				signal,
			),
		mkdir: (
			clientId: string,
			payload: { rootDir: string; path: string },
			signal?: AbortSignal,
		) =>
			run<FileChangeResult>({ clientId, type: "file.mkdir", payload }, signal),
		delete: (
			clientId: string,
			payload: { rootDir: string; path: string; recursive?: boolean },
			signal?: AbortSignal,
		) =>
			run<FileChangeResult>({ clientId, type: "file.delete", payload }, signal),
		move: (
			clientId: string,
			payload: {
				rootDir: string;
				source: string;
				destination: string;
				overwrite?: boolean;
			},
			signal?: AbortSignal,
		) =>
			run<FileChangeResult>({ clientId, type: "file.move", payload }, signal),
		export: (
			clientId: string,
			payload: { rootDir: string; path: string },
			signal?: AbortSignal,
		) =>
			run<FileTransferResult>(
				{ clientId, type: "file.export", payload },
				signal,
			),
		import: (
			clientId: string,
			payload: { rootDir: string; targetPath: string; fileId: string },
			signal?: AbortSignal,
		) =>
			run<{ path: string; size: number; sha256: string }>(
				{ clientId, type: "file.import", payload },
				signal,
			),
	};
}
