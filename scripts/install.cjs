/**
 * VCPDeck 快速安装脚本：把发布 zip 安装为 Launcher 应用版本（server 或 client 构件）。
 *
 * 用法：
 *   node install.cjs --artifact=server --zip=<路径或URL> [选项]
 *
 * 本脚本与发布 zip 平级分发：拿到发布目录即可直接运行，无需仓库源码。
 *
 * 选项：
 *   --artifact=server|client   安装的构件（必填，二选一）
 *   --zip=<path|url>           发布包 vcpdeck-x.y.z-<platform>.zip；本地路径或 http(s) URL
 *   --version=x.y.z            覆盖从 zip 文件名推断的版本号
 *   --app-dir=<dir>            Launcher 应用目录（默认 server: ~/.vcpdeck/launcher；client: ~/.vcpdeck/launcher-client）
 *   --sha256=<hex>             可选：安装前校验 zip 的 sha256
 *   --db-url=<url>             server 构件时初始化数据库（prisma db push），
 *                              如 file:/var/lib/vcpdeck/server.db；也读取环境变量 DATABASE_URL
 *   --psk=<value>              显式指定 VCPDECK_PSK（缺省 TTY 交互提问 / 非 TTY 随机生成）
 *   --admin-password=<value>   server：显式指定管理员密码（同上，随机生成时只打印一次）
 *   --server-url=<value>       client：显式指定 VCPDECK_SERVER（如 http://<server>:3001）
 *   --client-id=<value>        client：可选固定机器名（VCPDECK_CLIENT_ID）
 *   --releases-dir=<dir>       server：覆盖默认 VCPDECK_RELEASES_DIR（<app-dir>/releases，
 *                              绝对路径版本目录外，避免自更新后随版本目录漂移）
 *   --port=<1-65535>          server：覆盖默认监听端口 3001（写入 VCPDECK_PORT）
 *   --no-env                   跳过启动环境文件（launcher.env）生成，保持纯安装
 *   --skip-db                  跳过数据库初始化
 *   --force                    目标版本目录已存在时覆盖
 *
 * 启动参数引导：安装完成后收集（TTY 交互 / 显式参数 / 随机生成）关键环境变量并写入
 * <app-dir>/launcher.env（非 Windows 权限 600），启动时一行加载：
 *   node --env-file=<app-dir>/launcher.env <app-dir>/dist/main.js
 *
 * 流程：获取 zip（本地或下载）→ 校验 sha256 → 解压到临时目录 → 安装构件到
 * apps/<version>/ → 设置 current 指针（Linux symlink / Windows state.json）→
 * 引导启动参数并写 launcher.env → server 时初始化数据库 → 打印启动说明。
 *
 * 说明：Launcher 随发布 zip 提供，首次安装时放入 <app-dir>/dist；已存在的 Launcher 默认保留。
 */
const { execFileSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const {
	chmodSync,
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
const {
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} = require("node:path");
const { stdin, stdout } = require("node:process");
// node:readline/promises 的导出为 { Interface, Readline, createInterface }（无 readline 键）
const { Interface: ReadlinePromises } = require("node:readline/promises");
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

/** 解析命令行参数；返回安装构件、版本、目录和启动配置。 */
function parseArgs(argv) {
	const args = { appDirExplicit: false };
	for (const raw of argv) {
		const eq = raw.indexOf("=");
		if (eq <= 0) {
			if (raw === "--no-env") {
				args.noEnv = true;
				continue;
			}
			if (raw === "--skip-db") {
				args.skipDb = true;
				continue;
			}
			if (raw === "--force") {
				args.force = true;
				continue;
			}
			fail(`未知参数: ${raw}`);
		}
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
				args.appDirExplicit = true;
				break;
			case "--sha256":
				if (!SHA256_RE.test(value)) fail("--sha256 应为 64 位十六进制");
				args.sha256 = value;
				break;
			case "--db-url":
				args.dbUrl = value;
				break;
			case "--psk":
				if (!value) fail("--psk 不能为空");
				args.psk = value;
				break;
			case "--admin-password":
				if (!value) fail("--admin-password 不能为空");
				args.adminPassword = value;
				break;
			case "--server-url":
				if (!value) fail("--server-url 不能为空");
				args.serverUrl = value;
				break;
			case "--client-id":
				args.clientId = value;
				break;
			case "--releases-dir":
				args.releasesDir = value;
				break;
			case "--port": {
				const port = Number(value);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					fail(`--port 非法: ${value}（需要 1-65535 整数）`);
				}
				args.port = port;
				break;
			}
			default:
				fail(`未知参数: ${raw}`);
		}
	}
	if (!args.artifact) fail("缺少 --artifact=server|client");
	if (!args.zip) fail("缺少 --zip=<路径或URL>");
	if (!args.appDirExplicit) {
		args.appDir = join(
			homedir(),
			".vcpdeck",
			args.artifact === "client" ? "launcher-client" : "launcher",
		);
	}
	delete args.appDirExplicit;
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
			fail(`解压失败，请确认已安装 unzip（如 apt install unzip）: ${e.message}`);
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

/** 解析 staging 内的相对路径，拒绝 zip manifest 路径穿越。 */
function resolveContainedPath(root, child, label) {
	if (typeof child !== "string" || !child || child.includes("\0")) {
		fail(`${label} 必须是非空相对路径`);
	}
	const base = resolve(root);
	const target = resolve(base, child);
	const rel = relative(base, target);
	if (isAbsolute(child) || !rel || rel === ".." || rel.startsWith(`..${sep}`)) {
		fail(`${label} 必须位于构件目录内`);
	}
	return target;
}

/** 从 zip staging 安装 Launcher；已有 Launcher 不覆盖。 */
function installLauncherFromStaging(stagingDir, appDir, manifest) {
	const launcherDir = resolveContainedPath(
		stagingDir,
		manifest.launcher.dir,
		"manifest.launcher.dir",
	);
	const launcherEntry = manifest.launcher.entry;
	const source = resolveContainedPath(
		launcherDir,
		launcherEntry,
		"manifest.launcher.entry",
	);
	if (!existsSync(source)) {
		fail(`zip 缺少 Launcher 构件: ${join(manifest.launcher.dir, launcherEntry)}`);
	}
	const target = resolveContainedPath(
		appDir,
		launcherEntry,
		"Launcher 安装路径",
	);
	mkdirSync(dirname(target), { recursive: true });
	if (existsSync(target)) {
		console.log(`[install] Launcher 已存在，保留: ${target}`);
		return target;
	}
	cpSync(source, target, { force: false, errorOnExist: true });
	console.log(`[install] Launcher 已安装到 ${target}`);
	return target;
}

/**
 * 从已解压的 staging 目录安装构件：
 *   app-dir/dist/ = Launcher（首次安装，已有文件保留）
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
		fail(`manifest.json 解析失败: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (manifest.version && manifest.version !== version) {
		console.warn(
			`[install] 警告: manifest 版本 ${manifest.version} 与指定版本 ${version} 不一致`,
		);
	}
	if (!manifest.launcher?.dir || !manifest.launcher?.entry) {
		fail("manifest 缺少 launcher.dir 或 launcher.entry，无法安装 Launcher");
	}
	const artifactDir = join(stagingDir, artifact);
	if (!existsSync(join(artifactDir, "dist"))) {
		fail(`zip 中缺少 ${artifact}/dist，构件不完整`);
	}
	const target = join(appDir, "apps", version);
	if (existsSync(target) && !force) {
		fail(`目标版本目录已存在: ${target}\n  如需覆盖请加 --force`);
	}
	installLauncherFromStaging(stagingDir, appDir, manifest);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	cpSync(join(stagingDir, "manifest.json"), join(target, "manifest.json"));
	cpSync(artifactDir, join(target, artifact), { recursive: true });
	// 版本目录内保留经 staging 验证的 Launcher 构件（systemd 自升级的受控来源）；
	// 稳定 <app-dir>/dist/main.js 独立于版本切换，不被覆盖。
	const launcherSrc = resolveContainedPath(
		stagingDir,
		manifest.launcher.dir,
		"manifest.launcher.dir",
	);
	cpSync(launcherSrc, join(target, manifest.launcher.dir), { recursive: true });

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

/** 生成强随机密钥（32 字节，64 位 hex） */
function generateSecret() {
	return randomBytes(32).toString("hex");
}

/** launcher.env 是否应生成（未 --no-env 时安装即生成） */
function shouldWriteEnv({ artifact, noEnv }) {
	return Boolean(artifact) && !noEnv;
}

/**
 * 组装 launcher.env 文本（dotenv 兼容 KEY=value；敏感值仅落盘、提示妥善保管）。
 * client 未提供 serverUrl 时跳过该行，由调用方提示。
 */
function buildEnvFile({
	artifact,
	appDir,
	psk,
	adminPassword,
	dbUrl,
	serverUrl,
	clientId,
	releasesDir,
	port,
}) {
	const lines = [
		"# 由 scripts/install.cjs 生成（敏感值请妥善保管）",
		`VCPDECK_APP_DIR=${appDir}`,
		`VCPDECK_ARTIFACT=${artifact}`,
	];
	if (psk) lines.push(`VCPDECK_PSK=${psk}`);
	if (port) lines.push(`VCPDECK_PORT=${port}`);
	if (artifact === "server") {
		if (adminPassword) lines.push(`VCPDECK_ADMIN_PASSWORD=${adminPassword}`);
		if (dbUrl) lines.push(`DATABASE_URL=${dbUrl}`);
		// 必须在版本目录之外：Launcher 按版本目录启动 server，相对路径会随自更新漂移
		if (releasesDir) lines.push(`VCPDECK_RELEASES_DIR=${releasesDir}`);
	} else {
		if (serverUrl) lines.push(`VCPDECK_SERVER=${serverUrl}`);
		if (clientId) lines.push(`VCPDECK_CLIENT_ID=${clientId}`);
	}
	return `${lines.join("\n")}\n`;
}

/** 写 launcher.env 到 app-dir（非 Windows chmod 600） */
function writeEnvFile(appDir, content) {
	const envPath = join(appDir, "launcher.env");
	mkdirSync(appDir, { recursive: true });
	writeFileSync(envPath, content);
	if (!isWin) chmodSync(envPath, 0o600);
	return envPath;
}

/**
 * 收集启动参数：TTY 交互提问（回车用默认/随机）；非 TTY 用显式参数，缺省随机或默认。
 * client 非 TTY 未给 --server-url 时返回空字符串，由调用方提示补写。
 */
async function collectEnvArgs(args, io = { input: stdin, output: stdout }) {
	if (!io.input.isTTY) {
		return args.artifact === "server"
			? {
					psk: args.psk ?? generateSecret(),
					adminPassword: args.adminPassword ?? generateSecret(),
					dbUrl: args.dbUrl ?? `file:${join(args.appDir, "server.db")}`,
					releasesDir: args.releasesDir ?? join(args.appDir, "releases"),
					port: args.port,
				}
			: {
					psk: args.psk ?? generateSecret(),
					serverUrl: args.serverUrl ?? "",
				};
	}
	const rl = new ReadlinePromises({ input: io.input, output: io.output });
	const ask = (prompt, fallback) =>
		rl.question(`[install] ${prompt} `).then((a) => a.trim() || fallback);
	try {
		if (args.artifact === "server") {
			const psk =
				args.psk ?? (await ask("VCPDECK_PSK（回车生成随机）:", generateSecret()));
			const adminPassword =
				args.adminPassword ??
				(await ask(
					"VCPDECK_ADMIN_PASSWORD（回车生成随机，仅打印一次）:",
					generateSecret(),
				));
			const dbUrl =
				args.dbUrl ??
				(await ask(
					`DATABASE_URL（回车默认 file:<appDir>/server.db）:`,
					`file:${join(args.appDir, "server.db")}`,
				));
			return {
				psk,
				adminPassword,
				dbUrl,
				releasesDir: args.releasesDir ?? join(args.appDir, "releases"),
				port: args.port,
			};
		}
		const psk =
			args.psk ?? (await ask("VCPDECK_PSK（回车生成随机）:", generateSecret()));
		const serverUrl =
			args.serverUrl ??
			(await ask("VCPDECK_SERVER（如 http://<server>:3001）:", ""));
		return { psk, serverUrl };
	} finally {
		rl.close();
	}
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

/** 打印下一步启动说明；Launcher 路径由 app-dir 固定推导。 */
function printStartGuide(artifact, appDir, version, envFilePath) {
	const launcherMain = join(appDir, "dist", "main.js");
	console.log("");
	console.log("══════════════════════════════════════════════════");
	console.log(`安装完成: ${artifact} ${version}`);
	console.log(`  版本目录: ${join(appDir, "apps", version)}`);
	console.log(
		`  current 指针: ${isWin ? join(appDir, "apps", "state.json") : join(appDir, "apps", "current")}`,
	);
	console.log("");
	if (envFilePath) {
		console.log("启动（生产建议，经 Launcher 守护；参数已就绪于 env 文件）:");
		console.log(`  node --env-file="${envFilePath}" "${launcherMain}"`);
		console.log("");
		console.log("快速验证（无 Launcher）:");
		console.log(`  node --env-file=${envFilePath} \\`);
		console.log(
			`    "${join(appDir, "apps", version, artifact, "dist", artifact === "server" ? "main.js" : "index.js")}"`,
		);
		console.log("");
		console.log("手铺环境变量备选（env 文件之外）:");
	} else {
		console.log("启动方式一（生产建议，经 Launcher 守护）:");
	}
	const appDirEnv = `VCPDECK_APP_DIR="${appDir}"`;
	const artifactEnv = `VCPDECK_ARTIFACT="${artifact}"`;
	if (artifact === "server") {
		console.log(`  ${appDirEnv} ${artifactEnv} VCPDECK_PSK="<密钥>" \\
    VCPDECK_ADMIN_PASSWORD="<密码>" VCPDECK_COOKIE_SECURE="false" \\
    DATABASE_URL="file:..." VCPDECK_RELEASES_DIR="..." \\
    node "${launcherMain}"`);
	} else {
		console.log(`  ${appDirEnv} ${artifactEnv} VCPDECK_SERVER="http://<server>:3001" \\
    VCPDECK_PSK="<与Server一致的密钥>" \\
    node "${launcherMain}"`);
	}
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
			zipPath = await fetchZip(args.zip, join(tmpDir, `vcpdeck-${version}.zip`));
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

		// 3.5 引导启动参数（TTY 交互 / 显式参数 / 随机生成）
		const envArgs = shouldWriteEnv(args) ? await collectEnvArgs(args) : null;
		let envFilePath = null;
		if (envArgs) {
			envFilePath = writeEnvFile(
				args.appDir,
				buildEnvFile({
					artifact: args.artifact,
					appDir: args.appDir,
					clientId: args.clientId,
					...envArgs,
				}),
			);
			console.log(`[install] 启动环境文件: ${envFilePath}（敏感值请妥善保管）`);
			if (args.artifact === "client" && !envArgs.serverUrl) {
				console.warn(
					"[install] 未提供 VCPDECK_SERVER（--server-url），请手动补写 launcher.env 后再启动",
				);
			}
		}

		// 4. server 时初始化数据库（使用引导确定的 DATABASE_URL）
		const dbUrl =
			args.artifact === "server" ? (envArgs?.dbUrl ?? args.dbUrl) : undefined;
		if (shouldInitDb(args.artifact, dbUrl, args.skipDb)) {
			initDatabase(versionDir, dbUrl);
		} else if (args.artifact === "server" && !args.skipDb) {
			console.warn(
				"[install] 未提供 --db-url 或环境变量 DATABASE_URL，跳过数据库初始化；首次启动前请手动执行 prisma db push",
			);
		}

		printStartGuide(args.artifact, args.appDir, version, envFilePath);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 供测试导入；直接运行时不带参数给出用法提示
if (require.main === module) {
	if (process.argv.length <= 2) {
		console.log(
			"用法: node install.cjs --artifact=server|client --zip=<路径或URL> [--version=x.y.z] [--app-dir=<dir>] [--sha256=<hex>] [--db-url=<url>] [--psk=..] [--admin-password=..] [--server-url=..] [--client-id=..] [--releases-dir=..] [--port=1-65535] [--skip-db] [--force]",
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
	generateSecret,
	shouldWriteEnv,
	buildEnvFile,
	writeEnvFile,
	collectEnvArgs,
	printStartGuide,
};
