import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export interface FrpActionMenuItem {
	label: string;
	tone?: "default" | "danger";
	disabled?: boolean;
	onSelect: () => void | Promise<void>;
}

export function FrpActionMenu({ items }: { items: FrpActionMenuItem[] }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={root} className="relative flex justify-end">
			<Button
				type="button"
				size="icon"
				variant="ghost"
				aria-label="更多操作"
				onClick={() => setOpen((value) => !value)}
			>
				<MoreHorizontal className="size-4" />
			</Button>
			{open && (
				<div className="absolute right-0 top-11 z-30 min-w-40 rounded-xl border border-border bg-card p-1 text-sm shadow-xl backdrop-blur-2xl">
					{items.map((item) => (
						<button
							key={item.label}
							type="button"
							disabled={item.disabled}
							className={`block w-full rounded-lg px-3 py-2 text-left disabled:opacity-50 ${item.tone === "danger" ? "text-red-400 hover:bg-red-500/10" : "hover:bg-secondary/70"}`}
							onClick={async () => {
								await item.onSelect();
								setOpen(false);
							}}
						>
							{item.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
