/**
 * Pi／DSH 专用集成退役后的发行与开发布局测试（ADR-0049）。
 *
 * 验证：dev 入口不再引导 Agent 资源/密钥；Client 与 Frontend 不再声明 Pi SDK 依赖；
 * Release 布局不再包含 Pi SDK／Bundle／会话宿主构件；基础依赖（PTY、P2P native）保留。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../../..");

function readJson(p) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
}

function read(p) {
	return fs.readFileSync(path.join(ROOT, p), "utf8");
}

function exists(p) {
	return fs.existsSync(path.join(ROOT, p));
}

test("根 dev 脚本不再引导 Pi 凭据密钥", () => {
	const pkg = readJson("package.json");
	for (const name of ["dev", "dev:all"]) {
		assert.doesNotMatch(pkg.scripts[name], /ensure-dev-pi/);
		assert.doesNotMatch(pkg.scripts[name], /pi-resource|build-dev-pi/);
	}
	assert.equal(pkg.scripts["test:pi-resources"], undefined);
	assert.equal(pkg.devDependencies["pi-simplify"], undefined);
});

test("Client 不再声明 Pi SDK／Photon 依赖，保留 PTY 与 P2P native", () => {
	const pkg = readJson("packages/client/package.json");
	for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
		assert.doesNotMatch(dep, /@earendil-works\//);
		assert.doesNotMatch(dep, /photon/);
	}
	assert.ok(pkg.dependencies["@lydell/node-pty"], "PTY 保留");
	assert.ok(pkg.dependencies["node-datachannel"], "P2P native 保留");
	assert.doesNotMatch(pkg.scripts.dev, /build-dev-pi-bundle/);
});

test("Frontend 不再声明 Pi SDK 依赖，也不再有 pi-web 专用脚本", () => {
	const pkg = readJson("packages/frontend/package.json");
	for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
		assert.doesNotMatch(dep, /@earendil-works\//);
	}
	assert.equal(pkg.scripts["test:pi-web"], undefined);
});

test("Release 打包不再产出 Pi SDK／Bundle／会话宿主构件", () => {
	const pack = read("scripts/build/pack-release.ts");
	for (const forbidden of [
		"bundlePiSdk",
		"pi-resource-bundle",
		"pi-extension-sources",
		"PI_SDK_PACKAGE",
		"photon-node",
		"session-host",
		"agent-session-migration",
	]) {
		assert.doesNotMatch(pack, new RegExp(forbidden), `pack-release 不得再引用 ${forbidden}`);
	}
	// 基础外部依赖保留
	assert.match(pack, /@prisma\//);
});

test("bundle-apps 不再打包 Pi SDK 与 Pi fork worker", () => {
	const bundle = read("scripts/build/bundle-apps.ts");
	assert.doesNotMatch(bundle, /PI_SDK_PACKAGE/);
	assert.doesNotMatch(bundle, /photon/i);
	assert.doesNotMatch(bundle, /pi\/worker|probe-worker/);
});

test("安装脚本不再注入会话宿主命令", () => {
	for (const file of ["scripts/install-client.cjs", "scripts/install-client-linux.cjs"]) {
		const text = read(file);
		assert.doesNotMatch(text, /VCPDECK_SESSION_HOST_COMMANDS/, `${file} 不得再注入宿主命令`);
	}
});

test("专用脚本与示例已删除，基础脚本保留", () => {
	for (const gone of [
		"scripts/build-dev-pi-bundle.ts",
		"scripts/pi-resource-bundle.ts",
		"scripts/pi-extension-sources.ts",
		"scripts/port-pi-web-render.mjs",
		"scripts/ensure-dev-pi-credential-key.cjs",
		"scripts/dev-session-host-e2e.mjs",
		"examples/pi-web",
	]) {
		assert.equal(exists(gone), false, `${gone} 应已删除`);
	}
	for (const kept of [
		"scripts/install-client.cjs",
		"scripts/tests/helpers/integration-test-db.cjs",
		"scripts/tests/e2e/test.cjs",
		"scripts/tests/e2e/test-cli-capabilities.cjs",
	]) {
		assert.equal(exists(kept), true, `${kept} 应保留`);
	}
});

test("Server .env.example 不再提供 Pi 凭据密钥变量", () => {
	const env = read("packages/server/.env.example");
	assert.doesNotMatch(env, /VCPDECK_PI_CREDENTIAL_KEY_FILE/);
});
