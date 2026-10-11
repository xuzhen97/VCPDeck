/**
 * Bundle 扩展加载面事实（真实 SDK，不构造 AgentSession）。
 *
 * 锁定两条生产依赖：
 * 1. `bundleLoaderOptions()`（生产加载面，ADR-0043）会让**项目本地扩展生效**
 *    （`.pi/extensions`、skills、prompts、context 文件），同时继续通过
 *    `additionalExtensionPaths` 加载已校验的 Bundle 扩展；`agentDir`（VCPDeck 数据根，
 *    保持为空）的用户级扩展不加载，终端主题仍关闭。
 * 2. 注入路径下的 `default` 导出工厂会被加载并注册 `tool_call` 处理器，可用于策略拦截。
 *
 * 集成点：`createAgentSessionServices({ ..., resourceLoaderOptions })`（不是 `resourceLoader`）。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleLoaderOptions, resourceLoaderReloadOptions } from "./agent-session.js";

/** Bundle 策略扩展形状：default 导出工厂 + tool_call 处理器 */
const POLICY_EXTENSION = `export default function (pi) {
  pi.on("tool_call", async (event) => ({ block: true, reason: \`PI_TOOL_POLICY_DENIED: \${event.toolName}\` }));
}
`;

// 注意：SDK 的项目/agentDir 自动发现**只认 `.ts` 与 `.js`**（`collectAutoExtensionEntries`
// 的 `entry.name.endsWith(".ts") || entry.name.endsWith(".js")`）。用 `.mjs` 会让
// 「不被加载」类断言变成空洞断言，因此诱饵必须是 `.js`。
const DECOY_EXTENSION = `export default function () { globalThis.__vcpDecoyLoaded = true; }
`;

async function makeTree() {
	const cwd = await mkdtemp(join(tmpdir(), "vcp-bundle-cwd-"));
	const agentDir = join(cwd, "agent");
	const ourPath = join(cwd, "bundle", "vcp-tool-policy.mjs");
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await mkdir(join(cwd, "bundle"), { recursive: true });
	// 诱饵：项目本地扩展与 agentDir 扩展都不得被加载（设计 §15、ADR-0029 决策 7）
	await writeFile(join(cwd, ".pi", "extensions", "decoy-project.js"), DECOY_EXTENSION);
	await writeFile(join(agentDir, "extensions", "decoy-agent.js"), DECOY_EXTENSION);
	await writeFile(ourPath, POLICY_EXTENSION);
	return { cwd, agentDir, ourPath };
}

async function loadWith(options: { noExtensions: boolean }) {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const { cwd, agentDir, ourPath } = await makeTree();
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: sdk.SettingsManager.inMemory(),
		additionalExtensionPaths: [ourPath],
		...(options.noExtensions ? { noExtensions: true } : {}),
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await loader.reload();
	return { result: loader.getExtensions(), ourPath, cwd, agentDir };
}

describe("Bundle 扩展加载面（真实 SDK）", () => {
	it("noExtensions 下只加载 additionalExtensionPaths，项目与 agentDir 扩展都被排除", async () => {
		const { result, ourPath, cwd, agentDir } = await loadWith({
			noExtensions: true,
		});

		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => extension.path)).toEqual([
			ourPath,
		]);
		for (const extension of result.extensions) {
			expect(extension.resolvedPath.startsWith(cwd)).toBe(true);
			expect(extension.resolvedPath.startsWith(agentDir)).toBe(false);
			expect(extension.resolvedPath).not.toContain("decoy");
		}
	});

	it("1.1.0 起的内建扩展不进入受信加载面（安全相关）", async () => {
		const { result } = await loadWith({ noExtensions: true });
		const paths = result.extensions.map((extension) => extension.path);

		// 上游 0.99 起在 SDK 内注册内建扩展（以 `builtin:` 路径标识，如 mcp / codemode /
		// tool-search / llama.cpp）。若 `noExtensions: true` 不再过滤它们，工具面会被静默
		// 放大（`activateRuntimeTools` 按运行时实际注册集合激活），因此必须锁定。
		expect(paths.filter((path) => path.startsWith("builtin:"))).toEqual([]);
		const toolNames = result.extensions.flatMap((extension) => [
			...extension.tools.keys(),
		]);
		for (const builtinTool of ["codemode", "tool_search"]) {
			expect(toolNames).not.toContain(builtinTool);
		}
	});

	it("加载出的策略扩展注册了 tool_call 处理器并返回阻塞决策", async () => {
		const { result } = await loadWith({ noExtensions: true });
		const [extension] = result.extensions;
		expect(extension?.handlers.has("tool_call")).toBe(true);

		const handler = extension?.handlers.get("tool_call")?.[0];
		const decision = await handler?.({ toolName: "bash" }, {
			ui: { confirm: async () => false },
		} as never);

		expect(decision).toEqual({
			block: true,
			reason: "PI_TOOL_POLICY_DENIED: bash",
		});
	});

	it("生产加载面：项目扩展与数据根扩展生效，Bundle 路径仍加载，内置扩展仍关闭", async () => {
		const sdk = await import("@earendil-works/pi-coding-agent");
		const { cwd, agentDir, ourPath } = await makeTree();
		const loader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: sdk.SettingsManager.inMemory(),
			...bundleLoaderOptions([ourPath]),
		});
		await loader.reload(resourceLoaderReloadOptions());
		const paths = loader
			.getExtensions()
			.extensions.map((extension) => extension.path);

		// ADR-0043：项目目录内容属于项目自身特性，无条件生效
		expect(paths.some((path) => path.includes("decoy-project.js"))).toBe(true);
		// VCPDeck 数据根（agentDir）是**我们自己的**地盘，不是原生 `~/.pi`：允许作为
		// 第二个扩展来源。代价是同版本 Client 之间可能不一致，已在 ADR-0043 记录为显式例外。
		expect(paths.some((path) => path.includes("decoy-agent.js"))).toBe(true);
		// Bundle 路径始终加载
		expect(paths).toContain(ourPath);
		// 内置扩展必须显式保持关闭（靠 noExtensions 已经不成立）
		expect(paths.filter((path) => path.startsWith("builtin:"))).toEqual([]);
		const toolNames = loader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.tools.keys()]);
		for (const builtinTool of ["codemode", "tool_search"]) {
			expect(toolNames).not.toContain(builtinTool);
		}
		// 终端主题与 rpc 模式无关，保持关闭
		expect(loader.getThemes().themes).toEqual([]);
	});
});
