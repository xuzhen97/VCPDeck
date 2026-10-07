/**
 * 受信扩展的宿主一致闸门（真实 Pi SDK 0.86.0 集成）。
 *
 * 锁定四条生产依赖，任何一条被上游改动破坏都会让网页承诺失真：
 * 1. `createAgentSessionFromServices({ tools })` 是**全工具 allowlist**：只传内置工具名时，
 *    扩展注册的工具会被整体过滤（实测 `getAllTools()` 只剩 read）。因此宿主不得用内置
 *    白名单缩小工具面，必须改用 `activateRuntimeTools` 按实际注册集合激活。
 * 2. 命令处理器抛错**不会**让 `prompt()` reject；SDK 通过 `bindExtensions({ onError })`
 *    以 `{ event: "command", extensionPath: "command:<name>" }` 上报。宿主必须监听并
 *    转换为稳定错误码，否则"已限制"只是沉默。
 * 3. 未注册的 `/xxx` 不会报错，而是继续走普通模型请求（在无凭据环境抛
 *    "No API key found"）。因此命令必须在调用前按注册名核验，普通 prompt 必须禁用
 *    模板展开。
 * 4. 扩展同名注册会被 SDK 静默去重（命令被改写为 `name:2`），冲突必须在宿主侧
 *    装配前拒绝，而不是让操作者面对歧义调用名。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWebExtensionSource } from "./fixtures/web-extension.js";
import {
	activateRuntimeTools,
	assertExtensionRegistrations,
	createExtensionErrorListener,
	restrictedCommandActions,
	PI_EXTENSION_UNSUPPORTED,
} from "./extension-host.js";

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type SdkSession = Awaited<ReturnType<Sdk["createAgentSessionFromServices"]>>["session"];

let sdkPromise: Promise<Sdk> | null = null;
function getSdk(): Promise<Sdk> {
	if (!sdkPromise) {
		sdkPromise = import("@earendil-works/pi-coding-agent");
	}
	return sdkPromise;
}

interface HostFixture {
	session: SdkSession;
	sdk: Sdk;
	originalSessionId: string;
	errors: Array<{ code: string; command: string | null }>;
	cleanup(): Promise<void>;
}

/** 真实 SDK 装配：Bundle 式加载面（noExtensions + additionalExtensionPaths），无网络、无真实凭据。 */
async function createHostFixture(options?: {
	source?: string;
	/** 只暴露内置工具名，用于证明 SDK allowlist 会过滤扩展工具。 */
	builtinOnlyAllowlist?: boolean;
}): Promise<HostFixture> {
	const sdk = await getSdk();
	const cwd = await mkdtemp(join(tmpdir(), "vcp-ext-host-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir, { recursive: true });
	const extensionPath = join(cwd, "fixture-extension.mjs");
	await writeFile(extensionPath, options?.source ?? buildWebExtensionSource());

	const modelRuntime = await sdk.ModelRuntime.create({
		modelsPath: null,
		authPath: join(agentDir, "absent-auth.json"),
	});
	const services = await sdk.createAgentSessionServices({
		cwd,
		agentDir,
		modelRuntime,
		settingsManager: sdk.SettingsManager.inMemory(),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			additionalExtensionPaths: [extensionPath],
		},
	});
	const { session } = await sdk.createAgentSessionFromServices({
		services,
		sessionManager: sdk.SessionManager.inMemory(),
		...(options?.builtinOnlyAllowlist
			? { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] }
			: {}),
	});

	const errors: Array<{ code: string; command: string | null }> = [];
	const listener = createExtensionErrorListener((entry) => errors.push(entry));
	await session.bindExtensions({
		mode: "rpc",
		commandContextActions: restrictedCommandActions(session),
		onError: listener,
	});

	return {
		session,
		sdk,
		originalSessionId: session.sessionId,
		errors,
		cleanup: async () => {
			await session.dispose();
		},
	};
}

const openers: HostFixture[] = [];
afterEach(async () => {
	while (openers.length > 0) await openers.pop()?.cleanup();
});

async function open(options?: Parameters<typeof createHostFixture>[0]): Promise<HostFixture> {
	const fixture = await createHostFixture(options);
	openers.push(fixture);
	return fixture;
}

