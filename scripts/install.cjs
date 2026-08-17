/**
 * VCPDeck 快速安装脚本：把发布 zip 安装为 Launcher 应用版本（server 或 client 构件）。
 *
 * 用法：
 *   node scripts/install.cjs --artifact=server --zip=<路径或URL> [选项]
 *
 * 选项：
 *   --artifact=server|client   安装的构件（必填，二选一）
 *   --zip=<path|url>           发布包 vcpdeck-x.y.z-<platform>.zip；本地路径或 http(s) URL
 *   --version=x.y.z            覆盖从 zip 文件名推断的版本号
 *   --app-dir=<dir>            Launcher 应用目录（默认 ~/.vcpdeck/launcher）
 *   --sha256=<hex>             可选：安装前校验 zip 的 sha256
 *   --db-url=<url>             server 构件时初始化数据库（prisma db push），
 *                              如 file:/var/lib/vcpdeck/server.db；也读取环境变量 DATABASE_URL
 *   --skip-db                  跳过数据库初始化
 *   --force                    目标版本目录已存在时覆盖
 *
 * 流程：获取 zip（本地或下载）→ 校验 sha256 → 解压到临时目录 → 安装构件到
 * apps/<version>/ → 设置 current 指针（Linux symlink / Windows state.json）→
 * server 时初始化数据库 → 打印启动说明。
 *
 * 说明：本脚本只安装应用构件；Launcher 本身与系统服务仍需按 deployment.md 单独准备。
 */
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
	createWriteStream,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = require("node:fs");
const { homedir, platform, tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pipeline } = require("node:stream/promises");

const isWin = platform() === "win32";
const ZIP_NAME_RE = /^vcpdeck-(\d+\.\d+\.\d+)-(win-x64|linux-x64)\.zip$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
	throw new Error(message);
}

/** 从 zip 文件名推断版本号（vcpdeck-<x.y.z>-<platform>.zip） */
function inferVersionFromZip(zipPath) {
	const name = zipPath.split(/[\\/]/).pop() ?? "";
	const match = ZIP_NAME_RE.exec(name);
	return match ? match[1] : null;
}

/** 解析命令行参数；返回 { artifact, zip, version, appDir, sha256, dbUrl, skipDb, force } */
function parseArgs(argv) {
	const args = { appDir: join(homedir(), ".vcpdeck", "launcher") };
	for (const raw of argv) {
		const eq = raw.indexOf("=");
		if (eq <= 0) continue;
		const key = raw.slice(0, eq);
		const value = raw.slice(eq + 1);
		switch (key) {
			case "--artifact":
				if (value !== "server" && value !== "client") {
					fail("--artifact 必须为 server 或 client");
				}
				args.artifact = value;
				break;
			case "--zip":
				args.zip = value;
				break;
			case "--version":
				if (!VERSION_RE.test(value)) fail("--version 格式应为 x.y.z");
				args.version = value;
				break;
			case "--app-dir":
				args.appDir = resolve(value);
				break;
			case "--sha256":
				if (!SHA256_RE.test(value)) fail("--sha256 应为 64 位十六进制");
				args.sha256 = value;
				break;
			case "--db-url":
				args.dbUrl = value;
				break;
			case "--skip-db":
				args.skipDb = true;
				break;
			case "--force":
				args.force = true;
				break;
			default:
				fail(`未知参数: ${raw}`);
		}
	}
	if (!args.artifact) fail("缺少 --artifact=server|client");
	if (!args.zip) fail("缺少 --zip=<路径或URL>");
	return args;
}

/** 计算文件 sha256（流式） */
function sha256File(filePath) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const fs = require("node:fs");
		const stream = fs.createReadStream(filePath);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

/** 下载 zip 到本地临时文件（http/https 才允许；返回最终本地路径） */
async function fetchZip(zipSpec, destPath) {
	let url;
	try {
		url = new URL(zipSpec);
	} catch {
		fail(`--zip 不是合法 URL: ${zipSpec}`);
		return destPath;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		fail("--zip URL 仅支持 http/https，本地文件请直接给路径");
	}
	console.log(`[install] 下载 ${zipSpec}`);
	const res = await fetch(url);
	if (!res.ok || !res.body) {
		fail(`下载失败: HTTP ${res.status} ${res.statusText}`);
	}
	const total = Number(res.headers.get("content-length") ?? 0);
	let received = 0;
	const out = createWriteStream(destPath);
	await pipeline(
		res.body,
		async function* (source) {
			for await (const chunk of source) {
				received += chunk.length;
				if (total > 0) {
					const pct = Math.round((received / total) * 100);
					process.stdout.write(`\r[install] 下载中 ${pct}%`);
				}
				yield chunk;
			}
		},
		out,
	);
	if (total > 0) process.stdout.write("\n");
	console.log(`[install] 下载完成: ${destPath}`);
	return destPath;
}

