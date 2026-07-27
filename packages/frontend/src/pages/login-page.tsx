import { Boxes, Moon, Sun } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/auth-context";
import { applyTheme, readTheme, type Theme } from "@/app/theme";

export function LoginPage() {
	const { login } = useAuth();
	const navigate = useNavigate();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	const [theme, setTheme] = useState<Theme>(readTheme);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setSubmitting(true);
		setError("");
		try {
			await login({ username, password });
			navigate("/dashboard", { replace: true });
		} catch {
			setError("登录失败，请检查用户名和密码");
		} finally {
			setSubmitting(false);
		}
	}

	function toggleTheme() {
		const next = theme === "dark" ? "light" : "dark";
		setTheme(next);
		applyTheme(next);
	}

	return (
		<div className="vcpdeck-background grid min-h-dvh lg:grid-cols-[1.1fr_.9fr]">
			<section className="hidden items-end p-12 lg:flex">
				<div className="max-w-xl">
					<div className="mb-6 flex items-center gap-3 text-primary">
						<Boxes className="size-9" />
						<span className="text-xl font-semibold">VCPDeck</span>
					</div>
					<h1 className="text-5xl font-semibold leading-tight">
						连接机器，执行任务，保持全局清晰。
					</h1>
					<p className="mt-5 text-lg text-muted-foreground">
						个人 AI 协作驾驶台，为远程操作提供单一、可信的工作上下文。
					</p>
				</div>
			</section>
			<section className="flex items-center justify-center p-5">
				<Button
					className="absolute right-5 top-5"
					size="icon"
					variant="ghost"
					onClick={toggleTheme}
					aria-label="切换主题"
				>
					{theme === "dark" ? <Sun /> : <Moon />}
				</Button>
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>登录 VCPDeck</CardTitle>
						<CardDescription>使用你的 Web 身份继续</CardDescription>
					</CardHeader>
					<CardContent>
						<form className="space-y-5" onSubmit={handleSubmit}>
							{error && (
								<p role="alert" className="text-sm text-red-400">
									{error}
								</p>
							)}
							<div className="space-y-2">
								<Label htmlFor="username">用户名</Label>
								<Input
									id="username"
									value={username}
									onChange={(event) => setUsername(event.target.value)}
									autoComplete="username"
									required
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="password">密码</Label>
								<Input
									id="password"
									type="password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									autoComplete="current-password"
									required
								/>
							</div>
							<Button className="w-full" type="submit" disabled={submitting}>
								{submitting ? "正在登录…" : "登录"}
							</Button>
						</form>
					</CardContent>
				</Card>
			</section>
		</div>
	);
}
