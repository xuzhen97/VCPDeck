/**
 * scripts/ensure-dev-pi-credential-key.cjs 单元测试（node:test）
 * 运行: node scripts/ensure-dev-pi-credential-key.test.cjs
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
	VAR_NAME,
	ensureDevPiCredentialKey,
	readKeyState,
} = require("./ensure-dev-pi-credential-key.cjs");

function makeRepo({ env = null, example = null } = {}) {
	const root = mkdtempSync(join(tmpdir(), "vcpdeck-pi-key-"));
	const serverDir = join(root, "packages", "server");
	mkdirSync(serverDir, { recursive: true });
	if (example !== null) writeFileSync(join(serverDir, ".env.example"), example);
	if (env !== null) writeFileSync(join(serverDir, ".env"), env);
	return root;
}

function quiet() {
	return { log: () => {}, warn: () => {} };
}

const roots = [];
function track(root) {
	roots.push(root);
	return root;
}

test.after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("未配置时生成密钥并把变量写进 packages/server/.env", () => {
	const root = track(makeRepo({ example: "VCPDECK_ADMIN_PASSWORD=test123\n" }));
	const result = ensureDevPiCredentialKey({ repoRoot: root, env: {}, ...quiet() });

	assert.equal(result.status, "generated");
	const keyFile = join(root, ".tmp", "dev-secrets", "pi-credential.key");
	assert.equal(result.keyFile, keyFile);
	assert.ok(readKeyState(keyFile).ok, "生成的密钥必须是 base64 的 32 字节");

	const env = readFileSync(result.envFile, "utf8");
	assert.match(env, /VCPDECK_ADMIN_PASSWORD=test123/, "缺失的 .env 应从 .env.example 复制");
	assert.match(env, new RegExp(`${VAR_NAME}=`));
	assert.ok(env.includes(keyFile.replace(/\\/g, "/")), ".env 应写入绝对路径（正斜杠形式）");
});

test("重复运行复用同一密钥且不重复写变量行", () => {
	const root = track(makeRepo({ example: "" }));
	const first = ensureDevPiCredentialKey({ repoRoot: root, env: {}, ...quiet() });
	const firstKey = readFileSync(first.keyFile, "utf8");
	const firstEnv = readFileSync(first.envFile, "utf8");

	const second = ensureDevPiCredentialKey({ repoRoot: root, env: {}, ...quiet() });

	assert.equal(second.status, "reused");
	assert.equal(readFileSync(second.keyFile, "utf8"), firstKey, "已有密钥绝不能被覆盖");
	assert.equal(readFileSync(second.envFile, "utf8"), firstEnv, ".env 不应再被改写");
	const occurrences = readFileSync(second.envFile, "utf8").split(VAR_NAME).length - 1;
	assert.equal(occurrences, 1);
});

test("密钥文件存在但 .env 缺变量时补写变量并保留原密钥", () => {
	const root = track(makeRepo({ env: "VCPDECK_ADMIN_PASSWORD=test123\n" }));
	const keyFile = join(root, ".tmp", "dev-secrets", "pi-credential.key");
	mkdirSync(join(root, ".tmp", "dev-secrets"), { recursive: true });
	writeFileSync(keyFile, `${Buffer.alloc(32, 7).toString("base64")}\n`);
	const before = readFileSync(keyFile, "utf8");

	const result = ensureDevPiCredentialKey({ repoRoot: root, env: {}, ...quiet() });

	assert.equal(result.status, "reused");
	assert.equal(readFileSync(keyFile, "utf8"), before);
	assert.match(readFileSync(result.envFile, "utf8"), new RegExp(`${VAR_NAME}=`));
});

test("损坏的自管理密钥文件被重新生成", () => {
	const root = track(makeRepo({ env: "VCPDECK_ADMIN_PASSWORD=test123\n" }));
	const keyFile = join(root, ".tmp", "dev-secrets", "pi-credential.key");
	mkdirSync(join(root, ".tmp", "dev-secrets"), { recursive: true });
	writeFileSync(keyFile, "not-a-key\n");

	const result = ensureDevPiCredentialKey({ repoRoot: root, env: {}, ...quiet() });

	assert.equal(result.status, "repaired");
	assert.ok(readKeyState(keyFile).ok);
});

test("环境变量优先：不读写任何文件", () => {
	const root = track(makeRepo());
	const keyFile = join(root, "external.key");
	writeFileSync(keyFile, `${Buffer.alloc(32, 3).toString("base64")}\n`);

	const result = ensureDevPiCredentialKey({
		repoRoot: root,
		env: { [VAR_NAME]: keyFile },
		...quiet(),
	});

	assert.equal(result.status, "env");
	assert.equal(existsSync(join(root, "packages", "server", ".env")), false);
	assert.equal(existsSync(join(root, ".tmp")), false);
});

test(".env 指向别处且文件缺失时只告警，不创建也不改写", () => {
	const outside = join(tmpdir(), "vcpdeck-does-not-exist", "key.pem");
	const env = `VCPDECK_ADMIN_PASSWORD=test123\n${VAR_NAME}=${outside}\n`;
	const root = track(makeRepo({ env }));
	const warnings = [];
	const result = ensureDevPiCredentialKey({
		repoRoot: root,
		env: {},
		log: () => {},
		warn: (message) => warnings.push(message),
	});

	assert.equal(result.status, "custom-unusable");
	assert.equal(warnings.length, 1);
	assert.equal(readFileSync(result.envFile, "utf8"), env, ".env 必须保持原样");
	assert.equal(existsSync(outside), false, "不得在用户配置的路径外创建文件");
});

test("环境变量指向的密钥不可用时告警且不写文件", () => {
	const root = track(makeRepo());
	const warnings = [];
	const result = ensureDevPiCredentialKey({
		repoRoot: root,
		env: { [VAR_NAME]: join(root, "missing.key") },
		log: () => {},
		warn: (message) => warnings.push(message),
	});

	assert.equal(result.status, "env-unusable");
	assert.equal(warnings.length, 1);
	assert.equal(existsSync(join(root, "packages", "server", ".env")), false);
});
