import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ConfirmTargetDialogProps {
	open: boolean;
	target: string;
	title: string;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
}

export function ConfirmTargetDialog({ open, target, title, onConfirm, onOpenChange }: ConfirmTargetDialogProps) {
	const [value, setValue] = useState("");

	useEffect(() => {
		if (!open) setValue("");
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>
					此操作不可撤销。请输入完整目标 <strong className="text-foreground">{target}</strong>。
				</DialogDescription>
				<div className="mt-5 space-y-2">
					<Label htmlFor="confirm-target">输入目标以确认</Label>
					<Input id="confirm-target" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" />
				</div>
				<div className="mt-6 flex justify-end gap-3">
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
					<Button type="button" variant="destructive" disabled={value !== target} onClick={onConfirm}>确认删除</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