/** 解压 zip 到目标目录（复用系统工具：Windows bsdtar / Linux/macOS unzip） */
function extractZip(zipPath, destDir) {
	mkdirSync(destDir, { recursive: true });
	try {
		if (isWin) {
			execFileSync(
				"C:\\Windows\\System32\\tar.exe",
				["-xf", zipPath, "-C", destDir],
				{
					stdio: "inherit",
				},
			);
		} else {
			execFileSync("unzip", ["-o", zipPath, "-d", destDir], {
				stdio: "inherit",
			});
		}
	} catch (e) {
		if (isWin) {
			fail(`解压失败（系统 bsdtar）: ${e.message}`);
		} else {
			fail(
				`解压失败，请确认已安装 unzip（如 apt install unzip）: ${e.message}`,
			);
		}
	}
}

/** 设置 current 指针：Linux 用 symlink（需 apps 目录存在），Windows 用 state.json */
function setCurrentPointer(appDir, version) {
	const appsDir = join(appDir, "apps");
	mkdirSync(appsDir, { recursive: true });
	if (isWin) {
		writeFileSync(
			join(appsDir, "state.json"),
			JSON.stringify({ current: version }, null, 2),
		);
	} else {
		const link = join(appsDir, "current");
		if (existsSync(link)) rmSync(link, { force: true });
		symlinkSync(version, link);
	}
}

/**
 * 从已解压的 staging 目录安装构件：
 *   apps/<version>/ = manifest.json + 构件目录（server/ 或 client/）
 * 返回版本目录路径。
 */
