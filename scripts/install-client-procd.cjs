/**
 * iStoreOS 24.10 x64 musl + procd 的 Client 安装器（ADR-0065）。
 *
 * 设计要点：
 * - 平台判定只认现场事实（os-release / uname / loader / PID1），不猜、不降级；
 * - 所有持久路径先校验再写盘，校验失败时零副作用；
 * - 只解压、不执行包内内容；Node 运行时按锁文件 SHA-256 校验后才解压并自报版本；
 * - 安装顺序：payload → 私有 Node → launcher.env → 服务文件 → enable → stop → 切 apps/current → start → 在线验收；
 * - 错误信息只用稳定 code，绝不带下载 URL、PSK 或文件内容。
 *
 * 用法（敏感值只走环境变量，不进 argv）：
 *   node scripts/install-client-procd.cjs --check-platform
 *   VCPDECK_PROCD_SERVER=https://... VCPDECK_PROCD_PSK=<psk> \
 *   VCPDECK_PROCD_CLIENT_ID=<uuid> VCPDECK_PROCD_LOCK=<lock.json> \
 *   VCPDECK_PROCD_RUNTIME=<node.tar.gz> \
 *   node scripts/install-client-procd.cjs --install --staging <解压后的发布包根目录>
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
	APPROVED_PATHS,
	validatePersistentPath,
} = require("./client-procd-layout.cjs");
const { renderProcdService } = require("./client-procd-lifecycle.cjs");
const { extractTarGz } = require("./procd-archive.cjs");

const CLIENT_DIR = "/opt/vcpdeck/client";
const STATE_DIR = "/opt/vcpdeck/state";
const STATE_HOME = `${STATE_DIR}/home`;
const CONFIG_DIR = "/etc/vcpdeck";
const SERVICE_FILE = "/etc/init.d/vcpdeck-client";
const APP_DIR = path.join(CLIENT_DIR, "launcher");
const APPS_DIR = path.join(APP_DIR, "apps");
const NODE_DIR = path.join(APP_DIR, "node");
// 与 Launcher 的 runtimeCacheKey（<platform>/node-<version>-<sha256>）保持同一布局，
// 首次安装预装的 Node 与后续 ensureMuslRuntime 的缓存命中是同一份文件。
const RUNTIME_DIR = path.join(APP_DIR, "runtime");
const RUNTIME_PLATFORM = "linux-x64-musl";
const ENV_FILE = path.join(APP_DIR, "launcher.env");
const LAUNCHER_NODE = path.join(NODE_DIR, "current", "bin", "node");
const LAUNCHER_ENTRY = path.join(APP_DIR, "dist", "main.js");
const REQUIRED_BYTES = {
	[CLIENT_DIR]: 220 * 1024 * 1024,
	[STATE_DIR]: 32 * 1024 * 1024,
	[CONFIG_DIR]: 1024 * 1024,
};
const NODE_ARCHIVE_PATTERN = /^node-v(\d+\.\d+\.\d+)-linux-x64-musl\.tar\.gz$/;
const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_INTERVAL_MS = 3_000;

/** 只接受 iStoreOS 24.10.x、x86_64、musl、procd。 */
function validatePlatform(facts) {
	const supported =
		facts &&
		facts.id === "istoreos" &&
		typeof facts.versionId === "string" &&
		/^24\.10(\.|$)/.test(facts.versionId) &&
		facts.arch === "x86_64" &&
		facts.libc === "musl" &&
		facts.init === "procd";
	if (!supported) throw new Error("PROCD_PLATFORM_UNSUPPORTED");
	if (facts.euid !== 0) throw new Error("PROCD_ROOT_REQUIRED");
}

