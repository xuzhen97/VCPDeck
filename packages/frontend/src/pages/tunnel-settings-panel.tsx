import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusChip } from "@/components/status-chip";
import type { TunnelConfigInfo } from "@vcpdeck/shared";

const toLines = (urls: string[]): string => urls.join("\n");
const fromLines = (text: string): string[] =>
	text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);

/** 网络设置面板：coturn / ICE 配置。只显示 secret 就绪状态，不采集 secret。 */
export function TunnelSettingsPanel() {
	const sdk = useSdk();
	const [stunLines, setStunLines] = useState("");
	const [turnLines, setTurnLines] = useState("");
	const [realm, setRealm] = useState("");
	const [secretConfigured, setSecretConfigured] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	function applyConfig(config: TunnelConfigInfo) {
		setStunLines(toLines(config.stunUrls));
		setTurnLines(toLines(config.turnUrls));
		setRealm(config.realm);
		setSecretConfigured(config.turnSecretConfigured);
	}

	const load = useCallback(async () => {
		try {
			applyConfig(await sdk.tunnels.config.get());
		} catch {
			setError("无法读取网络配置");
		} finally {
			setLoaded(true);
		}
	}, [sdk]);

	useEffect(() => {
		void load();
	}, [load]);

	async function save(e: FormEvent) {
		e.preventDefault();
		if (saving) return;
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			applyConfig(
				await sdk.tunnels.config.update({
					stunUrls: fromLines(stunLines),
					turnUrls: fromLines(turnLines),
					realm: realm.trim(),
				}),
			);
			setSaved(true);
		} catch {
			// 不回显 Server 错误 details，只显示稳定中文文案
			setError("保存失败，请检查输入后重试");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>网络 · coturn / ICE</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<StatusChip
						label={secretConfigured ? "TURN 密钥已配置" : "TURN 密钥未配置"}
						tone={secretConfigured ? "success" : "danger"}
					/>
					<p className="text-xs text-muted-foreground">
						共享密钥仅由服务端 VCPDECK_TURN_SECRET_FILE 提供，不在 Web 配置。
					</p>
				</div>
				<form onSubmit={save} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="stun-urls">STUN URLs（每行一个）</Label>
						<textarea
							id="stun-urls"
							data-testid="stun-urls"
							value={stunLines}
							onChange={(e) => setStunLines(e.target.value)}
							rows={2}
							placeholder="stun:turn.example.com:3478"
							className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="turn-urls">TURN URLs（每行一个）</Label>
						<textarea
							id="turn-urls"
							data-testid="turn-urls"
							value={turnLines}
							onChange={(e) => setTurnLines(e.target.value)}
							rows={2}
							placeholder="turn:turn.example.com:3478"
							className="w-full rounded-md border border-border bg-background p-2 font-mono text-sm"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="turn-realm">TURN realm</Label>
						<Input
							id="turn-realm"
							data-testid="turn-realm"
							value={realm}
							onChange={(e) => setRealm(e.target.value)}
							placeholder="turn.example.com"
						/>
					</div>
					<div className="flex items-center gap-3">
						<Button type="submit" disabled={saving || !loaded}>
							{saving ? "保存中…" : "保存配置"}
						</Button>
						{saved && <span className="text-sm text-emerald-400">已保存</span>}
						{error && (
							<span data-testid="tunnel-settings-error" className="text-sm text-destructive">
								{error}
							</span>
						)}
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
