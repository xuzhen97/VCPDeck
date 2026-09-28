/**
 * dev 集成测试的 Pi 凭据根密钥引导。
 *
 * 背景：Pi Provider 凭据以 AES-256-GCM 密文落库，根密钥只能来自 Server 进程外的
 * `VCPDECK_PI_CREDENTIAL_KEY_FILE`；缺失或非法时凭据写入 fail closed
 * （`PI_CONFIG_UNAVAILABLE: Pi 凭据密钥未配置或非法`），于是裸跑 `pnpm dev:all`
 * 连 Provider 都存不下来，也就无法做 Agent 对话的本地集成测试。
 *
 * 做法：本地 dev 下，若该变量既不在当前环境、也没写进 `packages/server/.env`，
 * 就在 `<repo>/.tmp/dev-secrets/pi-credential.key` 生成一个 base64 的 32 字节随机密钥
 * （POSIX 下 0600），并把变量写进 git-ignored 的 `packages/server/.env`。
 * `packages/server/.env` 缺失时先从 `.env.example` 复制一份，否则 Server 首次启动
 * 仍会因缺 `VCPDECK_ADMIN_PASSWORD` 退出，等于没省掉手工配置。
 *
 * 安全边界（不放松任何校验）：
 * - 已有密钥一律复用，绝不覆盖：覆盖会让既有密文再也解不开；
 * - 只生成/修复自己管理的路径；`.env` 指向别处的路径缺失时只告警，不猜、不改；
 * - 不打印密钥内容；
 * - 只由 dev 脚本调用；生产仍必须显式提供进程外密钥文件（docs/deployment.md）。
 */
const {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
const { dirname, isAbsolute, join, resolve } = require("node:path");

const KEY_BYTES = 32;
const VAR_NAME = "VCPDECK_PI_CREDENTIAL_KEY_FILE";

/** 把路径写成 .env 友好的形式（Windows 反斜杠在 dotenv 里易踩转义坑）。 */
function toEnvPath(target) {
	return target.replace(/\\/g, "/");
}

/** 密钥文件有效 = 存在且内容为 base64 的 32 字节。 */
function readKeyState(keyFile) {
	if (!existsSync(keyFile)) return { ok: false, reason: "missing" };
	let text;
	try {
		text = readFileSync(keyFile, "utf8");
	} catch {
		return { ok: false, reason: "unreadable" };
	}
	const key = Buffer.from(text.trim(), "base64");
	if (key.length !== KEY_BYTES) return { ok: false, reason: "invalid" };
	return { ok: true, fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 12) };
}

