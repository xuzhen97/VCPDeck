import {
	Navigate,
	Route,
	Routes,
	useLocation,
	useParams,
} from "react-router-dom";
import { ConsoleShell } from "@/app/console-shell";
import { useAuth } from "@/auth-context";
import { LoadingState } from "@/components/async-state";
import { AgentPage } from "@/pages/agent-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { FrpPage } from "@/pages/frp-page";
import { JobDetailPage } from "@/pages/job-detail-page";
import { JobsPage } from "@/pages/jobs-page";
import { legacyPiTarget, machinePiTarget } from "@/pages/legacy-redirects";
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
				<Route path="/agent/*" element={<AgentPage />} />
				<Route path="/machines" element={<MachinesPage />} />
				{/* 静态段需先于 :tab? 声明，避免落到「未知页面」分支 */}
				<Route path="/machines/:clientId/pi" element={<MachinePiRedirect />} />
				<Route
					path="/machines/:clientId/:tab?"
					element={<MachineWorkspace />}
				/>
				<Route path="/jobs" element={<JobsPage />} />
				<Route path="/jobs/:jobId" element={<JobDetailPage />} />
				<Route path="/frp" element={<FrpPage />} />
				<Route path="/releases" element={<ReleasesPage />} />
				{/* 兼容旧入口：存储已并入设置模块 */}
				<Route
					path="/storage"
					element={<Navigate to="/settings/storage" replace />}
				/>
				{/* 兼容旧入口：Pi 独立配置页已并入 Agent 模块 */}
				<Route
					path="/pi"
					element={<Navigate to={legacyPiTarget("/pi")} replace />}
				/>
				<Route path="/pi/*" element={<PiLegacyRedirect />} />
				<Route path="/settings/*" element={<SettingsPage />} />
				<Route path="*" element={<Navigate to="/dashboard" replace />} />
			</Routes>
		</ConsoleShell>
	);
}

/** 兼容旧 `/pi/*` 入口：映射到 Agent 模块的对应二级项。 */
function PiLegacyRedirect() {
	const { pathname } = useLocation();
	return <Navigate to={legacyPiTarget(pathname)} replace />;
}

/** 兼容机器详情的旧 Pi 入口：保留机器上下文并落到 Agent 对话页。 */
function MachinePiRedirect() {
	const { clientId = "" } = useParams();
	return <Navigate to={machinePiTarget(clientId)} replace />;
}
