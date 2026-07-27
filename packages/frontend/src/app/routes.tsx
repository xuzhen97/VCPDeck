import { Navigate, Route, Routes } from "react-router-dom";
import { ConsoleShell } from "@/app/console-shell";
import { useAuth } from "@/auth-context";
import { LoadingState } from "@/components/async-state";
import { PageHeading } from "@/components/page-heading";
import { DashboardPage } from "@/pages/dashboard-page";
import { LoginPage } from "@/pages/login-page";
import { MachinesPage } from "@/pages/machines-page";
import { MachineWorkspace } from "@/pages/machine-workspace";

const placeholders = {
	jobs: { title: "任务", description: "最近任务记录。" },
	frp: { title: "FRP", description: "端口映射管理。" },
	storage: { title: "存储", description: "存储与阿里云盘状态。" },
	settings: { title: "设置", description: "个人资料、Token 与身份管理。" },
};

function PlaceholderPage({ page }: { page: keyof typeof placeholders }) {
	const content = placeholders[page];
	return <PageHeading title={content.title} description={content.description} />;
}

/** 应用认证路由。 */
export function AppRoutes() {
	const auth = useAuth();

	if (auth.phase === "checking") return <LoadingState label="正在验证身份…" />;
	if (auth.phase === "unauthenticated" || !auth.identity) {
		return (
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route path="*" element={<Navigate to="/login" replace />} />
			</Routes>
		);
	}

	return (
		<ConsoleShell identity={auth.identity} onLogout={auth.logout}>
			<Routes>
				<Route path="/dashboard" element={<DashboardPage />} />
				<Route path="/machines" element={<MachinesPage />} />
				<Route path="/machines/:clientId/:tab?" element={<MachineWorkspace />} />
				<Route path="/jobs/*" element={<PlaceholderPage page="jobs" />} />
				<Route path="/frp/*" element={<PlaceholderPage page="frp" />} />
				<Route path="/storage/*" element={<PlaceholderPage page="storage" />} />
				<Route
					path="/settings/*"
					element={<PlaceholderPage page="settings" />}
				/>
				<Route path="*" element={<Navigate to="/dashboard" replace />} />
			</Routes>
		</ConsoleShell>
	);
}
