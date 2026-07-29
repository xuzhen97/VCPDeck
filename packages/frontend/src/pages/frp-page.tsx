import { useState } from "react";
import { PageHeading } from "@/components/page-heading";
import { Button } from "@/components/ui/button";
import { FrpPanel } from "./frp-panel";
import { FrpsInstancesPanel } from "./frps-instances-panel";

export function FrpPage() {
	const [section, setSection] = useState<"mappings" | "instances">("mappings");
	return (
		<div className="space-y-6">
			<PageHeading
				title="FRP"
				description="管理在线 Client 的公网映射与 frps 实例。"
			/>
			<nav
				aria-label="FRP 导航"
				className="flex gap-2 border-b border-border/70 pb-3"
			>
				<Button
					variant={section === "mappings" ? "secondary" : "ghost"}
					onClick={() => setSection("mappings")}
				>
					映射
				</Button>
				<Button
					variant={section === "instances" ? "secondary" : "ghost"}
					onClick={() => setSection("instances")}
				>
					实例配置
				</Button>
			</nav>
			{section === "mappings" ? <FrpPanel /> : <FrpsInstancesPanel />}
		</div>
	);
}
