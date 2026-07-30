#!/usr/bin/env node
/**
 * 确保 frpc 二进制存在，不存在则自动下载。
 * 由 client 的 prebuild 钩子调用。
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FRP_VERSION = process.env.FRP_VERSION || "0.61.1";
const ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";

const PLATFORM = `${process.platform.replace("win32", "win")}-${process.arch}`;
const TARGET_DIR = path.join(ROOT, "packages", "client", "dist", "frp", PLATFORM);
const BINARY_NAME = IS_WIN ? "frpc.exe" : "frpc";
const BINARY_PATH = path.join(TARGET_DIR, BINARY_NAME);

// Already exists → skip
if (fs.existsSync(BINARY_PATH)) {
	console.log(`[ensure-frpc] frpc 已存在: ${BINARY_PATH}`);
	process.exit(0);
}

console.log(`[ensure-frpc] frpc 未找到，下载 frpc v${FRP_VERSION} (${PLATFORM})...`);

const ASSETS = {
	"win-x64":     { name: `frp_${FRP_VERSION}_windows_amd64.zip`,     extractDir: `frp_${FRP_VERSION}_windows_amd64` },
	"linux-x64":   { name: `frp_${FRP_VERSION}_linux_amd64.tar.gz`,    extractDir: `frp_${FRP_VERSION}_linux_amd64` },
	"linux-arm64": { name: `frp_${FRP_VERSION}_linux_arm64.tar.gz`,    extractDir: `frp_${FRP_VERSION}_linux_arm64` },
};

const asset = ASSETS[PLATFORM];
if (!asset) {
	console.error(`[ensure-frpc] 不支持的平台: ${PLATFORM}`);
	process.exit(1);
}

async function main() {
	const RELEASE_URL = `https://api.github.com/repos/fatedier/frp/releases/tags/v${FRP_VERSION}`;

	// 1. Get download URL
	const releaseRes = await fetch(RELEASE_URL);
	if (!releaseRes.ok) throw new Error(`GitHub API ${releaseRes.status}`);
	const release = await releaseRes.json();
	const assetData = release.assets?.find((a) => a.name === asset.name);
	if (!assetData) throw new Error(`未找到 asset: ${asset.name}`);

	// 2. Download
	fs.mkdirSync(TARGET_DIR, { recursive: true });
	const tmpDir = path.join(ROOT, ".tmp", "frp-download");
	fs.mkdirSync(tmpDir, { recursive: true });

	const archivePath = path.join(tmpDir, asset.name);
	console.log(`[ensure-frpc] 下载 ${assetData.browser_download_url}`);
	const fileRes = await fetch(assetData.browser_download_url);
	if (!fileRes.ok) throw new Error(`下载失败: ${fileRes.status}`);
	const buffer = Buffer.from(await fileRes.arrayBuffer());
	fs.writeFileSync(archivePath, buffer);

	// 3. Extract
	console.error(`[ensure-frpc] 解压...`);
	try {
		if (asset.name.endsWith(".zip")) {
			execSync(
				`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`,
				{ stdio: "inherit" },
			);
		} else {
			execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "inherit" });
		}
	} catch (e) {
		throw new Error(`解压失败: ${e.message}`);
	}

	// 4. Copy frpc binary to target
	const src = path.join(tmpDir, asset.extractDir, BINARY_NAME);
	fs.copyFileSync(src, BINARY_PATH);
	if (!IS_WIN) fs.chmodSync(BINARY_PATH, 0o755);
	console.log(`[ensure-frpc] frpc → ${BINARY_PATH}`);

	// 5. Cleanup
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(`[ensure-frpc] 失败: ${err.message}`);
	process.exit(1);
});