/** 读取 .env 中当前生效的密钥文件路径（相对路径按 Server 包目录解析，与 dotenv 一致）。 */
function readConfiguredPath(envFile, serverDir) {
	if (!existsSync(envFile)) return null;
	const text = readFileSync(envFile, "utf8");
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*VCPDECK_PI_CREDENTIAL_KEY_FILE\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		const value = match[1].trim().replace(/^["']|["']$/g, "");
		if (!value) return null;
		return isAbsolute(value) ? value : resolve(serverDir, value);
	}
	return null;
}

function writeKeyFile(keyFile) {
	mkdirSync(dirname(keyFile), { recursive: true });
	writeFileSync(keyFile, `${randomBytes(KEY_BYTES).toString("base64")}\n`, { mode: 0o600 });
	try {
		// Windows 只映射只读位；失败不影响可用性，因此不视为错误。
		chmodSync(keyFile, 0o600);
	} catch {
		/* ignore */
	}
}

/**
 * 追加变量行；已有同名行时不重复写（调用方保证只在缺失时调用）。
 * `.env` 缺失时先从 `.env.example` 复制：否则 Server 首次启动仍会因缺
 * `VCPDECK_ADMIN_PASSWORD` 退出，自动生成密钥就失去意义。
 */
function appendEnvEntry(envFile, keyFile, log) {
	if (!existsSync(envFile)) {
		const example = join(dirname(envFile), ".env.example");
		if (existsSync(example)) {
			writeFileSync(envFile, readFileSync(example, "utf8"));
			log(`[dev-pi-credential] created ${envFile}（来自 .env.example）`);
		} else {
			writeFileSync(
				envFile,
				"# VCPDeck Server 本地开发配置（由 pnpm dev / dev:all 自动生成，勿提交）\n",
			);
			log(`[dev-pi-credential] created ${envFile}`);
		}
	}
	const text = readFileSync(envFile, "utf8");
	const body = text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
	writeFileSync(
		envFile,
		`${body}\n# ── Pi Provider 凭据根密钥（本地 dev 自动生成，勿提交）──\n`
			+ "# 生产必须改为 Server 进程外的密钥文件（docs/deployment.md）。\n"
			+ `${VAR_NAME}=${toEnvPath(keyFile)}\n`,
	);
}

/**
 * 确保本地 dev 环境存在可用的 Pi 凭据根密钥。
 *
 * @returns {{ status: string, keyFile: string, envFile: string, detail?: string }}
 */
function ensureDevPiCredentialKey({
	repoRoot = resolve(__dirname, ".."),
	env = process.env,
	log = (message) => console.log(message),
	warn = (message) => console.warn(message),
} = {}) {
	const serverDir = join(repoRoot, "packages", "server");
	const envFile = join(serverDir, ".env");
	const managedKeyFile = join(repoRoot, ".tmp", "dev-secrets", "pi-credential.key");

	// 1) 显式环境变量优先：只校验，不写任何文件。
	const fromEnv = env[VAR_NAME];
	if (fromEnv) {
		const state = readKeyState(isAbsolute(fromEnv) ? fromEnv : resolve(serverDir, fromEnv));
		if (state.ok) {
			log(`[dev-pi-credential] ok: 使用环境变量指定的密钥文件（${state.fingerprint}）`);
			return { status: "env", keyFile: fromEnv, envFile };
		}
		warn(
			`[dev-pi-credential] ${VAR_NAME} 指向的密钥文件不可用（${state.reason}）；`
				+ "保持原样，Pi 凭据写入会 fail closed。",
		);
		return { status: "env-unusable", keyFile: fromEnv, envFile, detail: state.reason };
	}

	const configured = readConfiguredPath(envFile, serverDir);

	// 2) .env 已配置但指向别处：只告警，绝不越界创建/覆盖用户文件。
	if (configured && resolve(configured) !== resolve(managedKeyFile)) {
		const state = readKeyState(configured);
		if (state.ok) {
			log(`[dev-pi-credential] ok: 复用已配置的密钥文件（${state.fingerprint}）`);
			return { status: "reused-custom", keyFile: configured, envFile };
		}
		warn(
			`[dev-pi-credential] 已配置的密钥文件不可用（${state.reason}: ${configured}）；`
				+ "保持原样，Pi 凭据写入会 fail closed。",
		);
		return { status: "custom-unusable", keyFile: configured, envFile, detail: state.reason };
	}

	// 3) 本脚本管理的路径：有则复用（绝不覆盖），无则生成。
	const existing = readKeyState(managedKeyFile);
	let status;
	if (existing.ok) {
		status = "reused";
	} else {
		writeKeyFile(managedKeyFile);
		status = existing.reason === "missing" ? "generated" : "repaired";
	}

	if (!configured) appendEnvEntry(envFile, managedKeyFile, log);

	const after = readKeyState(managedKeyFile);
	log(
		`[dev-pi-credential] ok: ${managedKeyFile}（${after.fingerprint}，本地开发密钥；`
			+ "生产请显式配置，见 docs/deployment.md）",
	);
	return { status, keyFile: managedKeyFile, envFile };
}

module.exports = {
	VAR_NAME,
	ensureDevPiCredentialKey,
	readConfiguredPath,
	readKeyState,
};

if (require.main === module) {
	ensureDevPiCredentialKey();
}
