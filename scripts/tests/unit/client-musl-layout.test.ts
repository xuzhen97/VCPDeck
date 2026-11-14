/**
 * musl Client 构件角色过滤的单测（ADR-0065）。
 *
 * 只验证纯函数边界：musl 包是 Client-only，而不是把完整双平台包改个名字。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { includeInMuslClientArchive } from "../../build/client-musl-layout.js";

test("musl 是 Client-only 而非改名完整包", () => {
	for (const p of [
		"server/main.js",
		"server/node_modules/@prisma/client/index.js",
		"client/frps",
		"client/a.exe",
		"client/node_modules/@lydell/node-pty-win32-x64/index.js",
	]) {
		assert.equal(includeInMuslClientArchive(p), false, p);
	}
	for (const p of [
		"client/main.js",
		"client/frpc",
		"client/release-target.json",
		"launcher/main.js",
	]) {
		assert.equal(includeInMuslClientArchive(p), true, p);
	}
});

test("绝对路径与目录穿越不得进入签名清单", () => {
	assert.equal(includeInMuslClientArchive("/etc/passwd"), false);
	assert.equal(includeInMuslClientArchive("C:/Windows/system.ini"), false);
	assert.equal(includeInMuslClientArchive("client/../../etc/passwd"), false);
	assert.equal(includeInMuslClientArchive("./client/main.js"), false);
	assert.equal(includeInMuslClientArchive(""), false);
});

test("Windows 平台产物与调试符号一律排除", () => {
	for (const p of [
		"client/bin/tool.exe",
		"client/bin/tool.DLL",
		"client/native/app.pdb",
		"client/dist/frp/linux-x64/x.exe",
	]) {
		assert.equal(includeInMuslClientArchive(p), false, p);
	}
});
