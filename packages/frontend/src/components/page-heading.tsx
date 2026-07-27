import type { ReactNode } from "react";

export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
	return (
		<header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
			</div>
			{actions}
		</header>
	);
}
