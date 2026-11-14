import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const scriptPath = join(process.cwd(), "scripts", "build", "build-musl-pty.sh");
const script = readFileSync(scriptPath, "utf8");

test("musl PTY 构建脚本编译上游 node-pty 的 unix 源码，而不是空壳包目录", () => {
	assert.match(script, /src\/unix\/pty\.cc/);
	assert.doesNotMatch(script, /src\/native\//);
	assert.match(script, /-DNAPI_CPP_EXCEPTIONS/);
	assert.match(script, /node-addon-api/);
});

test("musl PTY 构建脚本固定源码与运行时版本、SHA-256", () => {
	for (const pinned of [
		'NODE_PTY_VERSION="1.2.0-beta.15"',
		'NODE_PTY_URL="https://registry.npmjs.org/node-pty/-',
		"114ac80c3fe075eff76217a4122d135576582695f49c03a5da3835cdfc2f89c5",
		'NODE_ADDON_API_VERSION="7.1.1"',
		'NODE_ADDON_API_URL="https://registry.npmjs.org/node-addon-api/-',
		"b10455d15a977c0cd17a1cb0eb679e03d939f8ef8d4302eb33e1f78dacc71f82",
	]) {
		assert.ok(script.includes(pinned), `缺少锁定值: ${pinned}`);
	}
});

test("musl PTY 构建脚本拒绝 GLIBC 并静态链接 libstdc++/libgcc", () => {
	assert.match(script, /static-libstdc\+\+/);
	assert.match(script, /static-libgcc/);
	assert.match(script, /MUSL_PTY_GLIBC_LINKED/);
	assert.match(script, /NEEDED\.\*\(GLIBC\|libstdc/);
});

test("运行时锁只接受批准的 nodejs.org 与 unofficial-builds 主机", () => {
	assert.match(script, /nodejs\\\.org\|unofficial-builds\\\.nodejs\\\.org/);
	assert.match(script, /node-v\$\{VERSION\}-linux-x64-musl\.tar\.gz/);
});
