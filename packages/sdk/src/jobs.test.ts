import { JobStatus } from "@vcpdeck/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilesApi } from "./files.js";
import { createJobsApi } from "./jobs.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("jobs", () => {
	it("waits through disconnected and returns done", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn()
			.mockResolvedValueOnce({ jobId: "j1", status: JobStatus.DISCONNECTED })
			.mockResolvedValueOnce({
				jobId: "j1",
				status: JobStatus.DONE,
				result: { exitCode: 0 },
			});
		const promise = createJobsApi({ request } as never).wait("j1");

		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(2000);

		await expect(promise).resolves.toMatchObject({ status: JobStatus.DONE });
	});

	it("wait invokes onUpdate for intermediate job states", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				jobId: "j1",
				status: JobStatus.RUNNING,
				progress: { loaded: 2, total: 5 },
			})
			.mockResolvedValueOnce({ jobId: "j1", status: JobStatus.DONE });
		const onUpdate = vi.fn();
		const promise = createJobsApi({ request } as never).wait("j1", {
			onUpdate,
		});

		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(2000);
		await expect(promise).resolves.toMatchObject({ status: JobStatus.DONE });
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ progress: { loaded: 2, total: 5 } }),
		);
	});

	it("stops local waiting when aborted", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const promise = createJobsApi({ request: vi.fn() } as never).wait("j1", {
			signal: controller.signal,
		});

		controller.abort();

		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("files", () => {
	it("creates and completes an upload session", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				jobId: "j1",
				fileId: "f1",
				status: JobStatus.WAITING_INPUT,
				upload: { url: "/api/storage/upload/k", expiresAt: 123 },
			})
			.mockResolvedValueOnce({
				jobId: "j1",
				status: JobStatus.PENDING,
				type: "file.import",
			});
		const files = createFilesApi({ request } as never, {
			create: vi.fn(),
			wait: vi.fn(),
		} as never);

		await expect(
			files.createUploadSession({
				clientId: "c1",
				rootDir: "D:\\",
				targetPath: "a.txt",
				filename: "a.txt",
				size: 5,
			}),
		).resolves.toMatchObject({ fileId: "f1" });
		await files.completeUpload("j1");
		expect(request).toHaveBeenNthCalledWith(
			1,
			"POST",
			"/api/files/upload-sessions",
			expect.any(Object),
			undefined,
		);
		expect(request).toHaveBeenNthCalledWith(
			2,
			"POST",
			"/api/files/upload-sessions/j1/complete",
			undefined,
			undefined,
		);
	});

	it("passes overwrite when importing", async () => {
		const jobs = {
			create: vi.fn().mockResolvedValue({ jobId: "j1" }),
			wait: vi.fn().mockResolvedValue({
				status: JobStatus.DONE,
				result: { path: "a.txt", size: 5, sha256: "sha" },
			}),
		};
		await createFilesApi({ request: vi.fn() } as never, jobs as never).import("c1", {
			rootDir: "D:\\",
			targetPath: "a.txt",
			fileId: "f1",
			overwrite: true,
		});
		expect(jobs.create).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({ overwrite: true }),
			}),
			undefined,
		);
	});

	it("wraps file.roots as a read job", async () => {
		const jobs = {
			create: vi.fn().mockResolvedValue({ jobId: "j1" }),
			wait: vi.fn().mockResolvedValue({
				status: JobStatus.DONE,
				result: { roots: ["C:\\"] },
			}),
		};

		await expect(
			createFilesApi({ request: vi.fn() } as never, jobs as never).roots("c1"),
		).resolves.toEqual([
			"C:\\",
		]);
		expect(jobs.create).toHaveBeenCalledWith(
			{ clientId: "c1", type: "file.roots", payload: {} },
			undefined,
		);
	});
});
