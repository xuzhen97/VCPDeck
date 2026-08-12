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
const TARGET_DIR = path.join(
	ROOT,
	"packages",
	"client",
	"dist",
	"frp",
	PLATFORM,
);
const BINARY_NAME = IS_WIN ? "frpc.exe" : "frpc";
const BINARY_PATH = path.join(TARGET_DIR, BINARY_NAME);

// Already exists → skip
if (fs.existsSync(BINARY_PATH)) {
	console.log(`[ensure-frpc] frpc 已存在: ${BINARY_PATH}`);
	process.exit(0);
}

console.log(
	`[ensure-frpc] frpc 未找到，下载 frpc v${FRP_VERSION} (${PLATFORM})...`,
);

const ASSETS = {
	"win-x64": {
		name: `frp_${FRP_VERSION}_windows_amd64.zip`,
		extractDir: `frp_${FRP_VERSION}_windows_amd64`,
	},
	"linux-x64": {
		name: `frp_${FRP_VERSION}_linux_amd64.tar.gz`,
		extractDir: `frp_${FRP_VERSION}_linux_amd64`,
	},
	"linux-arm64": {
		name: `frp_${FRP_VERSION}_linux_arm64.tar.gz`,
		extractDir: `frp_${FRP_VERSION}_linux_arm64`,
	},
};

const asset = ASSETS[PLATFORM];
if (!asset) {
	console.error(`[ensure-frpc] 不支持的平台: ${PLATFORM}`);
	process.exit(1);
}

async function downloadArchive(archivePath, asset) {
	// 下载源候选列表：先环境变量覆盖，再国内反代镜像，最后官方 GitHub 兜底
	const officialBase = "https://github.com";
	const bases = [
		...(process.env.FRP_DOWNLOAD_BASE
			? [process.env.FRP_DOWNLOAD_BASE.replace(/\/$/, "")]
			: []),
		"https://ghfast.top/https://github.com",
		"https://ghproxy.net/https://github.com",
		"https://gh-proxy.com/https://github.com",
		officialBase,
	];

	let lastErr;
	for (const base of bases) {
		const url = `${base}/fatedier/frp/releases/download/v${FRP_VERSION}/${asset.name}`;
		try {
			console.log(`[ensure-frpc] 下载 ${url}`);
			const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			fs.writeFileSync(archivePath, buf);
			console.log(
				`[ensure-frpc] 下载完成 ${(buf.length / 1024 / 1024).toFixed(1)} MB`,
			);
			return;
		} catch (e) {
			lastErr = e;
			console.error(`[ensure-frpc] ${base} 不可用: ${e.message}`);
		}
	}
	throw new Error(`所有下载源均失败: ${lastErr?.message ?? "未知错误"}`);
}

async function main() {
	const tmpDir = path.join(ROOT, ".tmp", "frp-download");
	fs.mkdirSync(tmpDir, { recursive: true });

	const archivePath = path.join(tmpDir, asset.name);

	// 已下载过且非空则复用，避免重复下载
	if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) {
		await downloadArchive(archivePath, asset);
	} else {
		console.log(`[ensure-frpc] 复用已下载的 ${archivePath}`);
	}

	// 2. Extract
	console.error(`[ensure-frpc] 解压...`);
	try {
		if (asset.name.endsWith(".zip")) {
			execSync(
				`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`,
				{ stdio: "inherit" },
			);
		} else {
			execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, {
				stdio: "inherit",
			});
		}
	} catch (e) {
		throw new Error(`解压失败: ${e.message}`);
	}

	// 3. Copy frpc binary to target
	fs.mkdirSync(TARGET_DIR, { recursive: true });
	const src = path.join(tmpDir, asset.extractDir, BINARY_NAME);
	fs.copyFileSync(src, BINARY_PATH);
	if (!IS_WIN) fs.chmodSync(BINARY_PATH, 0o755);
	console.log(`[ensure-frpc] frpc → ${BINARY_PATH}`);

	// 4. Cleanup
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
	console.error(`[ensure-frpc] 失败: ${err.message}`);
	process.exit(1);
});
