import type {
	ClientAnnotations,
	ClientAnnotationsInput,
	ClientInfo,
} from "@vcpdeck/shared";
import { VcpDeckApiError } from "@vcpdeck/sdk";
import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AddressMode = "unknown" | "none" | "yes";

function addressMode(annotations: ClientAnnotations | undefined): AddressMode {
	if (!annotations) return "unknown";
	const publicAddress = annotations.publicAddress;
	if (publicAddress === null) return "unknown";
	const empty =
		publicAddress.v4.length === 0 &&
		publicAddress.v6.length === 0 &&
		publicAddress.host === null;
	return empty ? "none" : "yes";
}

function publicAddressText(annotations: ClientAnnotations | undefined): string {
	if (!annotations) return "未补充";
	const publicAddress = annotations.publicAddress;
	if (publicAddress === null) return "未声明";
	const values = [...publicAddress.v4, ...publicAddress.v6];
	if (publicAddress.host) values.push(publicAddress.host);
	return values.length === 0 ? "无公网地址" : values.join(" · ");
}

function linesToAddresses(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function trimOrNull(value: string): string | null {
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** 机器详情页的公网地址与操作者备注（ADR-0055）。 */
export function MachineAnnotationsPanel({ client }: { client: ClientInfo }) {
	const sdk = useSdk();
	const [annotations, setAnnotations] = useState<ClientAnnotations | undefined>(
		client.annotations,
	);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Server 是注解权威；父级 10s 轮询刷新后同步展示。
	useEffect(() => {
		setAnnotations(client.annotations);
	}, [client.annotations]);

	async function save(input: ClientAnnotationsInput) {
		setSaving(true);
		setError(null);
		try {
			const updated = await sdk.clients.updateAnnotations(
				client.clientId,
				input,
			);
			setAnnotations(updated.annotations);
			setOpen(false);
		} catch (cause) {
			setError(
				cause instanceof VcpDeckApiError && cause.status === 400
					? "注解格式不合法，请检查地址、域名和长度"
					: "保存失败，请重试",
			);
		} finally {
			setSaving(false);
		}
	}

	function startEdit() {
		setError(null);
		setOpen(true);
	}

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
				<div>
					<CardTitle>公网与注解</CardTitle>
					<p className="mt-1 text-sm text-muted-foreground">
						操作者声明，未自动验证；不要填写密码、密钥或令牌。
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={startEdit}
				>
					<Pencil className="size-4" />
					编辑
				</Button>
			</CardHeader>
			<CardContent className="space-y-3 text-sm">
				<div className="flex flex-wrap items-baseline gap-2">
					<span className="text-muted-foreground">公网地址</span>
					<span data-testid="machine-public-address">
						{publicAddressText(annotations)}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground">备注</span>
					<p className="mt-1 whitespace-pre-wrap">
						{annotations?.notes ?? "未填写"}
					</p>
				</div>
				{annotations && (
					<p className="text-xs text-muted-foreground">
						更新于{" "}
						{new Date(annotations.updatedAt).toLocaleString()} ·
						声明值不代表端口可达
					</p>
				)}
			</CardContent>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setError(null);
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-y-auto">
					<DialogTitle>编辑公网与注解</DialogTitle>
					<DialogDescription>
						这些内容由操作者维护，不会随 Client 重连被覆盖；未验证可达性。
					</DialogDescription>
					<AnnotationsForm
						initial={annotations}
						saving={saving}
						error={error}
						onCancel={() => setOpen(false)}
						onSave={(input) => void save(input)}
					/>
				</DialogContent>
			</Dialog>
		</Card>
	);
}

function AnnotationsForm({
	initial,
	saving,
	error,
	onCancel,
	onSave,
}: {
	initial: ClientAnnotations | undefined;
	saving: boolean;
	error: string | null;
	onCancel: () => void;
	onSave: (input: ClientAnnotationsInput) => void;
}) {
	const [mode, setMode] = useState<AddressMode>(() => addressMode(initial));
	const [v4, setV4] = useState(initial?.publicAddress?.v4.join("\n") ?? "");
	const [v6, setV6] = useState(initial?.publicAddress?.v6.join("\n") ?? "");
	const [host, setHost] = useState(initial?.publicAddress?.host ?? "");
	const [notes, setNotes] = useState(initial?.notes ?? "");
	const [formError, setFormError] = useState<string | null>(null);

	function submit() {
		const v4Values = linesToAddresses(v4);
		const v6Values = linesToAddresses(v6);
		const hostValue = trimOrNull(host);
		if (
			mode === "yes" &&
			v4Values.length === 0 &&
			v6Values.length === 0 &&
			hostValue === null
		) {
			setFormError(
				"请至少填写一个 IPv4、IPv6 或域名；如果确实没有公网地址，请选择“没有公网地址”。",
			);
			return;
		}
		setFormError(null);
		const publicAddress =
			mode === "unknown"
				? null
				: mode === "none"
					? { v4: [], v6: [], host: null }
					: { v4: v4Values, v6: v6Values, host: hostValue };
		onSave({ publicAddress, notes: trimOrNull(notes) });
	}

	return (
		<div className="mt-5 space-y-4">
			<div className="space-y-2">
				<Label htmlFor="annotation-address-mode">公网地址类型</Label>
				<select
					id="annotation-address-mode"
					aria-label="公网地址类型"
					className="h-11 w-full rounded-lg border border-input bg-background/60 px-3"
					value={mode}
					onChange={(event) => setMode(event.target.value as AddressMode)}
				>
					<option value="unknown">未声明</option>
					<option value="none">没有公网地址</option>
					<option value="yes">有公网地址</option>
				</select>
			</div>
			{mode === "yes" && (
				<>
					<div className="space-y-2">
						<Label htmlFor="annotation-ipv4">公网 IPv4</Label>
						<textarea
							id="annotation-ipv4"
							aria-label="公网 IPv4"
							rows={2}
							className="w-full rounded-lg border border-input bg-background/60 p-3 font-mono text-sm"
							value={v4}
							onChange={(event) => setV4(event.target.value)}
							placeholder="每行一个，例如 1.2.3.4"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="annotation-ipv6">公网 IPv6</Label>
						<textarea
							id="annotation-ipv6"
							aria-label="公网 IPv6"
							rows={2}
							className="w-full rounded-lg border border-input bg-background/60 p-3 font-mono text-sm"
							value={v6}
							onChange={(event) => setV6(event.target.value)}
							placeholder="每行一个，例如 2001:db8::1"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="annotation-host">公网域名</Label>
						<Input
							id="annotation-host"
							aria-label="公网域名"
							value={host}
							onChange={(event) => setHost(event.target.value)}
							placeholder="例如 nas.example.com"
						/>
					</div>
				</>
			)}
			<div className="space-y-2">
				<Label htmlFor="annotation-notes">备注</Label>
				<textarea
					id="annotation-notes"
					aria-label="备注"
					rows={4}
					className="w-full rounded-lg border border-input bg-background/60 p-3 text-sm"
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
					placeholder="动态 IP、NAT、端口限制、位置、维护窗口等；不要填写密码或密钥"
				/>
			</div>
			{(formError || error) && (
				<p role="alert" className="text-sm text-destructive">
					{formError ?? error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={saving}
				>
					取消
				</Button>
				<Button type="button" onClick={submit} disabled={saving}>
					{saving ? "保存中…" : "保存"}
				</Button>
			</div>
		</div>
	);
}
