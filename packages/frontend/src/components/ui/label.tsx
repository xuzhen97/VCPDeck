import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: ComponentProps<"label">) {
	// biome-ignore lint/a11y/noLabelWithoutControl: 通用基础组件，关联方式（htmlFor 或嵌套）由调用方决定
	return <label className={cn("text-sm font-medium", className)} {...props} />;
}
