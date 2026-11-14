import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalReleaseManifestJson } from "@vcpdeck/shared";
import {
	buildFileList,
	derivePublicKeyPem,
	diffFileList,
	signManifest,
} from "../../build/release-manifest.js";

// 临时生成的 Ed25519 密钥仅存在于内存，绝不落盘、绝不使用真实凭据。
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey
	.export({ type: "pkcs8", format: "pem" })
	.toString();

const sha = (char: string): string => char.repeat(64);

const baseline = [
	{ path: "bin/app", sha256: sha("a"), size: 100, mode: 0o644 },
	{ path: "lib/core.js", sha256: sha("b"), size: 200, mode: 0o644 },
	{ path: "lib/util.js", sha256: sha("c"), size: 300, mode: 0o644 },
];

describe("buildFileList", () => {
	it("保留 name→path 与 sha256/size/mode 四项字段，并按 path 升序", () => {
		const result = buildFileList([
			{ name: "lib/core.js", sha256: sha("b"), size: 200, mode: 0o644 },
			{ name: "README.md", sha256: sha("c"), size: 5, mode: 0o755 },
			{ name: "bin/app", sha256: sha("a"), size: 100, mode: 0o755 },
		]);
		assert.deepEqual(result, [
			{ path: "README.md", sha256: sha("c"), size: 5, mode: 0o755 },
			{ path: "bin/app", sha256: sha("a"), size: 100, mode: 0o755 },
			{ path: "lib/core.js", sha256: sha("b"), size: 200, mode: 0o644 },
		]);
	});
});

describe("diffFileList", () => {
	it("新增：基线无此 path 时进入差集", () => {
		const current = [
			...baseline,
			{ path: "doc/new.txt", sha256: sha("d"), size: 10, mode: 0o644 },
		];
		assert.deepEqual(diffFileList(current, baseline), [
			{ path: "doc/new.txt", sha256: sha("d"), size: 10, mode: 0o644 },
		]);
	});

	it("内容修改：sha256 变化进入差集", () => {
		const current = [
			baseline[0],
			{ ...baseline[1], sha256: sha("e") },
			baseline[2],
		];
		assert.deepEqual(diffFileList(current, baseline), [
			{ ...baseline[1], sha256: sha("e") },
		]);
	});

	it("大小修改：size 变化进入差集", () => {
		const current = [baseline[0], { ...baseline[1], size: 999 }, baseline[2]];
		assert.deepEqual(diffFileList(current, baseline), [
			{ ...baseline[1], size: 999 },
		]);
	});

	it("权限修改：mode 由 0o644 变 0o755 进入差集", () => {
		const current = [
			baseline[0],
			baseline[1],
			{ ...baseline[2], mode: 0o755 },
		];
		assert.deepEqual(diffFileList(current, baseline), [
			{ ...baseline[2], mode: 0o755 },
		]);
	});

	it("基线多余条目（删除）不产生 delta 文件", () => {
		const current = [baseline[0], baseline[1]];
		assert.deepEqual(diffFileList(current, baseline), []);
	});

	it("与基线完全相同时生成空变更集合", () => {
		assert.deepEqual(diffFileList(baseline, baseline), []);
	});
});

describe("compareVersions / selectDeltaBaselines", () => {
	it("按数值逐段比较版本，0.9.10 高于 0.9.9", async () => {
		const { compareVersions } = await packRelease;
		assert.ok(compareVersions("0.9.10", "0.9.9") > 0);
		assert.ok(compareVersions("0.23.4", "0.24.0") < 0);
		assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
	});

	it("只挑同 variant 且版本更低的 sidecar，按版本降序最多 3 个", async () => {
		const { selectDeltaBaselines } = await packRelease;
		const names = [
			"vcpdeck-0.23.4-win-x64.manifest.json",
			"vcpdeck-0.23.3-win-x64.manifest.json",
			"vcpdeck-0.22.2-win-x64.manifest.json",
			"vcpdeck-0.21.0-win-x64.manifest.json",
			"vcpdeck-0.23.4-linux-x64.manifest.json",
			"vcpdeck-0.24.0-win-x64.manifest.json",
			"vcpdeck-0.23.4-win-x64.zip",
		];
		assert.deepEqual(selectDeltaBaselines(names, "0.24.0", "win-x64"), [
			"vcpdeck-0.23.4-win-x64.manifest.json",
			"vcpdeck-0.23.3-win-x64.manifest.json",
			"vcpdeck-0.22.2-win-x64.manifest.json",
		]);
	});

	it("当前版本与更高版本一律排除，避免自比或反向基线", async () => {
		const { selectDeltaBaselines } = await packRelease;
		assert.deepEqual(
			selectDeltaBaselines(
				[
					"vcpdeck-0.24.0-win-x64.manifest.json",
					"vcpdeck-0.25.0-win-x64.manifest.json",
				],
				"0.24.0",
				"win-x64",
			),
			[],
		);
	});
});

