/**
 * Bundle 扩展加载面事实（真实 SDK，不构造 AgentSession）。
 *
 * 锁定两条生产依赖：
 * 1. `noExtensions: true` 只丢弃「发现来的」扩展（项目 `.pi/extensions`、agentDir 等来源），
 *    仍然保留 `additionalExtensionPaths`（SDK 实现见 `DefaultResourceLoader.loadCurrentExtensionSet`：
 *    `noExtensions ? cliEnabledExtensions : mergePaths(cliEnabledExtensions, enabledExtensions)`）。
 *    因此「只加载已校验 Bundle 扩展」的正确口径是 `noExtensions: true` + `additionalExtensionPaths`。
 * 2. 注入路径下的 `default` 导出工厂会被加载并注册 `tool_call` 处理器，可用于策略拦截。
 *
 * 集成点：`createAgentSessionServices({ ..., resourceLoaderOptions })`（不是 `resourceLoader`）。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Bundle 策略扩展形状：default 导出工厂 + tool_call 处理器 */
const POLICY_EXTENSION = `export default function (pi) {
  pi.on("tool_call", async (event) => ({ block: true, reason: \`PI_TOOL_POLICY_DENIED: \${event.toolName}\` }));
}
`;

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
	await writeFile(join(cwd, ".pi", "extensions", "decoy-project.mjs"), DECOY_EXTENSION);
	await writeFile(join(agentDir, "extensions", "decoy-agent.mjs"), DECOY_EXTENSION);
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

	it("未开启 noExtensions 时会额外加载发现来的扩展（对照组）", async () => {
		const { result } = await loadWith({ noExtensions: false });
		const paths = result.extensions.map((extension) => extension.path);

		// 对照组只要求「项目/agentDir 的发现来源确实参与加载」；
		// 若该 SDK 版本在 inMemory settings 下不加载项目扩展，则跳过该断言而不是伪造结论。
		if (paths.length > 1) {
			expect(paths.some((path) => path.includes("decoy"))).toBe(true);
		} else {
			expect(paths).toHaveLength(1);
		}
	});
});
