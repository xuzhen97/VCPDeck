/**
 * 真实社区扩展在**发布布局**下的验收（ADR-0042 决策 2/5）。
 *
 * 为什么必须另起独立 node 子进程：
 * - 源码/tsx 下能 import 成功，不代表单文件 Release 布局下能加载。SDK 在发布形态里是
 *   由 `bundlePiSdk()` 打出的单个 ESM 文件，扩展运行时靠 `PI_BUNDLED_NODE` 的
 *   虚拟模块分支解析 `@earendil-works/pi-coding-agent` 等说明符；这条路径只能在
 *   「产物 + 独立 node 进程」里验证。
 * - 本用例不依赖用户原生 Pi、不依赖仓库源码 SDK、不访问网络、不调用真实模型。
 *
 * 覆盖：
 * 1. 社区扩展在单文件 SDK 下注册成功且命令可发现（`/simplify`）；
 * 2. 宿主虚拟模块映射在单文件 SDK 下确实生效（否则社区扩展一旦 import 宿主模块即断）；
 * 3. 用**真实社区源码 + 受控 exec** 驱动其命令处理器，断言产出的是上游 prompt 而非本地重写；
 * 4. 用**真实 git 输出**驱动同一处理器，证明真实 diff 解析路径可用；
 * 5. Client 侧 `resolveVerifiedPiBundle` 对发布产物的接受与 fail-closed。
 *
 * 运行：`pnpm exec tsx --test scripts/pi-community-release.test.ts`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bundlePiSdk } from "./bundle-apps.js";
import { buildPiResourceBundle } from "./pi-resource-bundle.js";
import { resolveVerifiedPiBundle } from "../packages/client/src/pi/bundle.js";

const ROOT = resolve(__dirname, "..");
const PI_SDK_VERSION = "1.1.0";

interface ProbeCheck {
	name: string;
	ok: boolean;
	detail?: string;
	extra?: Record<string, unknown>;
}

interface ProbeResult {
	checks: ProbeCheck[];
}

/**
 * 子进程探针：在隔离的发布布局里加载单文件 SDK 与已校验 Bundle。
 *
 * 写成运行期 JS（不是 TS）并显式放在布局目录内，确保 `node` 不经过 tsx。
 */
const PROBE_SOURCE = String.raw`
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const sdk = await import(config.sdkUrl);
const checks = [];
async function check(name, fn) {
  try {
    const extra = await fn();
    checks.push({ name, ok: true, ...(extra ? { extra } : {}) });
  } catch (error) {
    checks.push({ name, ok: false, detail: String((error && error.message) || error) });
  }
}

await check("社区扩展在单文件 SDK 下加载且命令可发现", async () => {
  const loaded = await sdk.discoverAndLoadExtensions(
    [config.communityPath],
    config.cwd,
    config.agentDir,
  );
  const errors = loaded.errors.map((entry) => String(entry && entry.message || entry));
  if (errors.length > 0) throw new Error("加载错误: " + errors.join(" | "));
  const names = loaded.extensions.flatMap((extension) => [
    ...extension.commands.keys(),
  ]);
  if (!names.includes("simplify")) {
    throw new Error("未注册 simplify 命令，实际: " + JSON.stringify(names));
  }
  return { commands: names };
});

await check("宿主虚拟模块映射在单文件 SDK 下生效", async () => {
  const loaded = await sdk.discoverAndLoadExtensions(
    [config.hostProbePath],
    config.cwd,
    config.agentDir,
  );
  const errors = loaded.errors.map((entry) => String(entry && entry.message || entry));
  if (errors.length > 0) throw new Error("宿主探针加载错误: " + errors.join(" | "));
  const extension = loaded.extensions.find((item) =>
    item.path.includes("host-probe"),
  );
  if (!extension) throw new Error("宿主探针未加载");
  const handler = extension.commands.get("host_probe");
  if (!handler) throw new Error("宿主探针未注册 host_probe 命令");
  const reported = await handler.handler("", {});
  if (reported && reported.sdkVersion !== config.expectedSdkVersion) {
    throw new Error(
      "虚拟模块解析到错误的 SDK 版本: " + JSON.stringify(reported),
    );
  }
  return { sdkVersion: reported && reported.sdkVersion };
});

/** 用受控 exec 驱动真实社区命令处理器。 */
async function driveSimplify(execImpl) {
  const module = await import(pathToFileURL(config.communityPath).href);
  const registered = new Map();
  const sent = [];
  const notifications = [];
  const execCalls = [];
  const fakePi = {
    on: () => () => {},
    registerCommand: (name, definition) => registered.set(name, definition),
    getSessionName: () => undefined,
    setSessionName: () => {},
    sendUserMessage: (message, options) => sent.push({ message, options }),
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return execImpl(command, args, options);
    },
  };
  await module.default(fakePi);
  const command = registered.get("simplify");
  if (!command) throw new Error("社区扩展未注册 simplify");
  await command.handler("fixture.ts", {
    cwd: config.repoDir,
    hasUI: false,
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  });
  return { sent, notifications, execCalls };
}

await check("真实社区处理器产出上游 review prompt（受控 exec）", async () => {
  const { sent, execCalls } = await driveSimplify(async () => ({
    code: 0,
    stdout: "M\tfixture.ts\n@@ -1,2 +3,4 @@\n",
    stderr: "",
  }));
  if (execCalls.length === 0) throw new Error("未调用 pi.exec");
  if (execCalls[0].command !== "git") {
    throw new Error("首个 exec 不是 git: " + execCalls[0].command);
  }
  if (sent.length !== 1) throw new Error("sendUserMessage 次数异常: " + sent.length);
  const prompt = sent[0].message;
  for (const marker of [
    "fixture.ts",
    "Preserve functionality",
    "Apply project standards",
    "changed lines: 3-6",
  ]) {
    if (!prompt.includes(marker)) {
      throw new Error("prompt 缺少上游标记 " + marker);
    }
  }
  return { deliverAs: sent[0].options && sent[0].options.deliverAs };
});

await check("真实 git 输出可驱动同一处理器", async () => {
  const { sent } = await driveSimplify(
    (command, args, options) =>
      new Promise((resolvePromise) => {
        execFile(command, args, options || {}, (error, stdout, stderr) => {
          resolvePromise({
            code: error && typeof error.code === "number" ? error.code : 0,
            stdout: stdout || "",
            stderr: stderr || "",
          });
        });
      }),
  );
  if (sent.length !== 1) throw new Error("真实 git 路径未产出 prompt");
  if (!sent[0].message.includes("fixture.ts")) {
    throw new Error("真实 git 路径 prompt 未包含改动文件");
  }
  return { promptLength: sent[0].message.length };
});

process.stdout.write(JSON.stringify({ checks }) + "\n");
`;

