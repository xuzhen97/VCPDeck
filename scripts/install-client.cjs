#!/usr/bin/env node
/** VCPDeck Client 一键安装统一编排器；由平台 bootstrap 准备 Node.js 后调用。 */
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { homedir, hostname, platform, userInfo } = require("node:os");
const { basename, delimiter, dirname, join, resolve } = require("node:path");
const { stdin, stdout } = require("node:process");
const { createInterface } = require("node:readline/promises");

const PM2_NAME = "vcpdeck-client-launcher";
const INSTALL_STATE_VERSION = 1;

function parseUrl(value, label, base) {
	try {
		return base ? new URL(value, base) : new URL(value);
	} catch {
		throw new Error(`${label} 不是有效 URL`);
	}
}

function parseArgs(argv) {
	const result = {};
	for (const raw of argv) {
		const index = raw.indexOf("=");
		if (!raw.startsWith("--") || index < 3) continue;
		result[raw.slice(2, index)] = raw.slice(index + 1);
	}
	if (!/^https?:\/\/[^/]+/i.test(result["server-origin"] || "")) {
		throw new Error("--server-origin 必须是带主机名的 HTTP/HTTPS Origin");
	}
	if (result.platform !== "win-x64" && result.platform !== "linux-x64") {
		throw new Error("--platform 必须为 win-x64 或 linux-x64");
	}
	if (!result.node || !existsSync(result.node)) throw new Error("--node 不可用");
	return {
		serverOrigin: parseUrl(result["server-origin"], "--server-origin").origin,
		platform: result.platform,
		nodePath: resolve(result.node),
	};
}

function readEnv(path) {
	if (!existsSync(path)) return {};
	const result = {};
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (!line || line.trimStart().startsWith("#")) continue;
		const index = line.indexOf("=");
		if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
	}
	return result;
}

function normalizeOrigin(value) {
	if (!value) return null;
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function fetchJson(url, options = {}) {
	const response = await fetch(url, {
		...options,
		signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		throw new Error(
			body.message || body.code || `${url} HTTP ${response.status}`,
		);
	}
	return body;
}

async function download(url, target, expectedSha) {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(600_000),
	});
	if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(temp, bytes);
	if (expectedSha && sha256(temp) !== expectedSha.toLowerCase()) {
		rmSync(temp, { force: true });
		throw new Error("下载文件 SHA-256 与 Server 声明不符");
	}
	rmSync(target, { force: true });
	require("node:fs").renameSync(temp, target);
	return target;
}

async function askConfiguration(defaultName, defaultDir) {
	if (!stdin.isTTY)
		return { name: defaultName, appDir: defaultDir, confirmed: true };
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const name =
			(await rl.question(`[vcpdeck] Client 显示名称 [${defaultName}]: `)).trim() ||
			defaultName;
		const rawDir =
			(await rl.question(`[vcpdeck] 安装目录 [${defaultDir}]: `)).trim() ||
			defaultDir;
		const appDir = resolve(rawDir.replace(/^~(?=$|[\\/])/, homedir()));
		console.log("\n[vcpdeck] 安装摘要");
		console.log(`  显示名称: ${name}`);
		console.log(`  安装目录: ${appDir}`);
		const answer = (await rl.question("  确认安装？[Y/n]: "))
			.trim()
			.toLowerCase();
		return {
			name,
			appDir,
			confirmed: answer === "" || answer === "y" || answer === "yes",
		};
	} finally {
		rl.close();
	}
}

function ensureClientId() {
	const path = join(homedir(), ".vcpdeck", "client-id");
	mkdirSync(dirname(path), { recursive: true });
	let id = "";
	if (existsSync(path)) id = readFileSync(path, "utf8").trim();
	if (!id) {
		id = randomUUID();
		writeFileSync(path, id, { mode: 0o600 });
	}
	return id;
}

