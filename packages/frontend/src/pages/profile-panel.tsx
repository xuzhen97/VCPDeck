import { useState, type FormEvent } from "react";
import { useSdk } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ProfilePanel() {
	const sdk = useSdk();
	const [currentPassword, setCurrentPassword] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [message, setMessage] = useState("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		setMessage("");
		try {
			await sdk.auth.updateMe({
				currentPassword,
				...(username ? { username } : {}),
				...(password ? { password } : {}),
			});
			setCurrentPassword("");
			setPassword("");
			setMessage("个人资料已更新");
		} catch {
			setMessage("无法更新个人资料，请检查当前密码后重试");
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>个人资料</CardTitle>
			</CardHeader>
			<CardContent>
				<form className="max-w-xl space-y-4" onSubmit={submit}>
					<div className="space-y-2">
						<Label htmlFor="profile-username">新用户名（可选）</Label>
						<Input
							id="profile-username"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="profile-password">新密码（可选）</Label>
						<Input
							id="profile-password"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="current-password">当前密码</Label>
						<Input
							id="current-password"
							type="password"
							value={currentPassword}
							onChange={(event) => setCurrentPassword(event.target.value)}
							required
						/>
					</div>
					{message && (
						<p role="status" className="text-sm text-muted-foreground">
							{message}
						</p>
					)}
					<Button type="submit">保存资料</Button>
				</form>
			</CardContent>
		</Card>
	);
}