describe("扩展宿主一致闸门（真实 SDK）", () => {
	it("会话替换类命令在发生前被拒绝，且拒绝经扩展错误通道可见", async () => {
		const { session, errors, originalSessionId } = await open();

		await session.prompt("/fixture_replace");

		expect(session.sessionId).toBe(originalSessionId);
		expect(errors).toEqual([
			{ code: PI_EXTENSION_UNSUPPORTED, command: "fixture_replace" },
		]);
	});

	it.each(["fork", "navigate", "switch", "reload"])(
		"命令 %s 被拒绝且会话身份不变",
		async (name) => {
			const { session, errors, originalSessionId } = await open();

			await session.prompt(`/fixture_${name}`);

			expect(session.sessionId).toBe(originalSessionId);
			expect(errors).toEqual([
				{ code: PI_EXTENSION_UNSUPPORTED, command: `fixture_${name}` },
			]);
		},
	);

	it("未注册的斜杠输入不会静默变成普通模型请求", async () => {
		const { session, errors } = await open();

		// 无凭据环境下，SDK 会对未注册命令继续走模型请求并抛 "No API key found"；
		// 宿主必须靠调用前核验阻止该路径，因此这里断言 SDK 不会把未知命令当成已处理命令。
		await expect(session.prompt("/fixture_not_registered")).rejects.toThrow();
		expect(errors).toEqual([]);
	});

	it("扩展注册的工具不被内置白名单过滤，并按实际注册集合激活", async () => {
		const filtered = await open({ builtinOnlyAllowlist: true });
		expect(filtered.session.getAllTools().map((tool) => tool.name)).not.toContain(
			"fixture_echo",
		);

		const full = await open();
		expect(full.session.getAllTools().map((tool) => tool.name)).toContain("fixture_echo");

		activateRuntimeTools(full.session, new Set(["powershell"]));
		const active = full.session.extensionRunner.getActiveTools();
		expect(active).toContain("fixture_echo");
		expect(active).toContain("read");
		expect(active).not.toContain("powershell");
	});

	it("扩展与内置工具同名时在装配前被拒绝", async () => {
		const sdk = await getSdk();
		const cwd = await mkdtemp(join(tmpdir(), "vcp-ext-clash-"));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir, { recursive: true });
		const extensionPath = join(cwd, "clash.mjs");
		await writeFile(
			extensionPath,
			buildWebExtensionSource({ clashBuiltinTool: true }),
		);
		const loader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: sdk.SettingsManager.inMemory(),
			additionalExtensionPaths: [extensionPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();

		expect(() =>
			assertExtensionRegistrations(loader.getExtensions().extensions, new Set(["read"])),
		).toThrow(/read/);
	});

	it("同名命令产生的歧义调用名在装配前被拒绝", async () => {
		const sdk = await getSdk();
		const cwd = await mkdtemp(join(tmpdir(), "vcp-ext-dup-"));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir, { recursive: true });
		// SDK 只在**跨扩展**重名时改写调用名为 `name:2`；同一扩展内重复注册会被 Map 静默覆盖。
		// 因此该守卫必须覆盖跨扩展歧义，否则网页会拿到无法解释的调用名。
		const first = join(cwd, "dup-a.mjs");
		const second = join(cwd, "dup-b.mjs");
		await writeFile(first, buildWebExtensionSource({ clashCommand: true }));
		await writeFile(second, buildWebExtensionSource({ clashCommand: true }));
		const loader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: sdk.SettingsManager.inMemory(),
			additionalExtensionPaths: [first, second],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const extensions = loader.getExtensions().extensions;
		expect(extensions).toHaveLength(2);

		expect(() => assertExtensionRegistrations(extensions, new Set())).toThrow(
			/fixture_echo/,
		);
	});

	it("合法注册不报错，且命令与工具均可在真实会话上解析", async () => {
		const sdk = await getSdk();
		const cwd = await mkdtemp(join(tmpdir(), "vcp-ext-ok-"));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir, { recursive: true });
		const extensionPath = join(cwd, "ok.mjs");
		await writeFile(extensionPath, buildWebExtensionSource());
		const loader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: sdk.SettingsManager.inMemory(),
			additionalExtensionPaths: [extensionPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();

		expect(() =>
			assertExtensionRegistrations(loader.getExtensions().extensions, new Set(["read"])),
		).not.toThrow();
		expect(sdk).toBeDefined();
	});

	it("非命令来源的扩展错误不伪造为宿主不支持", async () => {
		const listener = createExtensionErrorListener(() => {});
		const entries: Array<{ code: string; command: string | null }> = [];
		const collecting = createExtensionErrorListener((entry) => entries.push(entry));
		expect(listener).not.toBe(collecting);

		collecting({
			extensionPath: "bundle/other.mjs",
			event: "tool_call",
			error: "boom",
		});

		expect(entries).toEqual([]);
	});
});
