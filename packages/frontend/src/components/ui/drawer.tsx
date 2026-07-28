import { useEffect, type ReactNode } from "react";

export function Drawer({
	open,
	onClose,
	title,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
}) {
	useEffect(() => {
		if (!open) return;
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open, onClose]);

	return (
		<>
			{open && (
				<div
					className="fixed inset-0 z-40 bg-black/40"
					onClick={onClose}
					aria-hidden
				/>
			)}
			<div
				role="dialog"
				aria-modal={open}
				aria-label={title}
				className={`fixed right-0 top-0 z-50 h-full w-96 max-w-[90vw] overflow-y-auto border-l border-border bg-card p-6 shadow-xl backdrop-blur-2xl transition-transform duration-300 ${
					open ? "translate-x-0" : "translate-x-full"
				}`}
			>
				<div className="mb-6 flex items-center justify-between">
					<h2 className="text-lg font-semibold">{title}</h2>
					<button
						onClick={onClose}
						className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary/60"
						aria-label="关闭"
					>
						✕
					</button>
				</div>
				{children}
			</div>
		</>
	);
}
