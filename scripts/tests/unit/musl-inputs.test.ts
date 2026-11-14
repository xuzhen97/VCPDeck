/**
 * musl 构建输入锁定的单元测试（ADR-0065）。
 *
 * 只验证字节与 SHA 的对应关系以及锁文件结构，不联网、不下载真实 Node。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	loadMuslInputLock,
	MUSL_INPUT_LOCK_PATH,
	verifyPinnedBytes,
} from "../../build/musl-inputs.js";

test("下载字节必须匹配锁定 SHA", () => {
	const bytes = Buffer.from("fixture-only");
	const hash = createHash("sha256").update(bytes).digest("hex");
	assert.doesNotThrow(() => verifyPinnedBytes(bytes, hash));
	assert.throws(() => verifyPinnedBytes(Buffer.from("tampered"), hash));
});

test("锁定 SHA 格式非法时直接拒绝，不进入字节比较", () => {
	assert.throws(() => verifyPinnedBytes(Buffer.from("fixture-only"), "ABC"));
	assert.throws(() => verifyPinnedBytes(Buffer.from("fixture-only"), "a".repeat(63)));
});

test("默认锁文件路径固定在构建目录内", () => {
	assert.equal(MUSL_INPUT_LOCK_PATH, "scripts/build/musl-inputs.lock.json");
});

test("锁文件缺失时明确失败，不静默跳过 musl 构建", () => {
	assert.throws(
		() => loadMuslInputLock(path.join(os.tmpdir(), "no-such-musl-lock.json")),
		/MUSL_INPUT_LOCK_MISSING/,
	);
});

test("锁文件必须是完整的 MuslReleaseTarget 描述", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musl-lock-"));
	const file = path.join(dir, "lock.json");
	const valid = {
		schema: 1,
		platform: "linux-x64-musl",
		role: "client",
		runtime: {
			version: "24.11.1",
			url: "https://unofficial-builds.nodejs.org/download/release/v24.11.1/node-v24.11.1-linux-x64-musl.tar.gz",
			sha256: "b".repeat(64),
		},
	};
	fs.writeFileSync(file, JSON.stringify(valid));
	assert.deepEqual(loadMuslInputLock(file), valid);

	fs.writeFileSync(file, JSON.stringify({ ...valid, platform: "linux-x64" }));
	assert.throws(() => loadMuslInputLock(file));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("仓库锁文件存在、可严格解析，并锁定 Node 24 musl Client 运行时", () => {
	const lock = loadMuslInputLock(path.join(process.cwd(), MUSL_INPUT_LOCK_PATH));
	assert.equal(lock.platform, "linux-x64-musl");
	assert.equal(lock.role, "client");
	assert.match(lock.runtime.version, /^24\.\d+\.\d+$/);
	assert.match(lock.runtime.sha256, /^[a-f0-9]{64}$/);
});
