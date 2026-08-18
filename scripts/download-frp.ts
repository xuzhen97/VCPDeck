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

/** 从 tar.gz 直接读取单个二进制，避免 Windows 安全软件删除解压出的裸 ELF。 */
function readTarEntry(archivePath: string, entryPath: string): Buffer {
	const tarBin = isWin ? "C:\\Windows\\System32\\tar.exe" : "tar";
	return execFileSync(
		tarBin,
		["-xOf", archivePath.replace(/\\\\/g, "/"), entryPath],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
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

	// 幂等：frpc 与 frps 均已存在则跳过（离线环境/网络受限时复用已有产物）。
	// Linux 平台落盘的是 .gz 包装副本（构建机不保留裸 ELF，见下方说明），按 .gz 判断。
	const diskExt = entry.frpcName.endsWith(".exe") ? "" : ".gz";
	const frpcExists = fs.existsSync(
		path.join(clientDestDir, `${entry.frpcName}${diskExt}`),
	);
	const frpsExists = fs.existsSync(
		path.join(serverDestDir, `${entry.frpsName}${diskExt}`),
	);
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

	// 3-5. 提取 frpc/frps。Linux tar.gz 直接从归档读取，避免 Windows 安全软件
	// 删除解压出的裸 ELF；zip 仍使用系统 tar 解压。
	console.log(`[${platform}] 解压...`);
	const fwd = (p: string) => p.replace(/\\/g, "/");
	let frpcBytes: Buffer;
	let frpsBytes: Buffer;
	try {
		if (entry.assetSuffix.endsWith(".zip")) {
			// Windows 用系统 bsdtar（与打包端一致，避免 PowerShell 命令串）
			execFileSync(
				"C:\\Windows\\System32\\tar.exe",
				["-xf", fwd(archivePath), "-C", fwd(TMP_DIR)],
				{ stdio: "inherit" },
			);
			frpcBytes = fs.readFileSync(
				path.join(TMP_DIR, entry.extractDir, entry.frpcName),
			);
			frpsBytes = fs.readFileSync(
				path.join(TMP_DIR, entry.extractDir, entry.frpsName),
			);
		} else {
			const prefix = `${entry.extractDir}/`;
			frpcBytes = readTarEntry(archivePath, `${prefix}${entry.frpcName}`);
			frpsBytes = readTarEntry(archivePath, `${prefix}${entry.frpsName}`);
		}
	} catch (e) {
		throw new Error(
			`提取失败 ${entry.assetSuffix}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// 5. 落盘：Windows 写裸 .exe；Linux 只写 .gz 包装副本，不在构建机落裸 ELF。
	//    裸 ELF 会被开发机安全软件误报（HackTool/Linux.Frp）并自动删除/弹窗；打包时
	//    pack-release 从 .gz 内存解压注入 zip，Linux 目标机解压 zip 后即为可执行文件，
	//    符合“构建机不保留二进制、目标机解压即用”的 Linux 管理方式。
	if (entry.frpcName.endsWith(".exe")) {
		const frpcDest = path.join(clientDestDir, entry.frpcName);
		fs.writeFileSync(frpcDest, frpcBytes);
		if (!isWin) fs.chmodSync(frpcDest, 0o755);
		console.log(`[${platform}] frpc → ${frpcDest}`);

		const frpsDest = path.join(serverDestDir, entry.frpsName);
		fs.writeFileSync(frpsDest, frpsBytes);
		if (!isWin) fs.chmodSync(frpsDest, 0o755);
		console.log(`[${platform}] frps → ${frpsDest}`);
	} else {
		const frpcGz = path.join(clientDestDir, `${entry.frpcName}.gz`);
		fs.writeFileSync(frpcGz, gzipSync(frpcBytes));
		const frpsGz = path.join(serverDestDir, `${entry.frpsName}.gz`);
		fs.writeFileSync(frpsGz, gzipSync(frpsBytes));
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
