import type { JobCreate, JobInfo } from "@vcpdeck/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";

export type JobActionPhase =
	| "idle"
	| "creating"
	| "waiting"
	| "complete"
	| "error";

/** 创建并等待一个远程 Job；卸载只停止本地等待。 */
export function useJobAction() {
	const sdk = useSdk();
	const controller = useRef<AbortController>();
	const [phase, setPhase] = useState<JobActionPhase>("idle");
	const [job, setJob] = useState<JobInfo>();
	const [error, setError] = useState<unknown>();

	useEffect(() => () => controller.current?.abort(), []);

	const run = useCallback(
		async (input: JobCreate) => {
			controller.current?.abort();
			const next = new AbortController();
			controller.current = next;
			setJob(undefined);
			setError(undefined);
			setPhase("creating");
			try {
				const created = await sdk.jobs.create(input, next.signal);
				setPhase("waiting");
				const completed = await sdk.jobs.wait(created.jobId, {
					signal: next.signal,
				});
				setJob(completed);
				setPhase("complete");
				return completed;
			} catch (reason) {
				if (!next.signal.aborted) {
					setError(reason);
					setPhase("error");
				}
				throw reason;
			}
		},
		[sdk],
	);

	const reset = useCallback(() => {
		controller.current?.abort();
		setPhase("idle");
		setJob(undefined);
		setError(undefined);
	}, []);

	return { phase, job, error, run, reset };
}
