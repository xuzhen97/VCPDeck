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
				title="映射"
				description="管理在线 Client 的公网映射与 frps 实例。"
			/>
			<nav
				aria-label="映射导航"
				className="inline-flex rounded-2xl border border-border/70 bg-card/50 p-1 shadow-sm backdrop-blur-xl"
			>
				<Button
					variant={section === "mappings" ? "secondary" : "ghost"}
					aria-current={section === "mappings" ? "page" : undefined}
					onClick={() => setSection("mappings")}
				>
					映射
				</Button>
				<Button
					variant={section === "instances" ? "secondary" : "ghost"}
					aria-current={section === "instances" ? "page" : undefined}
					onClick={() => setSection("instances")}
				>
					实例配置
				</Button>
			</nav>
			{section === "mappings" ? <FrpPanel /> : <FrpsInstancesPanel />}
		</div>
	);
}