describe("signManifest", () => {
	const files = [
		{ path: "bin/app", sha256: sha("a"), size: 100, mode: 0o644 },
	];
	// 键序刻意不同于固定键序，确保验签基准来自规范化字节而非对象自身键序。
	const manifestA: Record<string, unknown> = {
		sha256: "",
		files,
		version: "0.24.0",
		artifacts: [],
		fromVersion: "0.23.4",
		protocolVersion: 2,
		kind: "delta",
	};
	const manifestB: Record<string, unknown> = {
		kind: "delta",
		artifacts: [],
		protocolVersion: 2,
		fromVersion: "0.23.4",
		version: "0.24.0",
		sha256: "",
		files,
	};

	it("键序不同的等价清单产出同一签名", () => {
		assert.equal(
			signManifest(manifestA, privateKeyPem),
			signManifest(manifestB, privateKeyPem),
		);
	});

	it("签名覆盖 canonicalReleaseManifestJson 规范化字节，可被 crypto.verify 接受", () => {
		const signature = Buffer.from(
			signManifest(manifestA, privateKeyPem),
			"base64",
		);
		const data = Buffer.from(canonicalReleaseManifestJson(manifestA), "utf8");
		assert.equal(verify(null, data, publicKey, signature), true);
	});

	it("篡改 files 后原签名被拒绝", () => {
		const signature = Buffer.from(
			signManifest(manifestA, privateKeyPem),
			"base64",
		);
		const tampered: Record<string, unknown> = {
			...manifestA,
			files: [{ path: "bin/app", sha256: sha("f"), size: 999, mode: 0o755 }],
		};
		const data = Buffer.from(canonicalReleaseManifestJson(tampered), "utf8");
		assert.equal(verify(null, data, publicKey, signature), false);
	});
});

describe("derivePublicKeyPem", () => {
	it("派生的公钥与密钥对公钥逐字一致，且能验证同一私钥的签名", () => {
		const derived = derivePublicKeyPem(privateKeyPem);
		assert.equal(
			derived,
			publicKey.export({ type: "spki", format: "pem" }).toString(),
		);
		const manifest: Record<string, unknown> = { version: "0.24.0", files: [] };
		const signature = Buffer.from(
			signManifest(manifest, privateKeyPem),
			"base64",
		);
		const data = Buffer.from(canonicalReleaseManifestJson(manifest), "utf8");
		assert.equal(verify(null, data, derived, signature), true);
	});

	it("非 PEM 输入直接报错，不返回可用于验签的空公钥", () => {
		assert.throws(() => derivePublicKeyPem("not-a-private-key"));
	});
});

// ---- Task 4：打包主循环接入（full .sig / delta.zip / VARIANT_EXCLUDES）----
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync as fsReadFileSync,
	rmSync,
	statSync,
	writeFileSync as fsWriteFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
	parseReleaseDeltaManifest,
	parseReleaseFileEntry,
} from "@vcpdeck/shared";

// 动态 import：导出接口尚未落地时本文件仍可加载，令 RED 精确落到用例本身。
const packRelease = import("../../build/pack-release.js");

/** 无第三方依赖的最小 ZIP 读取器：解析 EOCD + 中央目录，按 method 解压全部条目。 */
function readZipEntries(zipPath: string): Map<string, Buffer> {
	const buf = fsReadFileSync(zipPath);
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("zip 缺少 EOCD");
	const count = buf.readUInt16LE(eocd + 10);
	let ptr = buf.readUInt32LE(eocd + 16);
	const out = new Map<string, Buffer>();
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(ptr) !== 0x02014b50) {
			throw new Error("zip 中央目录签名错误");
		}
		const method = buf.readUInt16LE(ptr + 10);
		const compressedSize = buf.readUInt32LE(ptr + 20);
		const nameLen = buf.readUInt16LE(ptr + 28);
		const extraLen = buf.readUInt16LE(ptr + 30);
		const commentLen = buf.readUInt16LE(ptr + 32);
		const localOffset = buf.readUInt32LE(ptr + 42);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
		if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new Error("zip 本地文件头签名错误");
		}
		const dataStart =
			localOffset +
			30 +
			buf.readUInt16LE(localOffset + 26) +
			buf.readUInt16LE(localOffset + 28);
		const raw = buf.subarray(dataStart, dataStart + compressedSize);
		out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
		ptr += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

interface TempDirs {
	staging: string;
	outputRel: string;
	outputAbs: string;
	cleanup: () => void;
}

