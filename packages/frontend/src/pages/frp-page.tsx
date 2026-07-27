import { PageHeading } from "@/components/page-heading";
import { FrpPanel } from "@/pages/frp-panel";

export function FrpPage() {
	return <div className="space-y-6"><PageHeading title="FRP" description="管理在线 Client 的公网端口映射。" /><FrpPanel /></div>;
}
