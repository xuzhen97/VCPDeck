/**
 * 网页受信扩展的验收 fixture（仅测试/本地集成使用）。
 *
 * 用途：以真实 Pi SDK 加载一个自包含扩展，验证宿主能约束其命令上下文、
 * 接纳其注册工具，并把 UI 调用投影为受限的网页语义。
 *
 * 约束：
 * - 只能是纯 TS 源码生成器，**不 import 任何运行时模块**（Pi SDK 为 ESM-only，
 *   Client 编译为 CJS；扩展源码由 SDK 的 jiti 加载器在 Worker 进程内求值）。
 * - `parameters` 使用等价 TypeBox 的纯 JSON Schema 对象，避免依赖 typebox 包
 *   （Client node_modules 不包含 typebox；打包后的单文件 SDK 走虚拟模块分支）。
 * - 不得访问网络、凭据、真实路径或执行破坏性副作用。
 */

/** 生成一个扩展源码；`prefix` 让同一模板生成互相冲突的注册项。 */
export function buildWebExtensionSource(options?: {
	/** 工具与命令名前缀，默认 `fixture`。 */
	prefix?: string;
	/** 额外注册一个与内置工具同名的工具（测试注册冲突）。 */
	clashBuiltinTool?: boolean;
	/** 额外注册一个与首个扩展同名的命令（测试命令歧义）。 */
	clashCommand?: boolean;
}): string {
	const prefix = options?.prefix ?? "fixture";
	const toolName = `${prefix}_echo`;
	const schema = JSON.stringify({
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	});
	const commands = [
		"replace",
		"fork",
		"navigate",
		"switch",
		"reload",
		"notify",
		"status",
		"widget",
		"title",
		"editor",
		"wait",
	]
		.map((name) => JSON.stringify(`${prefix}_${name}`))
		.join(", ");
	return `export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(toolName)},
    label: "Fixture Echo",
    description: "Echo the given text back to the model.",
    parameters: ${schema},
    execute: async (_id, params) => ({
      content: [{ type: "text", text: "echo:" + params.text }],
      details: {},
    }),
  });
${options?.clashBuiltinTool ? `  pi.registerTool({
    name: "read",
    label: "Fixture Clash",
    description: "Clash with the built-in read tool.",
    parameters: ${schema},
    execute: async () => ({ content: [{ type: "text", text: "clash" }], details: {} }),
  });
` : ""}${options?.clashCommand ? `  pi.registerCommand(${JSON.stringify(toolName)}, {
    description: "Duplicate invocation name.",
    handler: async () => {},
  });
` : ""}  pi.on("session_start", async (event, ctx) => {
    ctx.ui.setStatus(${JSON.stringify(`${prefix}-session`)}, "started:" + String(event.reason));
  });
  for (const name of [${commands}]) {
    pi.registerCommand(name, {
      description: "Fixture command " + name,
      handler: async (_args, ctx) => {
        if (name.endsWith("replace")) return ctx.newSession();
        if (name.endsWith("fork")) return ctx.fork("entry-does-not-exist");
        if (name.endsWith("navigate")) return ctx.navigateTree("entry-does-not-exist");
        if (name.endsWith("switch")) return ctx.switchSession("/nonexistent.jsonl");
        if (name.endsWith("reload")) return ctx.reload();
        if (name.endsWith("notify")) { ctx.ui.notify("fixture notify", "warning"); return; }
        if (name.endsWith("status")) { ctx.ui.setStatus("fixture-status", "busy"); return; }
        if (name.endsWith("widget")) { ctx.ui.setWidget("fixture-widget", ["line-1", "line-2"]); return; }
        if (name.endsWith("title")) { ctx.ui.setTitle("fixture title"); return; }
        if (name.endsWith("editor")) { ctx.ui.pasteToEditor("fixture editor text"); return; }
        if (name.endsWith("wait")) {
          const gate = globalThis.__vcpFixtureGate;
          if (!gate) throw new Error("fixture gate is not installed");
          await gate;
          return;
        }
      },
    });
  }
}
`;
}
