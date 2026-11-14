import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertMuslPtyProvenance } from "../../build/pack-release.js";

const roots: string[] = [];
const PTY_PATH =
	"client/node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node";

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "musl-pty-"));
	roots.push(root);
	return root;
}

/** 写入伪造的 pty.node 与同目录 build-meta.json，返回 pty.node 的真实 SHA-256。 */
function writePty(root: string, bytes: Buffer, meta: unknown): string {
	const target = join(root, PTY_PATH);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
	writeFileSync(join(dirname(target), "build-meta.json"), JSON.stringify(meta));
	return createHash("sha256").update(bytes).digest("hex");
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("musl pty.node 来源证据", () => {
	it("没有 pty.node 时不冒充已验证", () => {
		assert.doesNotThrow(() =>
			assertMuslPtyProvenance(makeRoot(), [
				{ path: "client/dist/main.js", sha256: "a".repeat(64) },
			]),
		);
	});

	it("build-meta 的平台与 SHA 全对时通过", () => {
		const root = makeRoot();
		const bytes = Buffer.from("musl-pty-binary");
		const sha256 = writePty(root, bytes, {
			platform: "linux-x64-musl",
			role: "client",
			ptySha256: createHash("sha256").update(bytes).digest("hex"),
		});
		assert.doesNotThrow(() =>
			assertMuslPtyProvenance(root, [{ path: PTY_PATH, sha256 }]),
		);
	});

	it("缺少 build-meta.json 时拒绝", () => {
		const root = makeRoot();
		const sha256 = writePty(root, Buffer.from("x"), {
			platform: "linux-x64-musl",
			ptySha256: "x",
		});
		rmSync(join(root, dirname(PTY_PATH), "build-meta.json"));
		assert.throws(
			() => assertMuslPtyProvenance(root, [{ path: PTY_PATH, sha256 }]),
			/MUSL_PTY_UNVERIFIED: .*build-meta\.json/,
		);
	});

	it("build-meta 平台不是 musl 时拒绝", () => {
		const root = makeRoot();
		const bytes = Buffer.from("glibc-pty");
		const sha256 = writePty(root, bytes, {
			platform: "linux-x64",
			ptySha256: createHash("sha256").update(bytes).digest("hex"),
		});
		assert.throws(
			() => assertMuslPtyProvenance(root, [{ path: PTY_PATH, sha256 }]),
			/MUSL_PTY_UNVERIFIED: .*平台/,
		);
	});

	it("SHA 与 build-meta 不一致时拒绝", () => {
		const root = makeRoot();
		const bytes = Buffer.from("swapped-pty");
		const sha256 = writePty(root, bytes, {
			platform: "linux-x64-musl",
			ptySha256: "b".repeat(64),
		});
		assert.throws(
			() => assertMuslPtyProvenance(root, [{ path: PTY_PATH, sha256 }]),
			/MUSL_PTY_UNVERIFIED: .*SHA-256/,
		);
	});
});
