import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:brightness-110",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-secondary/80",
				outline: "border border-border bg-background/50 hover:bg-secondary/70",
				ghost: "hover:bg-secondary/70",
				destructive: "bg-destructive text-white hover:brightness-110",
			},
			size: {
				default: "h-11",
				sm: "h-9 min-h-9 px-3",
				icon: "size-11 px-0",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export function Button({
	className,
	variant,
	size,
	asChild = false,
	...props
}: ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
	const Component = asChild ? Slot : "button";
	return (
		<Component
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
