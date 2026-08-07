import { useEffect, type ReactNode } from "react";

export function Drawer({
	open,
	onClose,
	title,
	children,
	size = "default",
	side = "right",
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	size?: "default" | "wide";
	side?: "left" | "right";
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
				className={`fixed top-0 z-50 h-full overflow-y-auto border-border bg-card p-6 shadow-xl backdrop-blur-2xl transition-transform duration-300 ${
					size === "wide" ? "w-[720px] max-w-[95vw]" : "w-96 max-w-[90vw]"
				} ${side === "left" ? "left-0 border-r" : "right-0 border-l"} ${
					open
						? "translate-x-0"
						: side === "left"
							? "-translate-x-full"
							: "translate-x-full"
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
