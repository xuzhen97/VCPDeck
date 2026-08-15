/**
 * VCPDeck CLI（骨架 + 发版上传命令）。
 *
 * 用法:
 *   vcpdeck release upload <zip 路径> --server <url> [--username x --password y]
 *   环境变量: VCPDECK_ADMIN_USERNAME / VCPDECK_ADMIN_PASSWORD
 *
 * 流程: 登录拿会话 cookie → 计算 zip sha256 → POST /api/releases/upload
 * （鉴权与服务端全局 AuthGuard 一致；上传后服务端自动触发全量更新）
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const VERSION_RE = /^vcpdeck-(\d+\.\d+\.\d+)\.(zip|tar\.gz)$/;

interface UploadArgs {
	zipPath: string;
	server: string;
	username?: string;
	password?: string;
}

function parseUploadArgs(argv: string[]): UploadArgs {
	const zipPath = argv.find((a) => !a.startsWith("--"));
	const server = argv.find((a) => a.startsWith("--server="))?.split("=")[1];
	if (!zipPath || !server) {
		throw new Error(
			"用法: vcpdeck release upload <zip> --server=<url> [--username=x --password=y]",
		);
	}
	return {
		zipPath,
		server: server.replace(/\/$/, ""),
		username:
			argv.find((a) => a.startsWith("--username="))?.split("=")[1] ??
			process.env.VCPDECK_ADMIN_USERNAME,
		password:
			argv.find((a) => a.startsWith("--password="))?.split("=")[1] ??
			process.env.VCPDECK_ADMIN_PASSWORD,
	};
}

function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("error", reject)
			.on("data", (c) => hash.update(c))
			.on("end", () => resolve(hash.digest("hex")));
	});
}

async function uploadRelease(args: UploadArgs): Promise<void> {
	const match = VERSION_RE.exec(args.zipPath.split(/[\\/]/).pop() ?? "");
	if (!match) {
		throw new Error(
			`文件名应形如 vcpdeck-<x.y.z>.zip / .tar.gz: ${args.zipPath}`,
		);
	}
	const version = match[1];

	// 登录（拿会话 cookie）
	if (!args.username || !args.password) {
		throw new Error(
			"需要管理员凭据：--username/--password 或环境变量 VCPDECK_ADMIN_USERNAME/VCPDECK_ADMIN_PASSWORD",
		);
	}
	const loginRes = await fetch(`${args.server}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username: args.username, password: args.password }),
	});
	if (!loginRes.ok) {
		throw new Error(
			`登录失败: HTTP ${loginRes.status} ${await loginRes.text()}`,
		);
	}
	const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error("登录响应缺少会话 cookie");

	// 上传
	const sha256 = await sha256File(args.zipPath);
	const size = (await stat(args.zipPath)).size;
	console.log(
		`[vcpdeck] 上传 ${args.zipPath} (${(size / 1024 / 1024).toFixed(1)} MB, sha256=${sha256.slice(0, 12)}…)`,
	);
	const res = await fetch(
		`${args.server}/api/releases/upload?version=${encodeURIComponent(version)}&sha256=${encodeURIComponent(sha256)}`,
		{
			method: "POST",
			headers: {
				"content-type": "application/zip",
				cookie,
			},
			body: createReadStream(args.zipPath) as unknown as BodyInit,
			// 流式 body 需声明 duplex（旧版 @types/node 无此字段）
			...({ duplex: "half" } as Record<string, string>),
		},
	);
	if (!res.ok) {
		throw new Error(`上传失败: HTTP ${res.status} ${await res.text()}`);
	}
	const body = (await res.json()) as {
		release?: { version: string; status: string };
	};
	console.log(
		`[vcpdeck] 上传成功: ${body.release?.version ?? version}（服务端已自动开始更新）`,
	);
}

export function run(argv: string[]): void {
	const [cmd, sub, ...rest] = argv;
	if (cmd === "release" && sub === "upload") {
		void uploadRelease(parseUploadArgs(rest)).catch((e: Error) => {
			console.error(`[vcpdeck] ${e.message}`);
			process.exitCode = 1;
		});
		return;
	}
	console.log("vcpdeck");
	console.log("可用命令:");
	console.log(
		"  vcpdeck release upload <zip> --server=<url> [--username=x --password=y]",
	);
}

run(process.argv.slice(2));
