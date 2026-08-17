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

const VERSION_RE = /^vcpdeck-(\d+\.\d+\.\d+)-(win-x64|linux-x64)\.zip$/;

interface UploadArgs {
	/** 待上传文件路径（按文件名识别平台；两个平台各一个） */
	zipPaths: string[];
	server: string;
	username?: string;
	password?: string;
}

function parseUploadArgs(argv: string[]): UploadArgs {
	const zipPaths = argv.filter((a) => !a.startsWith("--"));
	const server = argv.find((a) => a.startsWith("--server="))?.split("=")[1];
	if (zipPaths.length !== 2 || !server) {
		throw new Error(
			"用法: vcpdeck release upload <win-x64.zip> <linux-x64.zip> --server=<url> [--username=x --password=y]",
		);
	}
	return {
		zipPaths,
		server: server.replace(/\/$/, ""),
		username:
			argv.find((a) => a.startsWith("--username="))?.split("=")[1] ??
			process.env.VCPDECK_ADMIN_USERNAME,
		password:
			argv.find((a) => a.startsWith("--password="))?.split("=")[1] ??
			process.env.VCPDECK_ADMIN_PASSWORD,
	};
}

/** 从文件名解析平台（vcpdeck-<x.y.z>-<platform>.zip） */
function platformOfFile(path: string): { version: string; platform: string } {
	const name = path.split(/[\\/]/).pop() ?? "";
	const match = VERSION_RE.exec(name);
	if (!match) {
		throw new Error(
			`文件名应形如 vcpdeck-<x.y.z>-win-x64.zip / vcpdeck-<x.y.z>-linux-x64.zip: ${name}`,
		);
	}
	return { version: match[1], platform: match[2] };
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

/** 上传单个平台包；返回服务端 release 摘要（或抛错） */
async function uploadOne(
	server: string,
	cookie: string,
	zipPath: string,
): Promise<{ version: string; status: string }> {
	const { version, platform } = platformOfFile(zipPath);
	const sha256 = await sha256File(zipPath);
	const size = (await stat(zipPath)).size;
	console.log(
		`[vcpdeck] 上传 ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB, ${platform}, sha256=${sha256.slice(0, 12)}…)`,
	);
	const res = await fetch(
		`${server}/api/releases/upload?version=${encodeURIComponent(version)}&platform=${encodeURIComponent(platform)}&sha256=${encodeURIComponent(sha256)}`,
		{
			method: "POST",
			headers: {
				"content-type": "application/zip",
				cookie,
			},
			body: createReadStream(zipPath) as unknown as BodyInit,
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
	return body.release ?? { version, status: "uploaded" };
}

async function uploadRelease(args: UploadArgs): Promise<void> {
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

	// 逐个平台上传（第二个平台齐备后服务端自动开始更新）
	for (const zipPath of args.zipPaths) {
		await uploadOne(args.server, cookie, zipPath);
	}
	console.log("[vcpdeck] 上传完成（两个平台构件齐备后服务端自动开始更新）");
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
		"  vcpdeck release upload <vcpdeck-x.y.z-win-x64.zip> <vcpdeck-x.y.z-linux-x64.zip> --server=<url> [--username=x --password=y]",
	);
}

run(process.argv.slice(2));