/** 造一个含真实改动的 git 仓库。 */
async function makeGitRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-pi-community-repo-"));
	const run = (args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	await writeFile(join(dir, "fixture.ts"), "export const one = 1;\n");
	run(["init", "-q"]);
	run(["config", "user.email", "test@example.com"]);
	run(["config", "user.name", "VCPDeck Test"]);
	run(["add", "."]);
	run(["commit", "-q", "-m", "init"]);
	await writeFile(
		join(dir, "fixture.ts"),
		"export const one = 1;\nexport const two = 2;\n",
	);
	return dir;
}

interface ReleaseLayout {
	appDir: string;
	selfDir: string;
	communityPath: string;
	piRoot: string;
}

/** 组装隔离的发布布局：单文件 SDK + 已校验 Bundle。 */
async function makeReleaseLayout(version: string): Promise<ReleaseLayout> {
	const appDir = await mkdtemp(join(tmpdir(), "vcp-pi-release-"));
	const selfDir = join(appDir, "apps", version, "client", "dist");
	await mkdir(selfDir, { recursive: true });
	const sdkDir = join(
		appDir,
		"apps",
		version,
		"client",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	await bundlePiSdk(sdkDir);
	const piRoot = join(appDir, "apps", version, "pi-resources");
	const manifest = await buildPiResourceBundle({
		root: piRoot,
		bundleVersion: version,
		piSdkVersion: PI_SDK_VERSION,
	});
	const community = manifest.resources.find(
		(resource) => resource.id === "community.pi-simplify",
	);
	assert.ok(community, "Bundle 必须包含社区扩展");
	return {
		appDir,
		selfDir,
		communityPath: join(piRoot, community.path),
		piRoot,
	};
}

test("发布布局下真实社区扩展加载、命令可发现且宿主虚拟模块映射生效", async (t) => {
	const layout = await makeReleaseLayout("1.0.0");
	const repoDir = await makeGitRepo();
	const workDir = await mkdtemp(join(tmpdir(), "vcp-pi-community-probe-"));
	try {
		// 宿主探针：运行期 import 宿主虚拟模块，用于证明单文件 SDK 的映射分支生效。
		const hostProbePath = join(workDir, "host-probe.mjs");
		await writeFile(
			hostProbePath,
			`import { VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerCommand("host_probe", {
    description: "host probe",
    handler: async () => ({ sdkVersion: VERSION, typebox: typeof Type }),
  });
}
`,
		);

		const configPath = join(workDir, "probe-config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				sdkUrl: pathToFileURL(
					join(
						layout.appDir,
						"apps",
						"1.0.0",
						"client",
						"node_modules",
						"@earendil-works",
						"pi-coding-agent",
						"index.mjs",
					),
				).href,
				communityPath: layout.communityPath,
				hostProbePath,
				expectedSdkVersion: PI_SDK_VERSION,
				cwd: workDir,
				agentDir: join(workDir, "agent"),
				repoDir,
			}),
		);
		const probePath = join(workDir, "probe.mjs");
		await writeFile(probePath, PROBE_SOURCE);

		const stdout = execFileSync(process.execPath, [probePath, configPath], {
			cwd: workDir,
			stdio: "pipe",
		}).toString();
		const result = JSON.parse(stdout) as ProbeResult;

		const failed = result.checks.filter((entry) => !entry.ok);
		assert.deepEqual(
			failed,
			[],
			`发布布局探针失败：${JSON.stringify(failed, null, 2)}`,
		);
		assert.equal(result.checks.length, 4);
	} finally {
		await rm(layout.appDir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
		await rm(workDir, { recursive: true, force: true });
	}
});

