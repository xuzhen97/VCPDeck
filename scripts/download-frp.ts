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
import { execSync } from "node:child_process";

const FRP_VERSION = process.env.FRP_VERSION || "0.61.0";
const GITHUB_API = "https://api.github.com/repos/fatedier/frp/releases";

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

	// 1. 获取 release 下载 URL
	console.log(`[${platform}] 获取 release 信息...`);
	const releaseUrl = `${GITHUB_API}/tags/v${FRP_VERSION}`;
	const releaseRes = await fetch(releaseUrl);
	if (!releaseRes.ok) {
		throw new Error(`GitHub API ${releaseRes.status}`);
	}
	const release = (await releaseRes.json()) as {
		assets: Array<{ name: string; browser_download_url: string }>;
	};
	const asset = release.assets.find((a) => a.name === entry.assetSuffix);
	if (!asset) throw new Error(`找不到 asset: ${entry.assetSuffix}`);

	// 2. 下载
	const archivePath = path.join(TMP_DIR, entry.assetSuffix);
	await downloadFile(asset.browser_download_url, archivePath);

	// 3. 解压
	console.log(`[${platform}] 解压...`);
	if (entry.assetSuffix.endsWith(".zip")) {
		execSync(
			`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${TMP_DIR}' -Force"`,
			{ stdio: "inherit" },
		);
	} else {
		execSync(`tar -xzf "${archivePath}" -C "${TMP_DIR}"`, { stdio: "inherit" });
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
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const platformArg = args.find((a) => a.startsWith("--platform="));
	const platforms = platformArg
		? platformArg.replace("--platform=", "").split(",")
		: [`${process.platform}-${process.arch}`];

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
