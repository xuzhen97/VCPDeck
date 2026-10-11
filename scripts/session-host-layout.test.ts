// 会话宿主交付布局自检（实施 Plan Task 7）。
// 以 `pnpm exec tsx scripts/session-host-layout.test.ts` 运行（与 pack-release-deps.test.ts 同约定）。
//
// 只验证「不会被版本保留/打包误伤」这些可测试的布局保证；
// 真实平台 ACL、守护定义与两平台真机行为不在这里断言（见 Plan Task 7 Step 5 / Task 8）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VersionRetention } from "../packages/launcher/src/version-retention.js";
import { resolveSessionHostPaths } from "../packages/session-host/src/paths.js";
import { VARIANT_EXCLUDES, EXTERNAL_DEPS } from "./pack-release.js";

const ROOT = resolve(__dirname, "..");

let failed = 0;
function check(desc: string, fn: () => void | Promise<void>): void {
	const done = (): void => console.log(`ok - ${desc}`);
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.then(done).catch((e: unknown) => {
				failed++;
				console.error(`FAIL - ${desc}: ${e instanceof Error ? e.message : String(e)}`);
			});
			return;
		}
		done();
	} catch (e) {
		failed++;
		console.error(`FAIL - ${desc}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

check("宿主稳定目录位于版本目录之外（不含 apps/，不由版本号派生）", () => {
	const win = resolveSessionHostPaths("win32", { ProgramData: "C:\\ProgramData" });
	const linux = resolveSessionHostPaths("linux", {});
	for (const paths of [win, linux]) {
		for (const path of [paths.root, paths.stateDir, paths.runDir, paths.logDir]) {
			assert.ok(
				!path.split(/[/\\]/).includes("apps"),
				`宿主目录不得位于 apps/ 之下: ${path}`,
			);
			assert.ok(!/\d+\.\d+\.\d+/.test(path), `宿主目录不得由版本号派生: ${path}`);
		}
	}
	assert.strictEqual(win.root, "C:\\ProgramData\\VCPDeck\\session-host");
	assert.strictEqual(linux.root, "/var/lib/vcpdeck/session-host");
});

check("仅支持 Windows 与 Linux：其他平台明确失败而非猜测目录", () => {
	assert.throws(() => resolveSessionHostPaths("darwin", {}));
});

check("macOS 不进入发布变体", () => {
	assert.deepEqual(Object.keys(VARIANT_EXCLUDES).sort(), ["linux-x64", "win-x64"]);
});

check("VARIANT_EXCLUDES 不含任何 session-host 条目（宿主两平台均需存在）", () => {
	for (const [variant, excludes] of Object.entries(VARIANT_EXCLUDES)) {
		for (const entry of excludes) {
			assert.ok(
				!entry.includes("session-host"),
				`${variant} 不应排除宿主构件: ${entry}`,
			);
		}
	}
});

check("打包把宿主的原生依赖列为外部保留依赖（缺失时宿主会降级为不可用）", () => {
	for (const dep of [
		"@lydell/node-pty",
		"@lydell/node-pty-win32-x64",
		"@lydell/node-pty-linux-x64",
		"@xterm/headless",
		"@xterm/addon-serialize",
	]) {
		assert.ok(
			EXTERNAL_DEPS["session-host"].includes(dep),
			`session-host 外部依赖缺少 ${dep}`,
		);
	}
});

check("宿主目录不会被版本保留清理误删", async () => {
	const appsDir = mkdtempSync(join(tmpdir(), "vcpdeck-retention-"));
	try {
		for (const name of ["1.0.0", "2.0.0", "3.0.0", "0.9.0", "session-host"]) {
			mkdirSync(join(appsDir, name), { recursive: true });
		}
		writeFileSync(
			join(appsDir, "retention.json"),
			JSON.stringify({ successfulVersions: ["3.0.0", "2.0.0", "1.0.0"] }),
			"utf-8",
		);
		const versions = {
			currentVersion: async (): Promise<string> => "3.0.0",
			listVersions: async (): Promise<string[]> =>
				readdirSync(appsDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name),
			removeVersion: async (version: string): Promise<void> => {
				await rm(join(appsDir, version), { recursive: true, force: true });
			},
		};
		const retention = new VersionRetention({ appsDir, versions });
		const result = await retention.cleanup();
		// 清理确实执行了（历史外版本被回收），同时宿主目录与 current 都还在。
		assert.deepEqual(result.disabled, false);
		assert.ok(result.removed.includes("0.9.0"), `应回收 0.9.0，实际 ${result.removed.join(",")}`);
		assert.ok((await stat(join(appsDir, "session-host"))).isDirectory());
		assert.ok((await stat(join(appsDir, "3.0.0"))).isDirectory());
		assert.ok((await stat(join(appsDir, "2.0.0"))).isDirectory());
		assert.ok((await stat(join(appsDir, "1.0.0"))).isDirectory());
	} finally {
		rmSync(appsDir, { recursive: true, force: true });
	}
});

// 给异步 check 一点时间收敛（与 pack-release-deps.test.ts 的同步风格保持一致）。
setTimeout(() => {
	if (failed > 0) {
		console.error(`${failed} 项失败`);
		process.exit(1);
	}
	console.log("全部通过");
}, 300);
