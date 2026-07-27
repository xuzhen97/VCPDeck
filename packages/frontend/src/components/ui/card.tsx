import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
	return (
		<div className={cn("vcpdeck-panel rounded-2xl", className)} {...props} />
	);
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("space-y-1.5 p-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
	return <h2 className={cn("text-lg font-semibold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
	return (
		<p className={cn("text-sm text-muted-foreground", className)} {...props} />
	);
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("p-6 pt-0", className)} {...props} />;
}