/** 解析 os-release 的键值对；只接受不带引号的简单值。 */
function parseOsRelease(text) {
	const result = {};
	for (const line of text.split("\n")) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
		if (!match) continue;
		result[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return result;
}

/** mountinfo 的挂载点与 upperdir 用八进制转义空格/制表符等，比较前先还原。 */
function unescapeMountField(value) {
	return value
		.replace(/\\040/g, " ")
		.replace(/\\011/g, "\t")
		.replace(/\\012/g, "\n")
		.replace(/\\134/g, "\\");
}

/** 从 /proc/self/mountinfo 里找覆盖目标路径的最长挂载点。 */
function findMount(mountinfo, target) {
	let best = null;
	for (const line of mountinfo.split("\n")) {
		const fields = line.split(" ");
		if (fields.length < 5) continue;
		const mountPoint = unescapeMountField(fields[4]);
		if (
			target === mountPoint ||
			target.startsWith(`${mountPoint.replace(/\/$/, "")}/`)
		) {
			if (!best || mountPoint.length > best.mountPoint.length) {
				const separator = fields.indexOf("-");
				best = {
					mountPoint,
					fsType: separator >= 0 ? fields[separator + 1] : "unknown",
					options: separator >= 0 ? fields.slice(separator + 3).join(" ") : "",
				};
			}
		}
	}
	return best;
}

/**
 * 校验 Server Origin：只接受 http/https 协议头，丢弃路径与查询串。
 * @param {string} value
 */
function normalizeOrigin(value) {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (!url.hostname) return null;
		return `${url.protocol}//${url.host}`;
	} catch {
		return null;
	}
}

/** 校验 PSK：Server 与 Client 按原始字符串比较，只拒绝空值、空白/控制字符与超长值。 */
function validatePsk(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f || /\s/u.test(char)) return false;
	}
	return true;
}

/** 校验 Client ID 为 UUID；缺省由 Launcher 首次启动时自行生成。 */
function validateClientId(value) {
	if (value === undefined || value === "") return true;
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}

/** launcher.env 文本：固定 8 键，敏感值只落盘。 */
function buildEnvContent({ serverOrigin, psk, clientId }) {
	const lines = [
		"# 由 VCPDeck iStoreOS procd 安装器生成（敏感值请妥善保管）",
		`VCPDECK_APP_DIR=${APP_DIR}`,
		`VCPDECK_CLIENT_DATA_DIR=${STATE_DIR}`,
		"VCPDECK_ARTIFACT=client",
		`VCPDECK_SERVER=${serverOrigin}`,
		`VCPDECK_PSK=${psk}`,
		"VCPDECK_INSTALLATION_MODE=procd-root",
	];
	if (clientId) lines.push(`VCPDECK_CLIENT_ID=${clientId}`);
	lines.push("");
	return lines.join("\n");
}

/** 读取并校验发布包 manifest.json（安装前只读，无副作用）。 */
function readStagingManifest(stagingDir) {
	const manifestPath = path.join(stagingDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) throw new Error("PROCD_ARCHIVE_INVALID");
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch {
		throw new Error("PROCD_ARCHIVE_INVALID");
	}
	const version = manifest?.version;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error("PROCD_ARCHIVE_INVALID");
	}
	if (
		typeof manifest?.launcher?.dir !== "string" ||
		typeof manifest?.launcher?.entry !== "string"
	) {
		throw new Error("PROCD_ARCHIVE_INVALID");
	}
	// musl 包必须是 Client-only：出现 Server 构件说明拿错了包。
	if (manifest?.artifacts?.server) throw new Error("PROCD_ARCHIVE_INVALID");
	return manifest;
}

/** 读取并校验 musl 运行时锁文件；字段与 @vcpdeck/shared 的 MuslReleaseTarget 一致。 */
function parseRuntimeLock(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("PROCD_RUNTIME_LOCK_INVALID");
	}
	const runtime = value?.runtime;
	const valid =
		value?.schema === 1 &&
		value?.platform === "linux-x64-musl" &&
		value?.role === "client" &&
		typeof runtime?.version === "string" &&
		/^24\.\d+\.\d+$/.test(runtime.version) &&
		typeof runtime?.url === "string" &&
		/^https:\/\/(?:nodejs\.org|unofficial-builds\.nodejs\.org)\//.test(runtime.url) &&
		runtime.url.endsWith(`/node-v${runtime.version}-linux-x64-musl.tar.gz`) &&
		typeof runtime?.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(runtime.sha256);
	if (!valid) throw new Error("PROCD_RUNTIME_LOCK_INVALID");
	return { version: runtime.version, url: runtime.url, sha256: runtime.sha256 };
}

