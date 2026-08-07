import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PiSessionState } from "./use-pi-session.js";

/** 标准 Extension UI 对话框（select/confirm/input/editor） */
export function PiExtensionDialog({
	request,
	disabled,
	onRespond,
	onCancel,
}: {
	request: NonNullable<PiSessionState["pendingExtension"]>;
	disabled: boolean;
	onRespond: (value: string, confirmed?: boolean) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState("");
	const [selected, setSelected] = useState<string | null>(null);

	const title = request.title ?? "扩展请求";
	const message = request.message;

	if (request.kind === "select") {
		return (
			<Dialog open onOpenChange={(open) => !open && onCancel()}>
				<DialogContent>
					<DialogTitle>{title}</DialogTitle>
					{message && <DialogDescription>{message}</DialogDescription>}
					<div className="space-y-1">
						{(request.options ?? []).map((option) => (
							<button
								key={option}
								type="button"
								className={`block w-full rounded border px-2 py-1.5 text-left text-sm ${
									selected === option ? "border-primary" : "border-border"
								}`}
								onClick={() => setSelected(option)}
							>
								{option}
							</button>
						))}
					</div>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onCancel}>
							取消
						</Button>
						<Button
							type="button"
							disabled={disabled || selected === null}
							onClick={() => selected !== null && onRespond(selected)}
						>
							确定
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	if (request.kind === "confirm") {
		return (
			<Dialog open onOpenChange={(open) => !open && onCancel()}>
				<DialogContent>
					<DialogTitle>{title}</DialogTitle>
					{message && <DialogDescription>{message}</DialogDescription>}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onCancel}>
							取消
						</Button>
						<Button type="button" disabled={disabled} onClick={() => onRespond("", true)}>
							确认
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	// input / editor
	return (
		<Dialog open onOpenChange={(open) => !open && onCancel()}>
			<DialogContent>
				<DialogTitle>{title}</DialogTitle>
				{message && <DialogDescription>{message}</DialogDescription>}
				{request.kind === "editor" ? (
					<textarea
						className="h-40 w-full rounded border border-border bg-background p-2 text-sm"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						aria-label="编辑器输入"
					/>
				) : (
					<Input
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={message ?? "输入…"}
					/>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={onCancel}>
						取消
					</Button>
					<Button type="button" disabled={disabled} onClick={() => onRespond(value)}>
						提交
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