function installFromStaging(stagingDir, { artifact, version, appDir, force }) {
	const manifestPath = join(stagingDir, "manifest.json");
	if (!existsSync(manifestPath))
		fail("zip 缺少 manifest.json，不是有效的发布包");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch (e) {
		fail(
			`manifest.json 解析失败: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (manifest.version && manifest.version !== version) {
		console.warn(
			`[install] 警告: manifest 版本 ${manifest.version} 与指定版本 ${version} 不一致`,
		);
	}
	const artifactDir = join(stagingDir, artifact);
	if (!existsSync(join(artifactDir, "dist"))) {
		fail(`zip 中缺少 ${artifact}/dist，构件不完整`);
	}
	const target = join(appDir, "apps", version);
	if (existsSync(target) && !force) {
		fail(`目标版本目录已存在: ${target}\n  如需覆盖请加 --force`);
	}
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	cpSync(join(stagingDir, "manifest.json"), join(target, "manifest.json"));
	cpSync(artifactDir, join(target, artifact), { recursive: true });

	// Linux 兜底：frpc/frps 若 zip 未携带可执行位则补齐
	if (!isWin) {
		const frpDir = join(target, artifact, "dist", "frp");
		for (const name of ["frpc", "frps", "frpc.bin", "frps.bin"]) {
			const bin = join(frpDir, "linux-x64", name);
			if (existsSync(bin)) execFileSync("chmod", ["+x", bin]);
		}
	}
	setCurrentPointer(appDir, version);
	return target;
}

/** server 构件是否应执行数据库初始化（--skip-db 或未提供 db-url 且无 DATABASE_URL 时不跑） */
function shouldInitDb(artifact, dbUrl, skipDb, env = process.env) {
	if (artifact !== "server" || skipDb) return false;
	return Boolean(dbUrl || env.DATABASE_URL);
}

/** 初始化数据库：在版本目录内执行 prisma db push（使用 DATABASE_URL） */
function initDatabase(versionDir, dbUrl, env = process.env) {
	const serverDir = join(versionDir, "server");
	console.log("[install] 初始化数据库（prisma db push）...");
	try {
		execFileSync("node", ["node_modules/prisma/build/index.js", "db", "push"], {
			cwd: serverDir,
			stdio: "inherit",
			env: { ...env, DATABASE_URL: dbUrl || env.DATABASE_URL },
		});
	} catch (e) {
		fail(`数据库初始化失败: ${e.message}`);
	}
}

/** 打印下一步启动说明 */
function printStartGuide(artifact, appDir, version) {
	const appDirEnv = `VCPDECK_APP_DIR="${appDir}"`;
	const artifactEnv = `VCPDECK_ARTIFACT="${artifact}"`;
	console.log("");
	console.log("══════════════════════════════════════════════════");
	console.log(`安装完成: ${artifact} ${version}`);
	console.log(`  版本目录: ${join(appDir, "apps", version)}`);
	console.log(
		`  current 指针: ${isWin ? join(appDir, "apps", "state.json") : join(appDir, "apps", "current")}`,
	);
	console.log("");
	console.log("启动方式一（生产建议，经 Launcher 守护）:");
	if (artifact === "server") {
		console.log(`  ${appDirEnv} ${artifactEnv} VCPDECK_PSK="<密钥>" \\
    VCPDECK_ADMIN_PASSWORD="<密码>" VCPDECK_COOKIE_SECURE="false" \\
    DATABASE_URL="file:..." VCPDECK_RELEASES_DIR="..." \\
    node <launcher路径>/dist/main.js`);
	} else {
		console.log(`  ${appDirEnv} ${artifactEnv} VCPDECK_SERVER="http://<server>:3001" \\
    VCPDECK_PSK="<与Server一致的密钥>" \\
    node <launcher路径>/dist/main.js`);
	}
	console.log("");
	console.log("启动方式二（快速验证，无 Launcher）:");
	console.log(`  ${artifact === "server" ? "DATABASE_URL=... VCPDECK_PSK=... VCPDECK_ADMIN_PASSWORD=..." : `VCPDECK_SERVER=... VCPDECK_PSK=...`} \\
    node "${join(appDir, "apps", version, artifact, "dist", artifact === "server" ? "main.js" : "index.js")}"`);
	console.log("══════════════════════════════════════════════════");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const version = args.version ?? inferVersionFromZip(args.zip);
	if (!version) {
		fail("无法从 zip 文件名推断版本，请显式 --version=x.y.z");
	}

	// 1. 获取 zip（本地或下载）
	let zipPath = args.zip;
	const tmpDir = join(tmpdir(), `vcpdeck-install-${process.pid}`);
	mkdirSync(tmpDir, { recursive: true });
	try {
		if (/^https?:\/\//i.test(args.zip)) {
			zipPath = await fetchZip(
				args.zip,
				join(tmpDir, `vcpdeck-${version}.zip`),
			);
		} else {
			zipPath = resolve(args.zip);
			if (!existsSync(zipPath)) fail(`zip 文件不存在: ${zipPath}`);
		}

		// 2. 校验 sha256
		const actualSha = await sha256File(zipPath);
		if (args.sha256) {
			if (actualSha !== args.sha256.toLowerCase()) {
				fail("zip sha256 与声明不符，拒绝安装（文件可能被篡改或下载不完整）");
			}
			console.log("[install] sha256 校验通过");
		} else {
			console.log(`[install] zip sha256: ${actualSha}（可用 --sha256 校验）`);
		}

		// 3. 解压 + 安装
		const stagingDir = join(tmpDir, "staging");
		console.log(`[install] 解压 ${zipPath}`);
		extractZip(zipPath, stagingDir);
		const versionDir = installFromStaging(stagingDir, {
			artifact: args.artifact,
			version,
			appDir: args.appDir,
			force: args.force,
		});
		console.log(`[install] ${args.artifact} ${version} 已安装到 ${versionDir}`);

		// 4. server 时初始化数据库
		if (shouldInitDb(args.artifact, args.dbUrl, args.skipDb)) {
			initDatabase(versionDir, args.dbUrl);
		} else if (args.artifact === "server" && !args.skipDb) {
			console.warn(
				"[install] 未提供 --db-url 或环境变量 DATABASE_URL，跳过数据库初始化；首次启动前请手动执行 prisma db push",
			);
		}

		printStartGuide(args.artifact, args.appDir, version);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 供测试导入；直接运行时不带参数给出用法提示
if (require.main === module) {
	if (process.argv.length <= 2) {
		console.log(
			"用法: node scripts/install.cjs --artifact=server|client --zip=<路径或URL> [--version=x.y.z] [--app-dir=<dir>] [--sha256=<hex>] [--db-url=<url>] [--skip-db] [--force]",
		);
		process.exit(1);
	}
	void main().catch((e) => {
		console.error(
			`[install] 失败: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	});
}

module.exports = {
	parseArgs,
	inferVersionFromZip,
	sha256File,
	setCurrentPointer,
	installFromStaging,
	shouldInitDb,
};
