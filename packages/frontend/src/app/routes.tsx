import {
	Navigate,
	Route,
	Routes,
} from "react-router-dom";
import { ConsoleShell } from "@/app/console-shell";
import { useAuth } from "@/auth-context";
import { LoadingState } from "@/components/async-state";
import { DashboardPage } from "@/pages/dashboard-page";
import { DevelopDshPage } from "@/pages/develop-dsh-page";
import { FrpPage } from "@/pages/frp-page";
import { FeaturesPage } from "@/pages/machine-features-panel";
import { JobDetailPage } from "@/pages/job-detail-page";
import { AgentTasksPage } from "@/pages/agent-tasks-page";
import { JobsPage } from "@/pages/jobs-page";
import { LoginPage } from "@/pages/login-page";
import { MachinesPage } from "@/pages/machines-page";
import { MachineWorkspace } from "@/pages/machine-workspace";
import { ReleasesPage } from "@/pages/releases-page";
import { SettingsPage } from "@/pages/settings-page";

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
				<Route
					path="/machines/:clientId/:tab?"
					element={<MachineWorkspace />}
				/>
				<Route path="/jobs" element={<JobsPage />} />
				<Route path="/jobs/:jobId" element={<JobDetailPage />} />
				<Route path="/agent-tasks" element={<AgentTasksPage />} />
				<Route path="/frp" element={<FrpPage />} />
				<Route path="/features" element={<FeaturesPage />} />
				<Route path="/develop" element={<DevelopDshPage />} />
				<Route path="/releases" element={<ReleasesPage />} />
				{/* 兼容旧入口：存储已并入设置模块 */}
				<Route
					path="/storage"
					element={<Navigate to="/settings/storage" replace />}
				/>
				<Route path="/settings/*" element={<SettingsPage />} />
				<Route path="*" element={<Navigate to="/dashboard" replace />} />
			</Routes>
		</ConsoleShell>
	);
}