/** 现场事实采集：平台 + 路径 + 文件系统动作。 */
function createSystemAdapter() {
	return {
		readPlatformFacts() {
			const osRelease = parseOsRelease(
				fs.readFileSync("/etc/os-release", "utf8"),
			);
			const pid1 = fs
				.readFileSync("/proc/1/comm", "utf8")
				.trim()
				.toLowerCase();
			const libc = fs.existsSync("/lib/ld-musl-x86_64.so.1")
				? "musl"
				: "glibc";
			return {
				id: (osRelease.ID ?? "").toLowerCase(),
				versionId: osRelease.VERSION_ID ?? "",
				arch: execFileSync("uname", ["-m"], { encoding: "utf8" }).trim(),
				libc,
				init: pid1 === "procd" ? "procd" : pid1,
				euid: typeof process.geteuid === "function" ? process.geteuid() : -1,
			};
		},
		readPathFacts(target) {
			const mount = findMount(
				fs.readFileSync("/proc/self/mountinfo", "utf8"),
				target,
			);
			// 目标可能尚未创建：向上找到最近的已存在祖先，用它的身份与可用空间校验。
			let probe = target;
			let stat;
			let probeStat;
			for (;;) {
				try {
					stat = fs.lstatSync(probe);
					probeStat = stat;
					break;
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
					const parent = path.dirname(probe);
					if (parent === probe) throw new Error("PROCD_UNSAFE_LAYOUT");
					probe = parent;
				}
			}
			const ancestors = [];
			let current = probe;
			for (let depth = 0; depth < 16; depth += 1) {
				ancestors.push({
					path: current,
					uid: stat.uid,
					mode: stat.mode,
				});
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
				try {
					stat = fs.lstatSync(current);
				} catch {
					break;
				}
			}
			const fsStat = fs.statfsSync(probe);
			// overlay 的持久性取决于 upperdir 所在的介质，必须顺着 mount 选项再查一次。
			let upperFsType;
			if (mount?.fsType === "overlay") {
				const rawUpperDir = /(?:^|,)upperdir=([^,]+)/.exec(mount.options ?? "")?.[1];
				const upperDir = rawUpperDir ? unescapeMountField(rawUpperDir) : undefined;
				if (upperDir) {
					const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
					upperFsType = findMount(mountinfo, upperDir)?.fsType ?? "unknown";
				}
			}
			return {
				path: target,
				probePath: probe,
				fsType: mount?.fsType ?? "unknown",
				upperFsType,
				// 目标本身若为符号链接必须暴露；祖先循环后的 stat 可能已是 "/"。
				uid: probeStat.uid,
				symlink: probeStat.isSymbolicLink(),
				availableBytes: fsStat.bavail * fsStat.bsize,
				ancestors,
			};
		},
		async ensureDir(target) {
			fs.mkdirSync(target, { recursive: true, mode: 0o700 });
			fs.chmodSync(target, 0o700);
		},
		async installPayload({ stagingDir, version }) {
			const clientDir = path.join(stagingDir, "client");
			const launcherDist = path.join(stagingDir, "launcher", "dist");
			if (
				!fs.existsSync(path.join(clientDir, "dist")) ||
				!fs.existsSync(launcherDist)
			) {
				throw new Error("PROCD_ARCHIVE_INVALID");
			}
			// 版本目录必须与更新流程同构：Launcher 复验时会验 manifest.json.sig。
			// 在动 dist 之前检查，缺签名时保持现场不变。
			const signaturePath = path.join(stagingDir, "manifest.json.sig");
			if (!fs.existsSync(signaturePath)) {
				throw new Error("PROCD_ARCHIVE_SIGNATURE_MISSING");
			}
			// 稳定 Launcher：只替换 dist/ 与 package.json，node/ 与 apps/ 原地保留。
			const distIncoming = path.join(APP_DIR, ".dist.incoming");
			const distPrevious = path.join(APP_DIR, ".dist.previous");
			fs.rmSync(distIncoming, { recursive: true, force: true });
			fs.cpSync(launcherDist, distIncoming, { recursive: true });
			fs.rmSync(distPrevious, { recursive: true, force: true });
			if (fs.existsSync(path.join(APP_DIR, "dist"))) {
				fs.renameSync(path.join(APP_DIR, "dist"), distPrevious);
			}
			fs.renameSync(distIncoming, path.join(APP_DIR, "dist"));
			fs.rmSync(distPrevious, { recursive: true, force: true });
			const packageJson = path.join(stagingDir, "launcher", "package.json");
			if (fs.existsSync(packageJson)) {
				fs.copyFileSync(packageJson, path.join(APP_DIR, "package.json"));
			}
			// 版本目录：manifest.json + client 构件 + launcher 构件（回退来源）。
			const target = path.join(APPS_DIR, version);
			const incoming = path.join(APPS_DIR, `.incoming-${process.pid}`);
			fs.rmSync(incoming, { recursive: true, force: true });
			fs.mkdirSync(incoming, { recursive: true });
			fs.copyFileSync(
				path.join(stagingDir, "manifest.json"),
				path.join(incoming, "manifest.json"),
			);
			fs.copyFileSync(signaturePath, path.join(incoming, "manifest.json.sig"));
			fs.cpSync(clientDir, path.join(incoming, "client"), { recursive: true });
			fs.cpSync(path.join(stagingDir, "launcher"), path.join(incoming, "launcher"), {
				recursive: true,
			});
			fs.rmSync(target, { recursive: true, force: true });
			fs.renameSync(incoming, target);
		},
		async activateVersion(version) {
			const pointer = path.join(APPS_DIR, "current");
			fs.rmSync(pointer, { recursive: true, force: true });
			fs.symlinkSync(version, pointer);
		},
		async provisionRuntime({ lockPath, archivePath }) {
			const lock = parseRuntimeLock(fs.readFileSync(lockPath, "utf8"));
			const version = lock.version;
			const runtimeRoot = path.join(RUNTIME_DIR, RUNTIME_PLATFORM);
			const target = path.join(runtimeRoot, `node-${version}-${lock.sha256}`);
			const bin = path.join(target, "bin", "node");
			const switchPointer = () => {
				const pointer = path.join(NODE_DIR, "current");
				fs.rmSync(pointer, { recursive: true, force: true });
				fs.mkdirSync(NODE_DIR, { recursive: true });
				// 相对链接：node/current → ../runtime/linux-x64-musl/node-<version>-<sha256>。
				fs.symlinkSync(path.relative(NODE_DIR, target), pointer, "dir");
			};
			if (fs.existsSync(bin)) {
				fs.chmodSync(bin, 0o755);
				if (probeNodeVersion(bin) === version) {
					switchPointer();
					return version;
				}
				fs.rmSync(target, { recursive: true, force: true });
			}
			const fileName = path.basename(archivePath);
			const archiveMatch = NODE_ARCHIVE_PATTERN.exec(fileName);
			if (archiveMatch?.[1] !== version) {
				throw new Error("PROCD_RUNTIME_ARCHIVE_INVALID");
			}
			const digest = crypto
				.createHash("sha256")
				.update(fs.readFileSync(archivePath))
				.digest("hex");
			if (digest !== lock.sha256) {
				throw new Error("PROCD_RUNTIME_SHA256_MISMATCH");
			}
			const staging = path.join(runtimeRoot, `.incoming-${process.pid}`);
			fs.rmSync(staging, { recursive: true, force: true });
			fs.mkdirSync(staging, { recursive: true });
			try {
				extractTarGz(archivePath, staging);
				const root = path.join(staging, `node-v${version}-linux-x64-musl`);
				const nodeBin = path.join(root, "bin", "node");
				if (!fs.existsSync(nodeBin)) {
					throw new Error("PROCD_RUNTIME_ARCHIVE_INVALID");
				}
				fs.chmodSync(nodeBin, 0o755);
				if (probeNodeVersion(nodeBin) !== version) {
					throw new Error("PROCD_RUNTIME_EXEC_MISMATCH");
				}
				fs.rmSync(target, { recursive: true, force: true });
				fs.mkdirSync(runtimeRoot, { recursive: true });
				fs.renameSync(root, target);
			} finally {
				fs.rmSync(staging, { recursive: true, force: true });
			}
			switchPointer();
			return version;
		},
		async inspectInstall() {
			let serviceContent = null;
			try {
				serviceContent = fs.readFileSync(SERVICE_FILE, "utf8");
			} catch {
				serviceContent = null;
			}
			let currentVersion = null;
			try {
				currentVersion = fs.readlinkSync(path.join(APPS_DIR, "current"));
			} catch {
				currentVersion = null;
			}
			let envContent = null;
			try {
				envContent = fs.readFileSync(ENV_FILE, "utf8");
			} catch {
				envContent = null;
			}
			return {
				installed:
					serviceContent !== null &&
					fs.existsSync(LAUNCHER_ENTRY) &&
					fs.existsSync(LAUNCHER_NODE),
				serviceMatches:
					serviceContent?.includes(
						`procd_set_param env HOME=${STATE_HOME} VCPDECK_INSTALLATION_MODE=procd-root VCPDECK_APP_DIR=${APP_DIR}`,
					) ?? false,
				currentVersion,
				envContent,
			};
		},
		async runtimeReady() {
			return fs.existsSync(LAUNCHER_NODE) && fs.existsSync(LAUNCHER_ENTRY);
		},
		async writeEnvFile({ serverOrigin, psk, clientId }) {
			const content = buildEnvContent({ serverOrigin, psk, clientId });
			const tmp = `${ENV_FILE}.tmp`;
			fs.writeFileSync(tmp, content, { mode: 0o600 });
			fs.chmodSync(tmp, 0o600);
			fs.renameSync(tmp, ENV_FILE);
		},
		async writeServiceFile() {
			// 服务定义来自 scripts/vcpdeck-client.procd：绝对路径启动稳定 Launcher，term_timeout 15s。
			const content = renderProcdService({
				nodePath: LAUNCHER_NODE,
				entryPath: LAUNCHER_ENTRY,
				stateHome: path.join(STATE_DIR, "home"),
				appDir: APP_DIR,
			});
			const tmp = `${SERVICE_FILE}.tmp`;
			fs.writeFileSync(tmp, content, { mode: 0o755 });
			fs.chmodSync(tmp, 0o755);
			fs.renameSync(tmp, SERVICE_FILE);
		},
		async enableService() {
			runServiceCommand("enable");
		},
		async stopService() {
			// 未运行时 stop 返回非零是正常状态，不视为失败。
			runServiceCommand("stop", { ignoreFailure: true });
		},
		async startService() {
			runServiceCommand("start");
		},
		async serviceRunning() {
			try {
				runServiceCommand("status");
				return true;
			} catch {
				return false;
			}
		},
		async verifyClient({ serverOrigin, psk, clientId, version }) {
			// ADR-0065：安装成功不只看 init.d status，还要同身份上线、版本与能力上报。
			const deadline = Date.now() + VERIFY_TIMEOUT_MS;
			const idPath = path.join(STATE_DIR, "home", ".vcpdeck", "client-id");
			let last = "尚无 client-id";
			while (Date.now() < deadline) {
				let id = clientId;
				if (!id) {
					try {
						id = fs.readFileSync(idPath, "utf8").trim();
					} catch {
						id = "";
					}
				}
				if (id) {
					try {
						const response = await fetch(
							`${serverOrigin}/api/client-installer/clients/${encodeURIComponent(id)}/status`,
							{
								headers: { "x-vcpdeck-psk": psk },
								signal: AbortSignal.timeout(15_000),
							},
						);
						if (!response.ok) {
							last = `status=${response.status}`;
						} else {
							const status = await response.json();
							last = `registered=${status.registered} online=${status.online} version=${status.clientVersion} mode=${status.installationMode} capabilities=${status.capabilitiesReported}`;
							if (acceptsInstalledClient(status, version)) return;
						}
					} catch (error) {
						last = error.message;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
			}
			throw new Error(
				`PROCD_VERIFICATION_FAILED: Client 未在时限内完成 procd 上线验收（最后状态: ${last}）`,
			);
		},
	};
}

/** 探测 musl Node 自报版本（不带 v 前缀）；失败返回空串。 */
const NODE_PROBE_SCRIPT =
	"JSON.stringify({version: process.version, glibc: process.report?.getReport()?.header?.glibcVersionRuntime ?? null})";

/**
 * 解析运行时自检输出。
 * 只接受能报出版本且 glibcVersionRuntime 为空（musl）的二进制：预置的 glibc node
 * 装上会让 Launcher 在启动时才 LIBC_MISMATCH，procd 随后无限 respawn。
 * @param {string} raw 子进程 stdout
 * @returns {{version: string, glibc: string | null} | null}
 */
function parseNodeProbe(raw) {
	try {
		const value = JSON.parse(String(raw).trim());
		if (typeof value?.version !== "string") return null;
		if (value.glibc !== null && typeof value.glibc !== "string") return null;
		return { version: value.version.replace(/^v/, ""), glibc: value.glibc };
	} catch {
		return null;
	}
}

function probeNodeVersion(bin) {
	try {
		const raw = execFileSync(bin, ["-p", NODE_PROBE_SCRIPT], {
			encoding: "utf8",
			timeout: 10_000,
		});
		const facts = parseNodeProbe(raw);
		if (!facts || facts.glibc !== null) return "";
		return facts.version;
	} catch {
		return "";
	}
}

/** 执行 init.d 服务的控制命令；只允许固定动作。 */
function runServiceCommand(action, { ignoreFailure = false } = {}) {
	try {
		execFileSync(SERVICE_FILE, [action], { stdio: "ignore" });
	} catch (error) {
		if (ignoreFailure) return;
		throw error;
	}
}

/** 从环境变量读取安装参数（敏感值不进 argv）。 */
function readInstallOptions(argv) {
	const stagingIndex = argv.indexOf("--staging");
	const stagingDir = stagingIndex >= 0 ? argv[stagingIndex + 1] : undefined;
	if (!argv.includes("--install") || !stagingDir) {
		throw new Error("PROCD_USAGE: 需要 --install --staging <目录> 或 --check-platform");
	}
	return {
		stagingDir: path.resolve(stagingDir),
		serverOrigin: process.env.VCPDECK_PROCD_SERVER,
		psk: process.env.VCPDECK_PROCD_PSK,
		clientId: process.env.VCPDECK_PROCD_CLIENT_ID,
		lockPath: process.env.VCPDECK_PROCD_LOCK,
		archivePath: process.env.VCPDECK_PROCD_RUNTIME,
	};
}

/**
 * 安装编排：校验 → 建目录 →（幂等判定）→ payload → 运行时 → env → 服务 → 启停 → 验证。
 * @param {object} adapter 现场适配器（测试用 fake 覆盖全部方法）
 * @param {{stagingDir: string, serverOrigin: string, psk: string, clientId?: string,
 *   lockPath: string, archivePath: string, requiredBytes?: number}} options
 */
async function runInstall(adapter, options) {
	validatePlatform(adapter.readPlatformFacts());
	const serverOrigin = normalizeOrigin(options.serverOrigin);
	if (!serverOrigin) throw new Error("PROCD_SERVER_ORIGIN_INVALID");
	if (!validatePsk(options.psk)) throw new Error("PROCD_PSK_INVALID");
	// 保留 Server 下发的原始大小写：Server 按字符串精确比较 PSK，改写会导致握手失败。
	const psk = options.psk;
	if (!validateClientId(options.clientId)) throw new Error("PROCD_CLIENT_ID_INVALID");
	// 运行时锁文件随发布包走：client/release-target.json 由签名清单的 files 覆盖。
	const lockPath =
		options.lockPath ?? path.join(options.stagingDir, "client", "release-target.json");
	if (!options.archivePath) {
		throw new Error("PROCD_RUNTIME_REQUIRED");
	}
	for (const target of APPROVED_PATHS) {
		validatePersistentPath(
			adapter.readPathFacts(target),
			options.requiredBytes ?? REQUIRED_BYTES[target],
		);
	}
	const manifest = readStagingManifest(options.stagingDir);
	for (const target of APPROVED_PATHS) await adapter.ensureDir(target);
	await adapter.ensureDir(STATE_HOME);
	await adapter.ensureDir(APP_DIR);
	await adapter.ensureDir(APPS_DIR);
	await adapter.ensureDir(NODE_DIR);
	await adapter.ensureDir(RUNTIME_DIR);
	await adapter.ensureDir(path.join(RUNTIME_DIR, RUNTIME_PLATFORM));
	// 幂等：同一版本、同一服务的有效安装只做 reconcile，不重建 payload、不生成新身份。
	// 但 Server/PSK 可能已轮换：env 不一致时走完整安装，重写 env 并重启，再在线验收。
	const desiredEnv = buildEnvContent({
		serverOrigin,
		psk,
		clientId: options.clientId,
	});
	const existing = adapter.inspectInstall
		? await adapter.inspectInstall()
		: { installed: false, serviceMatches: false };
	const running = adapter.serviceRunning ? await adapter.serviceRunning() : true;
	if (
		existing.installed &&
		existing.serviceMatches &&
		existing.currentVersion === manifest.version &&
		existing.envContent === desiredEnv &&
		running &&
		(await adapter.runtimeReady())
	) {
		await adapter.enableService();
		try {
			await adapter.verifyClient({
				serverOrigin,
				psk,
				clientId: options.clientId,
				version: manifest.version,
			});
			return { version: manifest.version, reconciled: true };
		} catch {
			// 服务活着不代表子进程还在：Launcher 可能在崩溃限额用尽后放弃拉起。
			// 重启一次再验收；仍失败则把错误暴露给调用方，不谎报 installed。
			await adapter.stopService();
			if (adapter.serviceRunning && (await adapter.serviceRunning())) {
				throw new Error("PROCD_STOP_UNCONVERGED");
			}
			await adapter.activateVersion(manifest.version);
			await adapter.startService();
			await adapter.verifyClient({
				serverOrigin,
				psk,
				clientId: options.clientId,
				version: manifest.version,
			});
			return { version: manifest.version, reconciled: true };
		}
	}
	await adapter.installPayload({ ...options, version: manifest.version });
	await adapter.provisionRuntime({ ...options, lockPath });
	if (!(await adapter.runtimeReady())) throw new Error("PROCD_RUNTIME_MISSING");
	await adapter.writeEnvFile({ ...options, psk });
	await adapter.writeServiceFile();
	await adapter.enableService();
	await adapter.stopService();
	if (adapter.serviceRunning && (await adapter.serviceRunning())) {
		throw new Error("PROCD_STOP_UNCONVERGED");
	}
	// 运行时与 env 就绪后才切换 apps/current：失败时旧版本保持可用。
	await adapter.activateVersion(manifest.version);
	await adapter.startService();
	await adapter.verifyClient({
		serverOrigin,
		psk,
		clientId: options.clientId,
		version: manifest.version,
	});
	return { version: manifest.version, reconciled: false };
}

/** 安装成功的验收条件：同身份注册上线、版本一致、能力已上报、安装模式为 procd-root。 */
function acceptsInstalledClient(status, version) {
	return Boolean(
		status &&
			status.registered === true &&
			status.online === true &&
			status.clientVersion === version &&
			status.capabilitiesReported === true &&
			status.installationMode === "procd-root",
	);
}

function printPlatform() {
	const adapter = createSystemAdapter();
	validatePlatform(adapter.readPlatformFacts());
	process.stdout.write("procd-ready\n");
}

async function main(argv) {
	if (argv.includes("--check-platform")) {
		printPlatform();
		return;
	}
	await runInstall(createSystemAdapter(), readInstallOptions(argv));
	process.stdout.write("installed\n");
}

module.exports = {
	APPROVED_PATHS,
	acceptsInstalledClient,
	buildEnvContent,
	normalizeOrigin,
	parseNodeProbe,
	parseOsRelease,
	parseRuntimeLock,
	readStagingManifest,
	runInstall,
	validateClientId,
	validatePlatform,
	validatePsk,
};

if (require.main === module) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
