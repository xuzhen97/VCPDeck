import { Component, type ReactNode } from "react";

/**
 * 渲染降级护栏：渲染层抛错时回落纯文本（ADR-0032 决策 5），
 * 保证 vendored 渲染器的缺陷不阻断会话。
 */
export class PiRenderBoundary extends Component<
	{ fallback: ReactNode; children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
