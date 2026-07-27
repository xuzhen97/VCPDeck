import { Button } from "@/components/ui/button";

export function LoadingState({ label = "正在加载…" }: { label?: string }) {
	return <p aria-busy="true" className="py-12 text-center text-sm text-muted-foreground">{label}</p>;
}

export function ErrorState({ message = "加载失败", onRetry }: { message?: string; onRetry?: () => void }) {
	return (
		<div role="alert" className="vcpdeck-panel rounded-xl p-5 text-sm">
			<p>{message}</p>
			{onRetry && <Button className="mt-4" variant="outline" onClick={onRetry}>重试</Button>}
		</div>
	);
}