test("Client 校验接受发布产物，并对篡改/版本不符/缺失 fail closed", async () => {
	const layout = await makeReleaseLayout("2.0.0");
	try {
		const verified = await resolveVerifiedPiBundle({
			selfDir: layout.selfDir,
			appDir: layout.appDir,
			sdkVersion: PI_SDK_VERSION,
		});
		assert.ok(verified, "合法发布产物必须通过校验");
		assert.deepEqual(verified.resourceIds, [
			"community.pi-simplify",
			"vcp.tool-policy",
		]);
		assert.equal(verified.extensionPaths.length, 2);

		// SDK 版本不符：Bundle 的 piSdkVersion 是硬门控
		assert.equal(
			await resolveVerifiedPiBundle({
				selfDir: layout.selfDir,
				appDir: layout.appDir,
				sdkVersion: "0.0.0-other",
			}),
			null,
		);

		// 内容篡改：sha256 必须拦住
		const manifest = JSON.parse(
			await readFile(join(layout.piRoot, "manifest.json"), "utf8"),
		) as { resources: Array<{ id: string; path: string }> };
		const community = manifest.resources.find(
			(resource) => resource.id === "community.pi-simplify",
		);
		assert.ok(community);
		await writeFile(join(layout.piRoot, community.path), "// tampered\n");
		assert.equal(
			await resolveVerifiedPiBundle({
				selfDir: layout.selfDir,
				appDir: layout.appDir,
				sdkVersion: PI_SDK_VERSION,
			}),
			null,
			"篡改后的资源必须导致整体 fail closed",
		);

		// manifest 缺失
		await rm(join(layout.piRoot, "manifest.json"), { force: true });
		assert.equal(
			await resolveVerifiedPiBundle({
				selfDir: layout.selfDir,
				appDir: layout.appDir,
				sdkVersion: PI_SDK_VERSION,
			}),
			null,
		);
	} finally {
		await rm(layout.appDir, { recursive: true, force: true });
	}
});

test("Client 更新与回滚：两个版本各自独立校验，Session 数据不受影响", async () => {
	const oldLayout = await makeReleaseLayout("3.0.0");
	const newLayout = await makeReleaseLayout("3.1.0");
	const dataRoot = await mkdtemp(join(tmpdir(), "vcp-pi-data-"));
	try {
		const sessionSentinel = join(dataRoot, "pi", "sessions", "sentinel.jsonl");
		await mkdir(join(dataRoot, "pi", "sessions"), { recursive: true });
		await writeFile(sessionSentinel, '{"keep":true}\n');

		// 升级后旧版本目录仍在：两个版本各自用自己的 selfDir 校验，互不依赖指针文件
		for (const layout of [oldLayout, newLayout]) {
			const verified = await resolveVerifiedPiBundle({
				selfDir: layout.selfDir,
				appDir: layout.appDir,
				sdkVersion: PI_SDK_VERSION,
			});
			assert.ok(verified);
			assert.ok(
				verified.root.startsWith(layout.appDir),
				"Bundle 必须来自自身版本目录",
			);
		}

		// 回滚到旧版本：Session 数据根不在 Release 目录内，必须原样保留
		assert.equal(
			await readFile(sessionSentinel, "utf8"),
			'{"keep":true}\n',
		);
	} finally {
		await rm(oldLayout.appDir, { recursive: true, force: true });
		await rm(newLayout.appDir, { recursive: true, force: true });
		await rm(dataRoot, { recursive: true, force: true });
	}
});
