import { cn } from "@/lib/utils";

export function StatusChip({
	label,
	tone = "neutral",
}: {
	label: string;
	tone?: "success" | "warning" | "danger" | "neutral";
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
				{
					"border-emerald-500/30 bg-emerald-500/10 text-emerald-400":
						tone === "success",
					"border-amber-500/30 bg-amber-500/10 text-amber-400":
						tone === "warning",
					"border-red-500/30 bg-red-500/10 text-red-400": tone === "danger",
					"border-border bg-secondary/60 text-muted-foreground":
						tone === "neutral",
				},
			)}
		>
			{label}
		</span>
	);
}