function writeLauncherEnv(appDir, serverOrigin, psk, clientId) {
	const path = join(appDir, "launcher.env");
	const content = [
		"# 由 VCPDeck Client 一键安装器生成（敏感值请妥善保管）",
		`VCPDECK_APP_DIR=${appDir}`,
		"VCPDECK_ARTIFACT=client",
		`VCPDECK_SERVER=${serverOrigin}`,
		`VCPDECK_PSK=${psk}`,
		`VCPDECK_CLIENT_ID=${clientId}`,
		"",
	].join("\n");
	mkdirSync(appDir, { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, { mode: 0o600 });
	if (platform() !== "win32") chmodSync(temp, 0o600);
	rmSync(path, { force: true });
	require("node:fs").renameSync(temp, path);
	return path;
}

// Windows 上禁止无 shell 直接 spawn .cmd/.bat（Node 18.20+ 返回 EINVAL），
// 因此优先返回 npm-cli.js，由调用方用 nodePath 执行。
function npmPath(nodePath) {
	const candidates =
		platform() === "win32"
			? [
					join(dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
					join(dirname(nodePath), "npm.cmd"),
				]
			: [
					join(dirname(nodePath), "npm"),
					join(
						dirname(nodePath),
						"..",
						"lib",
						"node_modules",
						"npm",
						"bin",
						"npm-cli.js",
					),
				];
	return candidates.find(existsSync) || "npm";
}

function findCommand(name) {
	const probe = spawnSync(
		platform() === "win32" ? "where.exe" : "which",
		[name],
		{ encoding: "utf8" },
	);
	return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

/** 尝试多个 registry 安装 PM2；瞬时失败重试一次，并保留最近一次真实错误用于诊断。 */
function installPm2Retry(registries, install, log = console.log) {
	let lastError = "";
	for (const registry of registries) {
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			log(
				`[vcpdeck] 尝试 PM2 registry: ${registry}${attempt > 1 ? `（第 ${attempt} 次）` : ""}`,
			);
			const result = install(registry);
			if (result.ok) return { ok: true };
			if (result.stderr?.trim()) lastError = result.stderr.trim();
		}
	}
	return { ok: false, lastError };
}

/** 把全局 pm2.cmd 解析为可用 node 执行的 pm2 入口；解析失败返回 null。 */
function resolveGlobalPm2(existing, nodePath) {
	if (!existing || !/\.cmd$/i.test(existing)) {
		return existing ? { command: existing, argsPrefix: [] } : null;
	}
	// pm2 包的真实入口是 bin/pm2（带 shebang 的 JS，可由 node 直接执行）
	const cli = join(dirname(existing), "node_modules", "pm2", "bin", "pm2");
	// Windows 上无 shell 直接执行 .cmd 会 EINVAL；解析不到入口时返回 null，
	// 由调用方回退到私有安装。
	return existsSync(cli) ? { command: nodePath, argsPrefix: [cli] } : null;
}

/** 确保 npm 与其子进程可通过 env 找到安装器选定的私有 Node.js。 */
function buildNodeRuntimeEnv(nodePath, baseEnv = process.env) {
	const pathKey =
		Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") || "PATH";
	const currentPath = baseEnv[pathKey] || "";
	return {
		...baseEnv,
		[pathKey]: [dirname(nodePath), currentPath].filter(Boolean).join(delimiter),
	};
}

function ensurePm2(nodePath, registries) {
	const existing = resolveGlobalPm2(
		findCommand(platform() === "win32" ? "pm2.cmd" : "pm2"),
		nodePath,
	);
	if (existing) return existing;
	const toolRoot = join(homedir(), ".vcpdeck", "tools", "pm2");
	const cli = join(toolRoot, "node_modules", "pm2", "bin", "pm2");
	if (!existsSync(cli)) {
		mkdirSync(toolRoot, { recursive: true });
		writeFileSync(
			join(toolRoot, "package.json"),
			JSON.stringify({ private: true }, null, 2),
		);
		const npm = npmPath(nodePath);
		const command = npm.endsWith(".js") ? nodePath : npm;
		const prefix = npm.endsWith(".js") ? [npm] : [];
		const result = installPm2Retry(registries, (registry) => {
			const out = spawnSync(
				command,
				[
					...prefix,
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					`--registry=${registry}`,
					"pm2@7.0.3",
				],
				{
					cwd: toolRoot,
					encoding: "utf8",
					env: buildNodeRuntimeEnv(nodePath),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const ok = out.status === 0 && existsSync(cli);
			if (ok && out.stdout) console.log(out.stdout.trimEnd());
			// 失败时保留真实输出与启动错误，便于区分网络、npm 配置和无法启动问题
			return {
				ok,
				stderr: ok
					? ""
					: `${out.error?.message || ""}${out.stdout || ""}${out.stderr || ""}`,
			};
		});
		if (!result.ok) {
			const detail = result.lastError
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(-3)
				.join(" | ");
			throw new Error(
				`国内与官方 registry 均无法安装 PM2${detail ? `；最近错误: ${detail}` : ""}`,
			);
		}
	}
	return { command: nodePath, argsPrefix: [cli] };
}

function runPm2(pm2, args, options = {}) {
	const result = spawnSync(pm2.command, [...pm2.argsPrefix, ...args], {
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		...options,
	});
	if (result.status !== 0)
		throw new Error(
			`PM2 ${args[0]} 失败${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
		);
	return result.stdout || "";
}

function writeEcosystem(appDir, nodePath, envPath) {
	const envLoaderPath = join(appDir, "launcher-env.cjs");
	const envLoader = `// 由 VCPDeck Client 一键安装器生成；launcher.env 是配置权威。\nfor (const key of Object.keys(process.env)) {\n  if (key.startsWith("VCPDECK_")) delete process.env[key];\n}\nprocess.loadEnvFile(${JSON.stringify(envPath)});\n`;
	writeFileSync(envLoaderPath, envLoader);

	const path = join(appDir, "ecosystem.config.cjs");
	const config = `module.exports = ${JSON.stringify(
		{
			apps: [
				{
					name: PM2_NAME,
					script: join(appDir, "dist", "main.js"),
					interpreter: nodePath,
					// preload 先清除 PM2 缓存值，再主动读取 launcher.env；不依赖
					// Node --env-file（不会覆盖同名变量）的默认优先级。
					node_args: [`--require=${envLoaderPath}`],
					// 同时阻止 PM2 在新建进程时继承安装器自身的 VCPDeck 配置。
					filter_env: ["VCPDECK_"],
					cwd: appDir,
					autorestart: true,
					restart_delay: 2000,
					kill_timeout: 15000,
					windowsHide: true,
				},
			],
		},
		null,
		2,
	)};\n`;
	writeFileSync(path, config);
	return path;
}

/** 注册 Windows 开机自启任务；非管理员无法创建根目录任务时降级为警告，不视为安装失败。
 * exec 与 warn 可注入以便测试。 */
function registerStartupTask(
	taskName,
	wrapper,
	exec = execFileSync,
	warn = console.error,
) {
	try {
		exec(
			"schtasks.exe",
			[
				"/Create",
				"/SC",
				"ONLOGON",
				"/TN",
				taskName,
				"/TR",
				`"${wrapper}"`,
				"/RL",
				"LIMITED",
				"/F",
			],
			{ stdio: "inherit" },
		);
		return "windows-logon-task";
	} catch (error) {
		if (
			/(access.*denied|拒绝访问|eacces)/i.test(String(error?.message ?? error))
		) {
			warn(
				`[vcpdeck] 未能注册开机自启：创建计划任务需要管理员权限（当前非管理员）。` +
					`Client 已在线，但重启后不会自动恢复；请以管理员身份重跑安装命令以补上自启。`,
			);
			return "not-configured";
		}
		throw error;
	}
}

/**
 * 权限被拒时自动弹 UAC 提权补注册开机自启：
 * - payload 完全自包含（UTF-16LE base64 → -EncodedCommand），适配一次性下载执行；
 * - 提权子进程执行 schtasks 后 `exit $LASTEXITCODE`，父进程 Start-Process -Wait -PassThru 透传；
 * - 成功返回 `windows-logon-task(via-uac)`；取消/失败降级 `not-configured` 并打印可复制兜底命令。
 * startPwsh / warn 可注入以便测试（测试内绝不弹真实 UAC）。
 */
function retryStartupTaskAsAdmin(
	taskName,
	wrapper,
	startPwsh = (args) =>
		spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true }),
	warn = console.error,
) {
	const createCommand = `schtasks.exe /Create /SC ONLOGON /TN "${taskName}" /TR "${wrapper}" /RL LIMITED /F`;
	const payload =
		`${createCommand}\r\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
	const encoded = Buffer.from(payload, "utf16le").toString("base64");
	const parentCommand =
		`$p = Start-Process powershell -Verb RunAs -Wait -PassThru ` +
		`-ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
	const result = startPwsh(["-NoProfile", "-Command", parentCommand]);
	if (result.status === 0) {
		console.log(
			`[vcpdeck] 已通过 UAC 提权补注册开机自启（计划任务 ${taskName}）`,
		);
		return "windows-logon-task(via-uac)";
	}
	warn(
		`[vcpdeck] 未能注册开机自启：UAC 提权被取消或失败。可手动以管理员身份运行：` +
			`\n  ${createCommand.replace("schtasks.exe", "schtasks")}`,
	);
	return "not-configured";
}

function configureStartup(pm2, nodePath, appDir) {
	if (platform() === "win32") {
		const wrapper = join(appDir, "pm2-resurrect.cmd");
		writeFileSync(
			wrapper,
			`@echo off\r\n"${pm2.command}" ${pm2.argsPrefix.map((v) => `"${v}"`).join(" ")} resurrect\r\n`,
		);
		const taskName = "VCPDeck PM2 Startup";
		const existing = spawnSync(
			"schtasks.exe",
			["/Query", "/TN", taskName, "/V", "/FO", "LIST"],
			{ encoding: "utf8" },
		);
		if (existing.status === 0) {
			const normalizedOutput = existing.stdout.replace(/\\/g, "/").toLowerCase();
			const normalizedWrapper = wrapper.replace(/\\/g, "/").toLowerCase();
			if (!normalizedOutput.includes(normalizedWrapper)) {
				throw new Error(`Windows 计划任务 ${taskName} 已存在但指向其他命令`);
			}
		} else {
			const outcome = registerStartupTask(taskName, wrapper);
			if (outcome === "not-configured") {
				// 非管理员：自动弹 UAC 提权补注册，取消/失败再降级并给出可执行命令
				return retryStartupTaskAsAdmin(taskName, wrapper);
			}
			return outcome;
		}
		return "windows-logon-task";
	}
	const username = userInfo().username;
	const service = `pm2-${username}.service`;
	const enabled = spawnSync("systemctl", ["is-enabled", service], {
		encoding: "utf8",
	});
	if (enabled.status !== 0) {
		const args = [
			...pm2.argsPrefix,
			"startup",
			"systemd",
			"-u",
			username,
			"--hp",
			homedir(),
		];
		execFileSync("sudo", [pm2.command, ...args], {
			stdio: "inherit",
			env: {
				...process.env,
				PATH: `${dirname(nodePath)}:${process.env.PATH || ""}`,
			},
		});
	}
	const verified = spawnSync("systemctl", ["is-enabled", service], {
		encoding: "utf8",
	});
	if (verified.status !== 0) throw new Error(`systemd 服务 ${service} 未启用`);
	return service;
}

function pm2Process(pm2) {
	const json = runPm2(pm2, ["jlist"], { capture: true });
	try {
		return JSON.parse(json).find((entry) => entry.name === PM2_NAME) || null;
	} catch {
		return null;
	}
}

async function waitForClient(origin, clientId, psk, version, name, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		try {
			last = await fetchJson(
				`${origin}/api/client-installer/clients/${encodeURIComponent(clientId)}/status`,
				{
					headers: { "x-vcpdeck-psk": psk },
					timeoutMs: 15_000,
				},
			);
			if (
				last.registered &&
				last.online &&
				last.clientVersion === version &&
				last.capabilitiesReported
			) {
				if (last.name !== name) {
					await fetchJson(
						`${origin}/api/client-installer/clients/${encodeURIComponent(clientId)}/name`,
						{
							method: "PUT",
							headers: { "content-type": "application/json", "x-vcpdeck-psk": psk },
							body: JSON.stringify({ name }),
							timeoutMs: 15_000,
						},
					);
				}
				return last;
			}
		} catch (error) {
			last = { error: error.message };
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
	}
	throw new Error(
		`Client 未在 ${timeoutMs / 1000} 秒内完成上线验收；最后状态: ${JSON.stringify(last)}`,
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const defaultDir = join(homedir(), ".vcpdeck", "launcher-client");
	const priorStatePath = join(homedir(), ".vcpdeck", "client-install.json");
	let priorState = {};
	try {
		priorState = JSON.parse(readFileSync(priorStatePath, "utf8"));
	} catch {}
	const priorDir = priorState.appDir ? resolve(priorState.appDir) : defaultDir;
	const priorEnv = readEnv(join(priorDir, "launcher.env"));
	const existingOrigin = normalizeOrigin(
		priorEnv.VCPDECK_SERVER || priorState.serverOrigin,
	);
	if (existingOrigin && existingOrigin !== args.serverOrigin) {
		throw new Error(
			`检测到 Client 已连接其他 Server: ${existingOrigin}；请先卸载或执行独立迁移`,
		);
	}
	const config = await askConfiguration(
		priorState.displayName || hostname(),
		priorDir,
	);
	if (!config.confirmed) {
		console.log("[vcpdeck] 已取消");
		return;
	}
	const clientId = ensureClientId();
	mkdirSync(dirname(priorStatePath), { recursive: true });
	const saveState = (stage, extra = {}) =>
		writeFileSync(
			priorStatePath,
			JSON.stringify(
				{
					version: INSTALL_STATE_VERSION,
					serverOrigin: args.serverOrigin,
					appDir: config.appDir,
					displayName: config.name,
					clientId,
					stage,
					...extra,
				},
				null,
				2,
			),
		);

	saveState("bootstrap");
	const preflight = await fetchJson(
		`${args.serverOrigin}/api/client-installer/preflight?platform=${encodeURIComponent(args.platform)}`,
		{ timeoutMs: 60_000 },
	);
	const bootstrap = await fetchJson(
		`${args.serverOrigin}/api/client-installer/bootstrap`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ platform: args.platform }),
			timeoutMs: 60_000,
		},
	);
	const archiveUrl = parseUrl(
		bootstrap.archiveUrl,
		"archiveUrl",
		args.serverOrigin,
	);
	const cache = join(
		homedir(),
		".vcpdeck",
		"cache",
		"releases",
		basename(archiveUrl.pathname) ||
			`vcpdeck-${bootstrap.releaseVersion}-${args.platform}.zip`,
	);
	if (
		!existsSync(cache) ||
		sha256(cache) !== bootstrap.archiveSha256.toLowerCase()
	) {
		console.log(`[vcpdeck] 下载 Client Release ${bootstrap.releaseVersion}`);
		await download(archiveUrl.href, cache, bootstrap.archiveSha256);
	}
	const lowInstaller = join(homedir(), ".vcpdeck", "cache", "install.cjs");
	await download(
		parseUrl(
			preflight.lowLevelInstallerUrl,
			"lowLevelInstallerUrl",
			args.serverOrigin,
		).href,
		lowInstaller,
		preflight.lowLevelInstallerSha256,
	);
	saveState("install-files", { releaseVersion: bootstrap.releaseVersion });
	const versionManifest = join(
		config.appDir,
		"apps",
		bootstrap.releaseVersion,
		"manifest.json",
	);
	const launcherMain = join(config.appDir, "dist", "main.js");
	const clientMain = join(
		config.appDir,
		"apps",
		bootstrap.releaseVersion,
		"client",
		"dist",
		"index.js",
	);
	if (
		!existsSync(versionManifest) ||
		!existsSync(launcherMain) ||
		!existsSync(clientMain)
	) {
		execFileSync(
			args.nodePath,
			[
				lowInstaller,
				"--artifact=client",
				`--zip=${cache}`,
				`--version=${bootstrap.releaseVersion}`,
				`--app-dir=${config.appDir}`,
				`--sha256=${bootstrap.archiveSha256}`,
				"--no-env",
				"--force",
			],
			{ stdio: "inherit" },
		);
	}
	const envPath = writeLauncherEnv(
		config.appDir,
		args.serverOrigin,
		bootstrap.psk,
		clientId,
	);

	saveState("pm2", { releaseVersion: bootstrap.releaseVersion });
	const pm2 = ensurePm2(args.nodePath, [
		"https://registry.npmmirror.com",
		"https://registry.npmjs.org",
	]);
	const ecosystem = writeEcosystem(config.appDir, args.nodePath, envPath);
	const existing = pm2Process(pm2);
	if (existing) {
		const existingScript = resolve(existing.pm2_env?.pm_exec_path || "");
		if (existingScript !== resolve(launcherMain))
			throw new Error(`PM2 中已存在同名进程但路径不同: ${existingScript}`);
		runPm2(pm2, ["restart", ecosystem, "--only", PM2_NAME, "--update-env"]);
	} else runPm2(pm2, ["start", ecosystem, "--only", PM2_NAME]);
	runPm2(pm2, ["save"]);
	const processInfo = pm2Process(pm2);
	if (processInfo?.pm2_env?.status !== "online")
		throw new Error("PM2 中 Launcher 未处于 online");

	// 先验证 Client 上线：这是安装的核心结果，不应被后续可选的自启配置失败掩盖
	saveState("verify", { releaseVersion: bootstrap.releaseVersion });
	await waitForClient(
		args.serverOrigin,
		clientId,
		bootstrap.psk,
		bootstrap.releaseVersion,
		config.name,
		bootstrap.verificationTimeoutMs || 120_000,
	);

	// 开机自启属于最后一步最佳努力：失败（如非管理员）只降级为警告并给出修复指引
	let startup = "not-configured";
	try {
		startup = configureStartup(pm2, args.nodePath, config.appDir);
	} catch (error) {
		console.error(
			`[vcpdeck] 未能配置开机自启: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	saveState("done", {
		releaseVersion: bootstrap.releaseVersion,
		startup,
		completedAt: new Date().toISOString(),
	});
	console.log(`\n[vcpdeck] 安装成功: ${config.name} (${clientId})`);
	console.log(`  版本: ${bootstrap.releaseVersion}`);
	console.log(`  PM2: ${PM2_NAME}`);
	console.log(`  自启: ${startup}`);
	if (startup === "not-configured") {
		console.log(
			`  提示: 未注册开机自启；请以管理员身份重跑同一条安装命令以补齐。`,
		);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(
			`\n[vcpdeck] 安装失败: ${error instanceof Error ? error.message : String(error)}`,
		);
		console.error(`[vcpdeck] 已保留现场；修复后重新执行同一条安装命令。`);
		console.error(`[vcpdeck] 日志: pm2 logs ${PM2_NAME} --lines 100`);
		process.exitCode = 1;
	});
}

module.exports = {
	parseArgs,
	readEnv,
	normalizeOrigin,
	ensureClientId,
	installPm2Retry,
	resolveGlobalPm2,
	buildNodeRuntimeEnv,
	npmPath,
	writeEcosystem,
	registerStartupTask,
	retryStartupTaskAsAdmin,
};
