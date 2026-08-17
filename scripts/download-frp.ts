/**
 * 下载 frpc + frps 二进制
 *   frpc → packages/client/dist/frp/<platform>/
 *   frps → packages/server/dist/frp/<platform>/
 *
 * 用法:
 *   npx tsx scripts/download-frp.ts                    # 下载当前平台
 *   npx tsx scripts/download-frp.ts --platform=win-x64,linux-x64
 *
 * 环境变量:
 *   FRP_VERSION   — 版本号，默认 0.61.0
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const FRP_VERSION = process.env.FRP_VERSION || "0.61.0";

type PlatformEntry = {
	assetSuffix: string;
	extractDir: string;
	frpcName: string;
	frpsName: string;
};

const isWin = process.platform === "win32";

const ASSET_MAP: Record<string, PlatformEntry> = {
	"win-x64": {
		assetSuffix: `frp_${FRP_VERSION}_windows_amd64.zip`,
		extractDir: `frp_${FRP_VERSION}_windows_amd64`,
		frpcName: "frpc.exe",
		frpsName: "frps.exe",
	},
	"linux-x64": {
		assetSuffix: `frp_${FRP_VERSION}_linux_amd64.tar.gz`,
		extractDir: `frp_${FRP_VERSION}_linux_amd64`,
		frpcName: "frpc",
		frpsName: "frps",
	},
	"linux-arm64": {
		assetSuffix: `frp_${FRP_VERSION}_linux_arm64.tar.gz`,
		extractDir: `frp_${FRP_VERSION}_linux_arm64`,
		frpcName: "frpc",
		frpsName: "frps",
	},
};

const CLIENT_FRP_DIR = path.resolve(
	__dirname,
	"..",
	"packages",
	"client",
	"dist",
	"frp",
);
const SERVER_FRP_DIR = path.resolve(
	__dirname,
	"..",
	"packages",
	"server",
	"dist",
	"frp",
);
const TMP_DIR = path.resolve(__dirname, "..", ".tmp", "frp-download");

async function downloadFile(url: string, dest: string): Promise<void> {
	console.log(`  下载: ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
	const file = createWriteStream(dest);
	await pipeline(res.body as any, file);
}

async function downloadPlatform(platform: string): Promise<void> {
	const entry = ASSET_MAP[platform];
	if (!entry) {
		console.log(`  跳过未知平台: ${platform}`);
		return;
	}

	const clientDestDir = path.join(CLIENT_FRP_DIR, platform);
	const serverDestDir = path.join(SERVER_FRP_DIR, platform);
	fs.mkdirSync(clientDestDir, { recursive: true });
	fs.mkdirSync(serverDestDir, { recursive: true });
	fs.mkdirSync(TMP_DIR, { recursive: true });

	// 幂等：frpc 与 frps 均已存在则跳过（离线环境/网络受限时复用已有产物）
	const frpcExists = fs.existsSync(path.join(clientDestDir, entry.frpcName));
	const frpsExists = fs.existsSync(path.join(serverDestDir, entry.frpsName));
	if (frpcExists && frpsExists) {
		console.log(`[${platform}] frpc/frps 已存在，跳过下载`);
		return;
	}

	// 1-2. 下载归档（已缓存则复用；直连 URL 由 ASSET_MAP 确定，镜像回退同 ensure-frpc）
	const archivePath = path.join(TMP_DIR, entry.assetSuffix);
	if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) {
		const suffix = `fatedier/frp/releases/download/v${FRP_VERSION}/${entry.assetSuffix}`;
		const bases = [
			...(process.env.FRP_DOWNLOAD_BASE
				? [process.env.FRP_DOWNLOAD_BASE.replace(/\/$/, "")]
				: []),
			"https://ghfast.top/https://github.com",
			"https://ghproxy.net/https://github.com",
			"https://gh-proxy.com/https://github.com",
			"https://github.com",
		];
		let lastErr: unknown;
		for (const base of bases) {
			try {
				await downloadFile(`${base}/${suffix}`, archivePath);
				lastErr = null;
				break;
			} catch (e) {
				lastErr = e;
				console.log(`[${platform}] ${base} 不可用，尝试下一个源`);
			}
		}
		if (lastErr) {
			throw new Error(
				`所有下载源均失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
			);
		}
	} else {
		console.log(`[${platform}] 复用已缓存归档: ${archivePath}`);
	}

	// 3. 解压（argv 数组无 shell 拼接；路径转正斜杠防 GNU tar 转义/远程主机误判）
	console.log(`[${platform}] 解压...`);
	const fwd = (p: string) => p.replace(/\\/g, "/");
	try {
		if (entry.assetSuffix.endsWith(".zip")) {
			// Windows 用系统 bsdtar（与打包端一致，避免 PowerShell 命令串）
			execFileSync(
				"C:\\Windows\\System32\\tar.exe",
				["-xf", fwd(archivePath), "-C", fwd(TMP_DIR)],
				{ stdio: "inherit" },
			);
		} else {
			// Windows 用系统 bsdtar：不支持 GNU 的 --force-local，但原生处理 D:/ 路径；
			// 非 Windows 用 GNU tar，POSIX 绝对路径无冒号，同样无需 --force-local
			const tarBin = isWin ? "C:\\Windows\\System32\\tar.exe" : "tar";
			execFileSync(tarBin, ["-xzf", fwd(archivePath), "-C", fwd(TMP_DIR)], {
				stdio: "inherit",
			});
		}
	} catch (e) {
		throw new Error(
			`解压失败 ${entry.assetSuffix}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// 4. 提取 frpc 二进制 → client/dist/frp/
	const frpcSrc = path.join(TMP_DIR, entry.extractDir, entry.frpcName);
	const frpcDest = path.join(clientDestDir, entry.frpcName);
	fs.copyFileSync(frpcSrc, frpcDest);
	if (!isWin) fs.chmodSync(frpcDest, 0o755);
	console.log(`[${platform}] frpc → ${frpcDest}`);

	// 5. 提取 frps 二进制 → server/dist/frp/
	const frpsSrc = path.join(TMP_DIR, entry.extractDir, entry.frpsName);
	const frpsDest = path.join(serverDestDir, entry.frpsName);
	fs.copyFileSync(frpsSrc, frpsDest);
	if (!isWin) fs.chmodSync(frpsDest, 0o755);
	console.log(`[${platform}] frps → ${frpsDest}`);

	// 6. 无扩展名产物（linux 平台）额外存 .gz 包装副本：部分 Windows 开发机杀毒会删除
	//    裸 ELF 字节序列（连 .bin 也会），gzip 包装免疫；pack-release 在打包后用其
	//    解压内容直接追加进 zip（裸文件在磁盘只存在秒级窗口）
	if (!entry.frpcName.endsWith(".exe")) {
		fs.writeFileSync(`${frpcDest}.gz`, gzipSync(fs.readFileSync(frpcSrc)));
		fs.writeFileSync(`${frpsDest}.gz`, gzipSync(fs.readFileSync(frpsSrc)));
		console.log(`[${platform}] frpc/frps .gz 包装副本已就绪`);
	}
}

function normalizePlatform(p: string): string {
	if (p.startsWith("win32")) return p.replace("win32", "win");
	return p;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const platformArg = args.find((a) => a.startsWith("--platform="));
	const platforms = platformArg
		? platformArg.replace("--platform=", "").split(",").map(normalizePlatform)
		: [normalizePlatform(`${process.platform}-${process.arch}`)];

	console.log(`下载 frp v${FRP_VERSION} for: ${platforms.join(", ")}`);

	// 清理临时目录
	fs.rmSync(TMP_DIR, { recursive: true, force: true });

	for (const p of platforms) {
		await downloadPlatform(p);
	}

	// 清理临时目录
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
	console.log("完成 ✅");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
