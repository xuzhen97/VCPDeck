import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ConfirmTargetDialogProps {
	open: boolean;
	/** "type" 模式：要求用户完整输入 target 字符串才能确认（用于路径/实例名等不可逆操作）。 */
	/** "confirm" 模式：仅显示 target 作为信息，yes/no 直接确认（用于名称冗长、已有上下文识别的场景）。 */
	mode?: "type" | "confirm";
	target: string;
	title: string;
	error?: string;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
}

/** 长名截断展示：避免把整段会话名塞进弹窗造成视觉噪音。 */
function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…`;
}

export function ConfirmTargetDialog({
	open,
	mode = "type",
	target,
	title,
	error,
	onConfirm,
	onOpenChange,
}: ConfirmTargetDialogProps) {
	const [value, setValue] = useState("");

	useEffect(() => {
		if (!open) setValue("");
	}, [open]);

	const canConfirm = mode === "confirm" ? true : value === target;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogTitle>{title}</DialogTitle>
				{mode === "type" ? (
					<DialogDescription>
						此操作不可撤销。请输入完整目标{" "}
						<strong className="text-foreground">{target}</strong>。
					</DialogDescription>
				) : (
					<DialogDescription>
						此操作不可撤销。即将删除：
						<div className="mt-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm">
							<div
								className="truncate font-medium text-foreground"
								title={target}
							>
								{truncate(target, 24)}
							</div>
						</div>
					</DialogDescription>
				)}
				{mode === "type" && (
					<div className="mt-5 space-y-2">
						<Label htmlFor="confirm-target">输入目标以确认</Label>
						<Input
							id="confirm-target"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							autoComplete="off"
						/>
					</div>
				)}
				{error && (
					<p role="alert" className="mt-4 text-sm text-red-400">
						{error}
					</p>
				)}
				<div className="mt-6 flex justify-end gap-3">
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						取消
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={!canConfirm}
						onClick={onConfirm}
					>
						{mode === "confirm" ? "删除" : "确认删除"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
