import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { PageHeading } from "@/components/page-heading";
import { PiProvidersPanel } from "@/pages/pi-providers-panel";
import { PiProfilesPanel } from "@/pages/pi-profiles-panel";
import { PiRuntimePanel } from "@/pages/pi-runtime-panel";

const tabs = [
	{ path: "profile", label: "Profile" },
	{ path: "provider", label: "Provider" },
	{ path: "runtime", label: "Client 运行时" },
] as const;

/** Pi 管理入口：每个功能独立 Tab，后续能力沿此入口扩展。 */
export function PiPage() {
	return (
		<div className="space-y-6">
			<PageHeading
				title="Pi"
				description="管理 Pi 模型、凭据与 Client 运行时配置。"
			/>
			<nav
				aria-label="Pi 功能"
				role="tablist"
				className="flex gap-2 border-b border-border/70 pb-3"
			>
				{tabs.map(({ path, label }) => (
					<NavLink
						key={path}
						to={`/pi/${path}`}
						role="tab"
						className={({ isActive }) =>
							`vcpdeck-nav-link ${isActive ? "active" : ""}`
						}
					>
						{label}
					</NavLink>
				))}
			</nav>
			<Routes>
				<Route path="profile" element={<PiProfilesPanel />} />
				<Route path="provider" element={<PiProvidersPanel />} />
				<Route path="credentials" element={<PiProvidersPanel />} />
				<Route path="runtime" element={<PiRuntimePanel />} />
				<Route path="*" element={<PiRedirect />} />
			</Routes>
		</div>
	);
}

function PiRedirect() {
	const location = useLocation();
	return <Navigate to={`${location.pathname.replace(/\/$/, "")}/profile`} replace />;
}
