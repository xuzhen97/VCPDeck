import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { PageHeading } from "@/components/page-heading";
import { AgentChatPanel } from "@/pages/agent-chat-panel";
import { PiProfilesPanel } from "@/pages/pi-profiles-panel";
import { PiProvidersPanel } from "@/pages/pi-providers-panel";
import { PiRuntimePanel } from "@/pages/pi-runtime-panel";

/**
 * Agent 模块入口：对话面与 Pi 配置面（Profile / Provider / Client 运行时）
 * 统一挂在同一模块的二级导航下，二级导航由 `ConsoleShell` 按 URL 渲染。
 */
export function AgentPage() {
	const { pathname } = useLocation();
	// 对话视图是满高三栏布局，不能带页面标题与外层内边距
	const chatting = pathname.startsWith("/agent/chat");
	return (
		<div className={chatting ? "h-full" : "space-y-6"}>
			{!chatting && (
				<PageHeading
					title="Agent"
					description="与目标机器上的 Agent 对话，并管理 Pi 模型、凭据与 Client 运行时配置。"
				/>
			)}
			<Routes>
				<Route path="chat" element={<AgentChatPanel />} />
				<Route path="profile" element={<PiProfilesPanel />} />
				<Route path="provider" element={<PiProvidersPanel />} />
				{/* 历史别名：原 /pi/credentials */}
				<Route path="credentials" element={<PiProvidersPanel />} />
				<Route path="runtime" element={<PiRuntimePanel />} />
				<Route path="*" element={<AgentRedirect />} />
			</Routes>
		</div>
	);
}

/** 模块内未知或缺失的段一律落到对话视图。 */
function AgentRedirect() {
	const { pathname } = useLocation();
	return <Navigate to={`${pathname.replace(/\/$/, "")}/chat`} replace />;
}
