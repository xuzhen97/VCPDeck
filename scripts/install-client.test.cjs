const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const installer = require("./install-client.cjs");

test("parseArgs 接受固定 Origin、平台和 Node", () => {
	const result = installer.parseArgs([
		"--server-origin=https://deck.example.com/path",
		"--platform=linux-x64",
		`--node=${process.execPath}`,
	]);
	assert.equal(result.serverOrigin, "https://deck.example.com");
	assert.equal(result.platform, "linux-x64");
});

test("parseArgs 拒绝不支持平台与不可用 Node", () => {
	assert.throws(
		() =>
			installer.parseArgs([
				"--server-origin=https://deck.example.com",
				"--platform=linux-arm64",
				`--node=${process.execPath}`,
			]),
		/platform/,
	);
	assert.throws(
		() =>
			installer.parseArgs([
				"--server-origin=https://deck.example.com",
				"--platform=linux-x64",
				"--node=missing-node",
			]),
		/node/,
	);
});

test("readEnv 与 normalizeOrigin 支持已有安装冲突检测", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-client-installer-"));
	try {
		mkdirSync(dir, { recursive: true });
		const env = join(dir, "launcher.env");
		writeFileSync(
			env,
			"VCPDECK_SERVER=https://old.example.com/path\nVCPDECK_PSK=secret\n",
		);
		assert.equal(
			installer.readEnv(env).VCPDECK_SERVER,
			"https://old.example.com/path",
		);
		assert.equal(
			installer.normalizeOrigin(installer.readEnv(env).VCPDECK_SERVER),
			"https://old.example.com",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