/** staging 放 OS 临时目录；output 用仓库内相对路径（createArchive 内部 join(ROOT, output)）。 */
function makeDirs(): TempDirs {
	const staging = mkdtempSync(join(tmpdir(), "vcpdeck-task4-stage-"));
	const outputRel = `.tmp/task4-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
	const outputAbs = join(process.cwd(), outputRel);
	return {
		staging,
		outputRel,
		outputAbs,
		cleanup: () => {
			rmSync(staging, { recursive: true, force: true });
			rmSync(outputAbs, { recursive: true, force: true });
		},
	};
}

function writeStageFile(root: string, rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	fsWriteFileSync(abs, content);
}

/** 设置私钥环境变量并在结束后恢复，避免用例间污染。 */
function withPrivateKeyEnv(
	pem: string | undefined,
	keyPath: string | undefined,
	fn: () => Promise<void>,
): Promise<void> {
	const prevPem = process.env.VCPDECK_RELEASE_PRIVATE_KEY_PEM;
	const prevPath = process.env.VCPDECK_RELEASE_PRIVATE_KEY_PATH;
	if (pem === undefined) delete process.env.VCPDECK_RELEASE_PRIVATE_KEY_PEM;
	else process.env.VCPDECK_RELEASE_PRIVATE_KEY_PEM = pem;
	if (keyPath === undefined) delete process.env.VCPDECK_RELEASE_PRIVATE_KEY_PATH;
	else process.env.VCPDECK_RELEASE_PRIVATE_KEY_PATH = keyPath;
	return fn().finally(() => {
		if (prevPem === undefined) delete process.env.VCPDECK_RELEASE_PRIVATE_KEY_PEM;
		else process.env.VCPDECK_RELEASE_PRIVATE_KEY_PEM = prevPem;
		if (prevPath === undefined) delete process.env.VCPDECK_RELEASE_PRIVATE_KEY_PATH;
		else process.env.VCPDECK_RELEASE_PRIVATE_KEY_PATH = prevPath;
	});
}

describe("collectFiles（Task 4）", () => {
	it("为每条记录补齐 sha256/size/mode，name 为 POSIX 相对路径", async () => {
		const { collectFiles } = await packRelease;
		const dirs = makeDirs();
		try {
			writeStageFile(dirs.staging, "bin/app", "hello");
			writeStageFile(dirs.staging, "lib/core.js", "core-body");
			const files = collectFiles(dirs.staging, []);
			const byName = new Map(files.map((f) => [f.name, f]));
			assert.deepEqual([...byName.keys()].sort(), ["bin/app", "lib/core.js"]);
			const app = byName.get("bin/app");
			assert.ok(app, "缺少 bin/app");
			assert.equal(
				app.sha256,
				createHash("sha256").update("hello").digest("hex"),
			);
			assert.equal(app.size, 5);
			assert.equal(app.mode, statSync(join(dirs.staging, "bin/app")).mode & 0o777);
		} finally {
			dirs.cleanup();
		}
	});

	it("与 buildFileList 组合产出四键升序清单，可直接作为 manifest.files", async () => {
		const { collectFiles } = await packRelease;
		const dirs = makeDirs();
		try {
			writeStageFile(dirs.staging, "lib/z.js", "z");
			writeStageFile(dirs.staging, "bin/a", "a");
			const list = buildFileList(collectFiles(dirs.staging, []));
			assert.deepEqual(
				list.map((f) => f.path),
				["bin/a", "lib/z.js"],
			);
			for (const entry of list) {
				assert.equal(Object.keys(entry).sort().join(","), "mode,path,sha256,size");
				assert.match(entry.sha256, /^[a-f0-9]{64}$/);
				assert.doesNotThrow(() => parseReleaseFileEntry(entry));
			}
		} finally {
			dirs.cleanup();
		}
	});

	it("仍兼容精确目录路径排除（向后兼容旧调用方式）", async () => {
		const { collectFiles } = await packRelease;
		const dirs = makeDirs();
		try {
			writeStageFile(dirs.staging, "keep/a.txt", "a");
			writeStageFile(dirs.staging, "drop/b.txt", "b");
			const names = collectFiles(dirs.staging, ["drop"]).map((f) => f.name);
			assert.deepEqual(names, ["keep/a.txt"]);
		} finally {
			dirs.cleanup();
		}
	});
});

describe("VARIANT_EXCLUDES（Task 4）", () => {
	it("win-x64 按平台族排除 linux 绑定与 .pdb，且不再逐项枚举具体包路径", async () => {
		const { VARIANT_EXCLUDES, collectFiles } = await packRelease;
		for (const rule of VARIANT_EXCLUDES["win-x64"]) {
			assert.equal(rule.includes("/"), false, `不应枚举具体目录: ${rule}`);
			assert.equal(rule.includes("@"), false, `不应枚举具体包名: ${rule}`);
		}
		const dirs = makeDirs();
		try {
			for (const rel of [
				"server/dist/frp/win-x64/frps.exe",
				"server/dist/frp/linux-x64/frps.gz",
				"server/node_modules/@libsql/win32-x64-msvc/index.js",
				"server/node_modules/@libsql/linux-x64-gnu/index.js",
				"server/node_modules/@libsql/linux-x64-musl/index.js",
				"client/node_modules/@lydell/node-pty-linux-x64/index.js",
				"client/node_modules/@lydell/node-pty-win32-x64/conpty.pdb",
				// 当前已退役 / 未来新增的对方平台原生依赖：无需改表也应被排除
				"client/node_modules/@node-datachannel/linux-x64/index.node",
				"client/node_modules/some-new-native-linux-x64/index.node",
			]) {
				writeStageFile(dirs.staging, rel, rel);
			}
			const names = collectFiles(dirs.staging, VARIANT_EXCLUDES["win-x64"]).map(
				(f) => f.name,
			);
			assert.ok(
				!names.some((n) => n.includes("linux")),
				"win-x64 包不得含 linux 平台族条目",
			);
			assert.ok(
				!names.some((n) => n.endsWith(".pdb")),
				"不得含 .pdb 调试符号",
			);
			assert.ok(names.includes("server/dist/frp/win-x64/frps.exe"));
			assert.ok(
				names.includes("server/node_modules/@libsql/win32-x64-msvc/index.js"),
			);
		} finally {
			dirs.cleanup();
		}
	});

	it("linux-x64 按平台族排除 win32/win-x64 绑定与 .pdb", async () => {
		const { VARIANT_EXCLUDES, collectFiles } = await packRelease;
		for (const rule of VARIANT_EXCLUDES["linux-x64"]) {
			assert.equal(rule.includes("/"), false, `不应枚举具体目录: ${rule}`);
			assert.equal(rule.includes("@"), false, `不应枚举具体包名: ${rule}`);
		}
		const dirs = makeDirs();
		try {
			for (const rel of [
				"server/dist/frp/linux-x64/frps.gz",
				"server/dist/frp/win-x64/frps.exe",
				"server/node_modules/@libsql/linux-x64-gnu/index.js",
				"server/node_modules/@libsql/win32-x64-msvc/index.js",
				"client/node_modules/@lydell/node-pty-linux-x64/index.js",
				"client/node_modules/@lydell/node-pty-win32-x64/conpty.pdb",
				"client/node_modules/some-new-native-win32-x64/index.node",
			]) {
				writeStageFile(dirs.staging, rel, rel);
			}
			const names = collectFiles(dirs.staging, VARIANT_EXCLUDES["linux-x64"]).map(
				(f) => f.name,
			);
			assert.ok(
				!names.some((n) => n.includes("win32") || n.includes("win-x64")),
				"linux-x64 包不得含 win 平台族条目",
			);
			assert.ok(names.includes("server/dist/frp/linux-x64/frps.gz"));
			assert.ok(
				names.includes("server/node_modules/@libsql/linux-x64-gnu/index.js"),
			);
			assert.ok(
				names.includes("client/node_modules/@lydell/node-pty-linux-x64/index.js"),
			);
		} finally {
			dirs.cleanup();
		}
	});
});

describe("createArchive（Task 4）", () => {
	it("full zip 附加 manifest.json.sig，清单字节保持且签名可验", async () => {
		const { createArchive } = await packRelease;
		const dirs = makeDirs();
		try {
			const manifest = {
				version: "0.24.0",
				nodeVersion: ">=24",
				launcherMinVersion: "0.0.0",
				sha256: "",
				launcher: { dir: "launcher", entry: "dist/main.js" },
				artifacts: {
					server: { dir: "server", entry: "dist/main.js" },
					client: { dir: "client", entry: "dist/index.js" },
				},
				protocolVersion: 2,
				files: [
					{ path: "bin/app", sha256: sha("a"), size: 3, mode: 0o644 },
					{ path: "launcher/dist/main.js", sha256: sha("b"), size: 3, mode: 0o644 },
				],
			};
			const manifestBytes = JSON.stringify(manifest, null, 2);
			writeStageFile(dirs.staging, "manifest.json", manifestBytes);
			writeStageFile(dirs.staging, "bin/app", "app");
			writeStageFile(dirs.staging, "launcher/dist/main.js", "ldr");
			await withPrivateKeyEnv(privateKeyPem, undefined, async () => {
				const zipPath = await createArchive(
					dirs.staging,
					"0.24.0",
					dirs.outputRel,
					"win-x64",
				);
				assert.equal(
					zipPath,
					join(process.cwd(), dirs.outputRel, "vcpdeck-0.24.0-win-x64.zip"),
				);
				const entries = readZipEntries(zipPath);
				const names = [...entries.keys()]
					.filter((n) => !n.endsWith("/"))
					.sort();
				assert.deepEqual(names, [
					"bin/app",
					"launcher/dist/main.js",
					"manifest.json",
					"manifest.json.sig",
				]);
				assert.equal(entries.get("manifest.json")?.toString("utf8"), manifestBytes);
				// 同版本 sidecar 清单与 zip 平级落盘，供后续版本求差集。
				const sidecar = JSON.parse(
					fsReadFileSync(
						join(process.cwd(), dirs.outputRel, "vcpdeck-0.24.0-win-x64.manifest.json"),
						"utf8",
					),
				) as { files: unknown[]; version: string };
				assert.equal(sidecar.version, "0.24.0");
				assert.equal(sidecar.files.length, 2);
				const parsed = JSON.parse(manifestBytes);
				assert.equal(parsed.sha256, "");
				assert.equal(parsed.protocolVersion, 2);
				for (const key of [
					"version",
					"nodeVersion",
					"launcherMinVersion",
					"launcher",
					"artifacts",
				]) {
					assert.ok(Object.hasOwn(parsed, key), `缺少旧格式键: ${key}`);
				}
				assert.equal(parsed.files.length, 2);
				const sig = Buffer.from(
					entries.get("manifest.json.sig")?.toString("utf8").trim() ?? "",
					"base64",
				);
				assert.equal(sig.length, 64);
				assert.equal(
					verify(
						null,
						Buffer.from(canonicalReleaseManifestJson(parsed), "utf8"),
						publicKey,
						sig,
					),
					true,
				);
			});
		} finally {
			dirs.cleanup();
		}
	});

	it("缺少私钥时抛明确错误，不生成未签名发布包", async () => {
		const { createArchive } = await packRelease;
		const dirs = makeDirs();
		try {
			writeStageFile(
				dirs.staging,
				"manifest.json",
				JSON.stringify({ version: "0.24.0", sha256: "" }),
			);
			await withPrivateKeyEnv(undefined, undefined, async () => {
				await assert.rejects(
					() =>
						createArchive(dirs.staging, "0.24.0", dirs.outputRel, "win-x64"),
					(err: unknown) => {
						assert.ok(err instanceof Error);
						assert.match(err.message, /VCPDECK_RELEASE_PRIVATE_KEY/);
						return true;
					},
				);
			});
		} finally {
			dirs.cleanup();
		}
	});

	it("支持 VCPDECK_RELEASE_PRIVATE_KEY_PATH 指向的 pem 文件", async () => {
		const { createArchive } = await packRelease;
		const dirs = makeDirs();
		const keyDir = mkdtempSync(join(tmpdir(), "vcpdeck-task4-key-"));
		const keyFile = join(keyDir, "release.pem");
		fsWriteFileSync(keyFile, privateKeyPem);
		try {
			writeStageFile(
				dirs.staging,
				"manifest.json",
				JSON.stringify({
					version: "0.24.0",
					sha256: "",
					protocolVersion: 2,
					files: [],
				}),
			);
			await withPrivateKeyEnv(undefined, keyFile, async () => {
				const zipPath = await createArchive(
					dirs.staging,
					"0.24.0",
					dirs.outputRel,
					"win-x64",
				);
				const entries = readZipEntries(zipPath);
				const sig = Buffer.from(
					entries.get("manifest.json.sig")?.toString("utf8").trim() ?? "",
					"base64",
				);
				assert.equal(sig.length, 64);
				assert.equal(
					verify(
						null,
						Buffer.from(
							canonicalReleaseManifestJson(
								JSON.parse(entries.get("manifest.json")!.toString("utf8")),
							),
							"utf8",
						),
						publicKey,
						sig,
					),
					true,
				);
			});
		} finally {
			rmSync(keyDir, { recursive: true, force: true });
			dirs.cleanup();
		}
	});
});

describe("createDeltaArchive（Task 4）", () => {
	it("条目集合 = 变更集 + delta.json + delta.json.sig，内容取自当前 staging", async () => {
		const { collectFiles, createDeltaArchive } = await packRelease;
		const dirs = makeDirs();
		try {
			writeStageFile(dirs.staging, "bin/app", "app-v2");
			writeStageFile(dirs.staging, "lib/core.js", "core-v2-longer");
			writeStageFile(dirs.staging, "lib/util.js", "util");
			writeStageFile(dirs.staging, "doc/new.txt", "new");
			const current = buildFileList(collectFiles(dirs.staging, []));
			const app = current.find((f) => f.path === "bin/app")!;
			const core = current.find((f) => f.path === "lib/core.js")!;
			const util = current.find((f) => f.path === "lib/util.js")!;
			const baseline = [
				{ ...app, mode: app.mode === 0o644 ? 0o755 : 0o644 }, // 仅权限变化
				{ ...core, sha256: sha("z") }, // 仅内容变化
				{ path: "lib/old.js", sha256: sha("d"), size: 3, mode: 0o644 }, // 基线多余（删除）
				util, // 完全相同
			];
			const changed = diffFileList(current, baseline);
			assert.deepEqual(
				changed.map((f) => f.path),
				["bin/app", "doc/new.txt", "lib/core.js"],
			);
			const manifest: Record<string, unknown> = {
				version: "0.24.0",
				protocolVersion: 2,
				kind: "delta",
				fromVersion: "0.23.4",
				files: current,
			};
			const zipPath = await createDeltaArchive({
				stagingDir: dirs.staging,
				version: "0.24.0",
				output: dirs.outputRel,
				variant: "win-x64",
				fromVersion: "0.23.4",
				changedFiles: changed,
				manifest,
				privateKeyPem,
			});
			assert.equal(
				zipPath,
				join(
					process.cwd(),
					dirs.outputRel,
					"vcpdeck-0.24.0-win-x64-delta-0.23.4.zip",
				),
			);
			const entries = readZipEntries(zipPath);
			const names = [...entries.keys()].filter((n) => !n.endsWith("/")).sort();
			assert.deepEqual(names, [
				"bin/app",
				"delta.json",
				"delta.json.sig",
				"doc/new.txt",
				"lib/core.js",
			]);
			assert.equal(entries.get("doc/new.txt")?.toString("utf8"), "new");
			assert.equal(
				entries.get("lib/core.js")?.toString("utf8"),
				"core-v2-longer",
			);
			assert.equal(entries.get("bin/app")?.toString("utf8"), "app-v2");
			assert.equal(entries.has("lib/util.js"), false);
			assert.equal(entries.has("lib/old.js"), false);
			const deltaJson = entries.get("delta.json")?.toString("utf8") ?? "";
			assert.equal(deltaJson, JSON.stringify(manifest));
			assert.doesNotThrow(() =>
				parseReleaseDeltaManifest(JSON.parse(deltaJson)),
			);
			const sig = Buffer.from(
				entries.get("delta.json.sig")?.toString("utf8").trim() ?? "",
				"base64",
			);
			assert.equal(sig.length, 64);
			assert.equal(
				verify(
					null,
					Buffer.from(canonicalReleaseManifestJson(manifest), "utf8"),
					publicKey,
					sig,
				),
				true,
			);
		} finally {
			dirs.cleanup();
		}
	});

	it("空变更集合时仅产元数据条目，不夹带任何清单文件", async () => {
		const { createDeltaArchive } = await packRelease;
		const dirs = makeDirs();
		try {
			writeStageFile(dirs.staging, "lib/util.js", "util");
			const manifest: Record<string, unknown> = {
				version: "0.24.0",
				protocolVersion: 2,
				kind: "delta",
				fromVersion: "0.23.4",
				files: [],
			};
			const zipPath = await createDeltaArchive({
				stagingDir: dirs.staging,
				version: "0.24.0",
				output: dirs.outputRel,
				variant: "linux-x64",
				fromVersion: "0.23.4",
				changedFiles: [],
				manifest,
				privateKeyPem,
			});
			assert.match(zipPath, /vcpdeck-0\.24\.0-linux-x64-delta-0\.23\.4\.zip$/);
			const names = [...readZipEntries(zipPath).keys()]
				.filter((n) => !n.endsWith("/"))
				.sort();
			assert.deepEqual(names, ["delta.json", "delta.json.sig"]);
		} finally {
			dirs.cleanup();
		}
	});
});

// ---- Task 4 收尾：createArchive 按 variant 生成自洽清单 ----
import { gzipSync } from "node:zlib";

/** Launcher 对 full 包先移出 manifest.json 再预检，.sig 属元数据白名单；两者都不计入文件集合。 */
function nonMetadataNames(entries: Map<string, Buffer>): string[] {
	return [...entries.keys()]
		.filter((name) => !name.endsWith("/"))
		.filter((name) => name !== "manifest.json" && name !== "manifest.json.sig")
		.sort();
}

/** 用包内 manifest.json 的解析结果验证包内 manifest.json.sig。 */
function verifyZipManifest(entries: Map<string, Buffer>): boolean {
	const parsed = JSON.parse(
		entries.get("manifest.json")?.toString("utf8") ?? "{}",
	);
	const signature = Buffer.from(
		entries.get("manifest.json.sig")?.toString("utf8").trim() ?? "",
		"base64",
	);
	return verify(
		null,
		Buffer.from(canonicalReleaseManifestJson(parsed), "utf8"),
		publicKey,
		signature,
	);
}

/** 模拟 main() 产物：全平台合集清单 + 两族专属文件 + linux 裸 ELF 的 gz 源。 */
async function makeVariantStage(): Promise<{
	dirs: TempDirs;
	manifestBytes: string;
	elfs: Map<string, Buffer>;
}> {
	const { collectFiles } = await packRelease;
	const dirs = makeDirs();
	const elfs = new Map<string, Buffer>([
		["client/dist/frp/linux-x64/frpc", Buffer.from("FRPC-ELF")],
		["server/dist/frp/linux-x64/frps", Buffer.from("FRPS-ELF-LONGER")],
	]);
	writeStageFile(dirs.staging, "bin/app", "app");
	writeStageFile(dirs.staging, "launcher/dist/main.js", "ldr");
	writeStageFile(dirs.staging, "bin/app.pdb", "pdb");
	writeStageFile(dirs.staging, "server/dist/frp/win-x64/frps.exe", "win-exe");
	writeStageFile(
		dirs.staging,
		"server/node_modules/@lydell/node-pty-win32-x64/product.node",
		"win-native",
	);
	writeStageFile(
		dirs.staging,
		"server/node_modules/@libsql/linux-x64-gnu/binding.node",
		"linux-native",
	);
	for (const [entry, payload] of elfs) {
		const gzAbs = join(dirs.staging, `${entry}.gz`);
		mkdirSync(dirname(gzAbs), { recursive: true });
		fsWriteFileSync(gzAbs, gzipSync(payload));
	}
	// 写 manifest.json 之前收集，模拟 main() 的 collectFiles(stagingDir, []) 全平台合集。
	const manifestBytes = JSON.stringify(
		{
			version: "0.24.0",
			nodeVersion: ">=24",
			launcherMinVersion: "0.0.0",
			sha256: "",
			launcher: { dir: "launcher", entry: "dist/main.js" },
			artifacts: {
				server: { dir: "server", entry: "dist/main.js" },
				client: { dir: "client", entry: "dist/index.js" },
			},
			protocolVersion: 2,
			files: buildFileList(collectFiles(dirs.staging, [])),
		},
		null,
		2,
	);
	writeStageFile(dirs.staging, "manifest.json", manifestBytes);
	return { dirs, manifestBytes, elfs };
}

describe("createArchive 按 variant 自洽清单（Task 4 收尾）", () => {
	it("win-x64 清单与包内非元数据条目双向互等，且不含 linux 专属路径", async () => {
		const { createArchive } = await packRelease;
		const { dirs, manifestBytes } = await makeVariantStage();
		try {
			await withPrivateKeyEnv(privateKeyPem, undefined, async () => {
				const zipPath = await createArchive(
					dirs.staging,
					"0.24.0",
					dirs.outputRel,
					"win-x64",
				);
				const entries = readZipEntries(zipPath);
				const manifestJson =
					entries.get("manifest.json")?.toString("utf8") ?? "";
				const parsed = JSON.parse(manifestJson);
				const listed = new Set(
					(parsed.files as Array<{ path: string }>).map((file) => file.path),
				);
				const packed = new Set(nonMetadataNames(entries));
				// 排序数组相等同时约束长度与元素，即双向严格互等。
				assert.deepEqual([...listed].sort(), [...packed].sort());
				assert.ok(packed.has("bin/app"));
				assert.ok(packed.has("server/dist/frp/win-x64/frps.exe"));
				assert.equal(
					packed.has("server/node_modules/@libsql/linux-x64-gnu/binding.node"),
					false,
				);
				for (const path of listed) {
					assert.equal(
						path.split("/").some((seg) => seg.includes("linux")),
						false,
						`win 清单不应含 linux 专属路径: ${path}`,
					);
				}
				for (const key of [
					"version",
					"nodeVersion",
					"launcherMinVersion",
					"launcher",
					"artifacts",
					"protocolVersion",
					"files",
					"sha256",
				]) {
					assert.ok(Object.hasOwn(parsed, key), `缺少清单键: ${key}`);
				}
				assert.equal(parsed.protocolVersion, 2);
				assert.equal(parsed.sha256, "");
				assert.equal(verifyZipManifest(entries), true);
				// 包内清单按 variant 生成，不应再等于磁盘那份全平台合集。
				assert.notEqual(manifestJson, manifestBytes);
			});
		} finally {
			dirs.cleanup();
		}
	});

	it("linux-x64 清单与包内非元数据条目双向互等，2 个裸 ELF 元信息正确", async () => {
		const { createArchive } = await packRelease;
		const { dirs, elfs } = await makeVariantStage();
		try {
			await withPrivateKeyEnv(privateKeyPem, undefined, async () => {
				const zipPath = await createArchive(
					dirs.staging,
					"0.24.0",
					dirs.outputRel,
					"linux-x64",
				);
				const entries = readZipEntries(zipPath);
				const parsed = JSON.parse(
					entries.get("manifest.json")?.toString("utf8") ?? "{}",
				);
				const files = parsed.files as Array<{
					path: string;
					sha256: string;
					size: number;
					mode: number;
				}>;
				const listed = new Set(files.map((file) => file.path));
				const packed = new Set(nonMetadataNames(entries));
				assert.deepEqual([...listed].sort(), [...packed].sort());
				for (const [entry, payload] of elfs) {
					const listedElf = files.find((file) => file.path === entry);
					assert.ok(listedElf, `裸 ELF 应在清单内: ${entry}`);
					assert.equal(
						listedElf.sha256,
						createHash("sha256").update(payload).digest("hex"),
					);
					assert.equal(listedElf.size, payload.length);
					assert.equal(listedElf.mode, 0o755);
					assert.deepEqual(entries.get(entry), payload);
				}
				for (const path of listed) {
					assert.equal(
						path
							.split("/")
							.some((seg) => seg.includes("win32") || seg.includes("win-x64")),
						false,
						`linux 清单不应含 win 专属路径: ${path}`,
					);
				}
				assert.equal(verifyZipManifest(entries), true);
			});
		} finally {
			dirs.cleanup();
		}
	});

	it("两份包 manifest.json 字节不同，且签名各自绑定对应 variantManifest", async () => {
		const { createArchive } = await packRelease;
		const { dirs } = await makeVariantStage();
		try {
			await withPrivateKeyEnv(privateKeyPem, undefined, async () => {
				const winEntries = readZipEntries(
					await createArchive(
						dirs.staging,
						"0.24.0",
						dirs.outputRel,
						"win-x64",
					),
				);
				const linuxEntries = readZipEntries(
					await createArchive(
						dirs.staging,
						"0.24.0",
						dirs.outputRel,
						"linux-x64",
					),
				);
				const winJson = winEntries.get("manifest.json")?.toString("utf8") ?? "";
				const linuxJson =
					linuxEntries.get("manifest.json")?.toString("utf8") ?? "";
				assert.notEqual(winJson, linuxJson);
				assert.equal(verifyZipManifest(winEntries), true);
				assert.equal(verifyZipManifest(linuxEntries), true);
				const winSig = Buffer.from(
					winEntries.get("manifest.json.sig")?.toString("utf8").trim() ?? "",
					"base64",
				);
				assert.equal(
					verify(
						null,
						Buffer.from(
							canonicalReleaseManifestJson(JSON.parse(linuxJson)),
							"utf8",
						),
						publicKey,
						winSig,
					),
					false,
				);
			});
		} finally {
			dirs.cleanup();
		}
	});
});

describe("buildDeltas（增量包基线选择与差集）", () => {
	const baselineFiles = [
		{ path: "bin/app", sha256: sha("a"), size: 3, mode: 0o644 },
		{ path: "lib/core.js", sha256: sha("b"), size: 4, mode: 0o644 },
	];

	it("按历史 sidecar 求差集，delta.zip 只含变更文件与 delta.json(.sig)", async () => {
		const { buildDeltas } = await packRelease;
		const dirs = makeDirs();
		try {
			// 历史版本的 sidecar 清单（基线）；旧格式 zip 内 manifest 无 files，只能靠它。
			mkdirSync(dirs.outputAbs, { recursive: true });
			fsWriteFileSync(
				join(dirs.outputAbs, "vcpdeck-0.23.4-win-x64.manifest.json"),
				JSON.stringify({ version: "0.23.4", files: baselineFiles }),
			);
			// 当前 staging：bin/app 变更、lib/core.js 不变、新增 doc/new.txt。
			writeStageFile(dirs.staging, "bin/app", "app2");
			writeStageFile(dirs.staging, "lib/core.js", "core");
			writeStageFile(dirs.staging, "doc/new.txt", "new");
			const deltaPaths = await buildDeltas({
				stagingDir: dirs.staging,
				version: "0.24.0",
				output: dirs.outputRel,
				variant: "win-x64",
				targetFiles: [
					{ path: "bin/app", sha256: sha("c"), size: 4, mode: 0o644 },
					{ path: "doc/new.txt", sha256: sha("d"), size: 3, mode: 0o644 },
					{ path: "lib/core.js", sha256: sha("b"), size: 4, mode: 0o644 },
				],
				fullSize: 10_000,
				privateKeyPem,
			});

			assert.equal(deltaPaths.length, 1);
			assert.match(
				deltaPaths[0],
				/vcpdeck-0\.24\.0-win-x64-delta-0\.23\.4\.zip$/,
			);
			const entries = readZipEntries(deltaPaths[0]);
			assert.deepEqual(
				[...entries.keys()].filter((n) => !n.endsWith("/")).sort(),
				["bin/app", "delta.json", "delta.json.sig", "doc/new.txt"],
			);
			const deltaManifest = parseReleaseDeltaManifest(
				JSON.parse(entries.get("delta.json")?.toString("utf8") ?? ""),
			);
			assert.equal(deltaManifest.kind, "delta");
			assert.equal(deltaManifest.fromVersion, "0.23.4");
			// 清单必须是完整目标清单：Launcher 据此从基线硬链接未变更文件。
			assert.deepEqual(deltaManifest.files, [
				{ path: "bin/app", sha256: sha("c"), size: 4, mode: 0o644 },
				{ path: "doc/new.txt", sha256: sha("d"), size: 3, mode: 0o644 },
				{ path: "lib/core.js", sha256: sha("b"), size: 4, mode: 0o644 },
			]);
		} finally {
			dirs.cleanup();
		}
	});

	it("与基线一致、或变更量不小于全量包时跳过，不产 delta", async () => {
		const { buildDeltas } = await packRelease;
		const dirs = makeDirs();
		try {
			mkdirSync(dirs.outputAbs, { recursive: true });
			fsWriteFileSync(
				join(dirs.outputAbs, "vcpdeck-0.23.4-win-x64.manifest.json"),
				JSON.stringify({ version: "0.23.4", files: baselineFiles }),
			);
			const baseOpts = {
				stagingDir: dirs.staging,
				version: "0.24.0",
				output: dirs.outputRel,
				variant: "win-x64" as const,
				fullSize: 100,
				privateKeyPem,
			};
			assert.deepEqual(
				await buildDeltas({ ...baseOpts, targetFiles: baselineFiles }),
				[],
			);
			assert.deepEqual(
				await buildDeltas({
					...baseOpts,
					targetFiles: [{ ...baselineFiles[0], sha256: sha("e"), size: 9999 }],
				}),
				[],
			);
		} finally {
			dirs.cleanup();
		}
	});
});

describe("createMuslClientArchive（Task 4）", () => {
	it("musl zip 只含 Client 角色、只注入 frpc，清单与签名自洽", async () => {
		const { createMuslClientArchive, selectDeltaBaselines } = await packRelease;
		const dirs = makeDirs();
		try {
			const manifest = {
				version: "0.24.0",
				nodeVersion: ">=24",
				launcherMinVersion: "0.0.0",
				sha256: "",
				launcher: { dir: "launcher", entry: "dist/main.js" },
				artifacts: {
					server: { dir: "server", entry: "dist/main.js" },
					client: { dir: "client", entry: "dist/index.js" },
				},
				protocolVersion: 2,
				files: [],
			};
			writeStageFile(dirs.staging, "manifest.json", JSON.stringify(manifest, null, 2));
			writeStageFile(dirs.staging, "client/dist/index.js", "client");
			writeStageFile(dirs.staging, "launcher/dist/main.js", "launcher");
			writeStageFile(dirs.staging, "server/dist/main.js", "server");
			writeStageFile(dirs.staging, "client/a.exe", "exe");
			mkdirSync(join(dirs.staging, "client/dist/frp/linux-x64"), {
				recursive: true,
			});
			fsWriteFileSync(
				join(dirs.staging, "client/dist/frp/linux-x64/frpc.gz"),
				gzipSync(Buffer.from("FRPC-BINARY")),
			);
			await withPrivateKeyEnv(privateKeyPem, undefined, async () => {
				const zipPath = await createMuslClientArchive(
					dirs.staging,
					"0.24.0",
					dirs.outputRel,
				);
				assert.equal(
					zipPath,
					join(
						process.cwd(),
						dirs.outputRel,
						"vcpdeck-0.24.0-linux-x64-musl.zip",
					),
				);
				const entries = readZipEntries(zipPath);
				const names = [...entries.keys()].filter((n) => !n.endsWith("/")).sort();
				assert.deepEqual(names, [
					"client/dist/frp/linux-x64/frpc",
					"client/dist/index.js",
					"client/release-target.json",
					"launcher/dist/main.js",
					"manifest.json",
					"manifest.json.sig",
				]);
				assert.equal(
					entries.get("client/dist/frp/linux-x64/frpc")?.toString(),
					"FRPC-BINARY",
				);
				const packedManifest = JSON.parse(
					entries.get("manifest.json")?.toString("utf8") ?? "{}",
				) as {
					artifacts: Record<string, unknown>;
					files: Array<{ path: string; sha256: string }>;
				};
				assert.deepEqual(Object.keys(packedManifest.artifacts), ["client"]);
				assert.equal(
					packedManifest.files.some((f) => f.path.startsWith("server/")),
					false,
				);
				const descriptorContent =
					entries.get("client/release-target.json")?.toString("utf8") ?? "";
				const descriptor = packedManifest.files.find(
					(f) => f.path === "client/release-target.json",
				);
				assert.equal(
					descriptor?.sha256,
					createHash("sha256").update(descriptorContent).digest("hex"),
				);
				// 描达文件只能描述 musl Client，不得被旧平台包复用。
				const parsedDescriptor = JSON.parse(descriptorContent) as {
					platform: string;
					role: string;
				};
				assert.equal(parsedDescriptor.platform, "linux-x64-musl");
				assert.equal(parsedDescriptor.role, "client");
				const signature = Buffer.from(
					entries.get("manifest.json.sig")?.toString("utf8") ?? "",
					"base64",
				);
				assert.equal(
					verify(
						null,
						Buffer.from(canonicalReleaseManifestJson(packedManifest), "utf8"),
						publicKey,
						signature,
					),
					true,
				);
				const sidecar = JSON.parse(
					fsReadFileSync(
						join(
							process.cwd(),
							dirs.outputRel,
							"vcpdeck-0.24.0-linux-x64-musl.manifest.json",
						),
						"utf8",
					),
				) as { files: unknown[] };
				assert.deepEqual(sidecar.files, packedManifest.files);
				// musl sidecar 不能成为双平台 delta 的基线。
				assert.deepEqual(
					selectDeltaBaselines(
						["vcpdeck-0.24.0-linux-x64-musl.manifest.json"],
						"0.25.0",
						"linux-x64",
					),
					[],
				);
			});
		} finally {
			dirs.cleanup();
		}
	});
});
