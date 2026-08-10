import type { JobInfo } from "@vcpdeck/shared";
import { useEffect, useRef, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * 将 Pi 会话任务标记为已完成。
 * running / waiting_input 等活跃回合会先被后端中止；error 会话会清理错误字段。
 */
export function MarkDoneButton({
	job,
	onChanged,
	stopPropagation = false,
	size = "default",
}: {
	job: JobInfo;
	onChanged: () => void;
	stopPropagation?: boolean;
	size?: "sm" | "default";
}) {
	const sdk = useSdk();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const controller = useRef<AbortController>();
	useEffect(() => () => controller.current?.abort(), []);

	if (
		job.type !== "agent.session" ||
		job.status === "done" ||
		job.status === "cancelled"
	) {
		return null;
	}

	const complete = async () => {
		controller.current?.abort();
		const next = new AbortController();
		controller.current = next;
		setBusy(true);
		setError(undefined);
		try {
			await sdk.pi.agent.complete(job.clientId, job.jobId, undefined, next.signal);
			setOpen(false);
			onChanged();
		} catch (reason) {
			if (!next.signal.aborted) {
				setError(
					reason instanceof Error ? reason.message : String(reason),
				);
			}
		} finally {
			if (!next.signal.aborted) setBusy(false);
		}
	};

	return (
		<>
			<Button
				size={size}
				variant="outline"
				onClick={(event) => {
					if (stopPropagation) event.stopPropagation();
					setOpen(true);
				}}
			>
				标记完成
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogTitle>标记任务为已完成？</DialogTitle>
					<DialogDescription>
						若回合仍在运行，将先中止当前回合。
					</DialogDescription>
					{error && (
						<p role="alert" className="mt-4 text-sm text-red-400">
							{error}
						</p>
					)}
					<div className="mt-6 flex justify-end gap-3">
						<Button
							type="button"
							variant="ghost"
							disabled={busy}
							onClick={() => setOpen(false)}
						>
							取消
						</Button>
						<Button type="button" disabled={busy} onClick={complete}>
							{busy ? "处理中…" : "确认完成"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
