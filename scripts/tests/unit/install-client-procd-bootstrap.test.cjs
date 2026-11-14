/**
 * Task 7/修复：procd 一键安装引导脚本的静态契约测试。
 *
 * 平台判定与安装编排都在 node 侧（可测），shell 只负责取预检/引导信息、
 * 校验 SHA-256 并调用 node 安装器；旧 glibc/systemd 引导脚本不得被新路径污染。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "../../..");
const scriptPath = path.join(ROOT, "scripts/install-client-procd-bootstrap.sh");

test("procd 引导脚本存在且 bash -n 通过", () => {
	assert.ok(fs.existsSync(scriptPath), "scripts/install-client-procd-bootstrap.sh 应存在");
	const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
});

test("平台判定交给 node 校验器，旧引导脚本不引用新路径", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	assert.match(source, /install-client-procd\.cjs/);
	assert.match(source, /check-platform/);
	assert.doesNotMatch(source, /opkg install/);
	const legacy = fs.readFileSync(
		path.join(ROOT, "scripts/install-client-bootstrap.sh"),
		"utf8",
	);
	assert.doesNotMatch(legacy, /install-client-procd/);
});

test("引导脚本要求 root、取预检与引导端，并在平台校验后才下载大构件", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	assert.match(source, /\[ "\$\(id -u\)" -eq 0 \] \|\| fail "PROCD_ROOT_REQUIRED"/);
	assert.match(source, /preflight\?platform=linux-x64-musl/);
	assert.match(source, /-X POST/);
	assert.match(source, /\{"platform":"linux-x64-musl"\}/);
	const platformAt = source.indexOf("--check-platform");
	const zipAt = source.indexOf("ARCHIVE_URL=");
	assert.ok(platformAt > 0, "必须先做平台校验");
	assert.ok(zipAt > platformAt, "平台校验必须早于发布包下载");
});

test("发布包与 Node 运行时都先按 SHA-256 校验再解压", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	assert.match(source, /fetch_verified "\$ORIGIN\$ARCHIVE_URL"/);
	assert.match(source, /fetch_verified "\$RUNTIME_URL"/);
	assert.match(source, /sha256sum "\$2"/);
	// Node 运行时来自安装包内的签名描述符，而不是外部环境变量。
	assert.match(source, /client\/release-target\.json/);
	assert.match(source, /runtime\.sha256/);
});

test("辅助模块逐个按 preflight 下发的 SHA-256 校验后才落盘执行", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	// 这些模块会以 root 运行，不能只依赖 TLS 同源。
	assert.match(source, /value\.procdAssets/);
	assert.match(source, /fetch_verified "\$ORIGIN\/api\/client-installer\/assets\/\$asset" "\$WORK\/\$asset" "\$sha"/);
	assert.doesNotMatch(source, /fetch "\$ORIGIN\/api\/client-installer\/assets\/\$asset"/);
});

test("下载失败与校验失败只输出稳定 code，且不把 curl 输出接到终端", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	assert.match(source, /curl -fsSL[^\n]*-o "\$2"/);
	for (const code of [
		"PROCD_DOWNLOAD_FAILED",
		"PROCD_ASSET_SHA256_MISMATCH",
		"PROCD_PLATFORM_UNSUPPORTED",
		"PROCD_ROOT_REQUIRED",
		"PROCD_PREFLIGHT_FAILED",
		"PROCD_BOOTSTRAP_FAILED",
		"PROCD_RELEASE_TARGET_MISSING",
	]) {
		assert.match(source, new RegExp(code), code);
	}
});

test("引导脚本不把下载 URL 或 PSK 打到 stdout/stderr", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	assert.doesNotMatch(source, /echo[^\n]*\$URL/);
	assert.doesNotMatch(source, /printf[^\n]*\$URL/);
	assert.doesNotMatch(source, /echo[^\n]*\$VCPDECK_PSK/);
	assert.doesNotMatch(source, /echo[^\n]*\$PSK/);
	assert.doesNotMatch(source, /printf[^\n]*\$PSK/);
});

test("引导脚本要求系统 Node ≥ 20，缺失时在下载大构件前失败", () => {
	const source = fs.readFileSync(scriptPath, "utf8");
	assert.match(source, /process\.versions\.node\.split\("\."\)\[0\]/);
	assert.match(source, /PROCD_TOOL_MISSING: node>=20/);
	assert.ok(
		source.indexOf("PROCD_TOOL_MISSING: node>=20") <
			source.indexOf("api/client-installer/preflight"),
		"Node 版本检查必须先于预检请求",
	);
});
