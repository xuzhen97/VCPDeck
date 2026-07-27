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
	it("wraps file.roots as a read job", async () => {
		const jobs = {
			create: vi.fn().mockResolvedValue({ jobId: "j1" }),
			wait: vi.fn().mockResolvedValue({
				status: JobStatus.DONE,
				result: { roots: ["C:\\"] },
			}),
		};

		await expect(createFilesApi(jobs as never).roots("c1")).resolves.toEqual([
			"C:\\",
		]);
		expect(jobs.create).toHaveBeenCalledWith(
			{ clientId: "c1", type: "file.roots", payload: {} },
			undefined,
		);
	});
});
