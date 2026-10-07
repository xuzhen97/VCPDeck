/**
 * 受信 Pi 扩展的宿主一致闸门（ADR-0040 决策 2、ADR-0039 决策 1）。
 *
 * 这里只使用 Pi SDK 的**公开 API**（`bindExtensions`、`getAllTools`、
 * `setActiveToolsByName`、`waitForIdle`、resource loader 的扩展清单），
 * 不读写 SDK 私有字段，也不 fork 或 patch 上游包。
 *
 * 三条被真实 SDK 集成测试锁定的语义（见 extension-host.integration.test.ts）：
 * 1. `createAgentSessionFromServices({ tools })` 是**全工具 allowlist**，只传内置工具名
 *    会把扩展注册的工具整体过滤掉。因此宿主不能用内置白名单缩小工具面，必须改用
 *    `activateRuntimeTools` 按运行时实际注册集合激活。
 * 2. 扩展命令处理器抛错**不会**让 `prompt()` reject，SDK 通过 `bindExtensions({ onError })`
 *    以 `{ event: "command", extensionPath: "command:<name>" }` 上报。只注入受限 action
 *    而不监听该通道，等于"已限制"只是沉默，所以必须配合 `createExtensionErrorListener`。
 * 3. 扩展同名注册会被 SDK 静默去重（命令被改写成 `name:2`），因此冲突必须在装配前
 *    由宿主拒绝，而不是让操作者面对歧义调用名。
 */
import type { ExtensionCommandContextActions } from "@earendil-works/pi-coding-agent";

/** 宿主拒绝扩展敏感操作时使用的稳定错误码。 */
export const PI_EXTENSION_UNSUPPORTED = "PI_EXTENSION_UNSUPPORTED";

/**
 * 拒绝标记：SDK 的 `onError` 只回传 `error.message` 字符串，不保留自定义 `code`，
 * 因此用固定前缀把"宿主主动拒绝"与"扩展自身缺陷"区分开，避免把扩展 bug
 * 误报成宿主不支持。
 */
const UNSUPPORTED_MARKER = "vcp:extension-operation-unsupported";

/** 宿主一致错误条目（不含本地路径与原始错误正文）。 */
export interface ExtensionHostError {
	/** 稳定错误码；当前只有宿主拒绝一种。 */
	code: string;
	/** 触发拒绝的命令调用名；非命令来源为 null。 */
	command: string | null;
}

/** 扩展命令上下文中被禁止的宿主敏感操作。 */
const UNSUPPORTED_OPERATIONS = [
	"newSession",
	"fork",
	"navigateTree",
	"switchSession",
	"reload",
] as const;

interface RawExtensionError {
	extensionPath?: string;
	event?: string;
	error?: string;
}

/**
 * 构造 `bindExtensions({ onError })` 监听器。
 *
 * 只有同时满足「事件是 command」且「错误正文带宿主拒绝标记」才上报为宿主拒绝；
 * 其余扩展错误（工具、事件处理器等）一律不映射为 `PI_EXTENSION_UNSUPPORTED`，
 * 避免伪造扩展归属或把扩展缺陷说成宿主限制。
 */
export function createExtensionErrorListener(
	sink: (entry: ExtensionHostError) => void,
): (error: RawExtensionError) => void {
	return (error) => {
		if (error?.event !== "command") return;
		const message = typeof error.error === "string" ? error.error : "";
		if (!message.startsWith(UNSUPPORTED_MARKER)) return;
		const command = /^command:(.+)$/.exec(error.extensionPath ?? "")?.[1] ?? null;
		sink({ code: PI_EXTENSION_UNSUPPORTED, command });
	};
}

/**
 * 构造受限的命令上下文 action。
 *
 * 只放行 `waitForIdle`；会话新建/切换、树导航与 runtime reload 会替换宿主控制面身份，
 * 与 Session Job/Owner/项目锁语义冲突，必须在**调用发生前**拒绝而不是执行后补偿。
 * `shutdown` 同样不放行：关闭宿主 Worker 属于运维控制，不是扩展能力。
 */
export function restrictedCommandActions(session: {
	waitForIdle(): Promise<void>;
}): ExtensionCommandContextActions {
	const reject = async (operation: string): Promise<never> => {
		throw Object.assign(new Error(`${UNSUPPORTED_MARKER}:${operation}`), {
			code: PI_EXTENSION_UNSUPPORTED,
		});
	};
	return {
		waitForIdle: () => session.waitForIdle(),
		newSession: () => reject("newSession"),
		fork: () => reject("fork"),
		navigateTree: () => reject("navigateTree"),
		switchSession: () => reject("switchSession"),
		reload: () => reject("reload"),
	} satisfies ExtensionCommandContextActions;
}

/** resource loader 返回的扩展清单的最小结构。 */
interface LoadedExtension {
	path: string;
	tools: Map<string, unknown>;
	commands: Map<string, unknown>;
}

/**
 * 装配前检查扩展注册冲突。
 *
 * - 工具名与内置工具相同：SDK 会让扩展工具覆盖内置实现，操作者看到的工具名却仍是
 *   内置语义，属于静默能力替换，必须拒绝。
 * - 同一命令名被多个扩展注册：SDK 会把调用名改写成 `name:2`，网页命令列表会出现
 *   无法解释的歧义项，必须拒绝而不是让操作者猜。
 */
export function assertExtensionRegistrations(
	extensions: readonly LoadedExtension[],
	builtinToolNames: ReadonlySet<string>,
): void {
	const commandOwners = new Map<string, string[]>();
	for (const extension of extensions) {
		for (const toolName of extension.tools.keys()) {
			if (builtinToolNames.has(toolName)) {
				throw Object.assign(
					new Error(`扩展工具 ${toolName} 与内置工具同名`),
					{ code: PI_EXTENSION_UNSUPPORTED },
				);
			}
		}
		for (const commandName of extension.commands.keys()) {
			const owners = commandOwners.get(commandName) ?? [];
			owners.push(extension.path);
			commandOwners.set(commandName, owners);
		}
	}
	for (const [commandName, owners] of commandOwners) {
		if (owners.length > 1) {
			throw Object.assign(
				new Error(`扩展命令 ${commandName} 被 ${owners.length} 个资源重复注册`),
				{ code: PI_EXTENSION_UNSUPPORTED },
			);
		}
	}
}

/**
 * 按运行时实际注册集合激活工具。
 *
 * `unavailableBuiltinNames` 是当前平台不存在的能力（例如无 Git Bash 的 Windows 上的
 * `bash`）；它们只是不可用，不能作为授权边界。扩展注册的工具与内置工具走同一审批链路。
 */
export function activateRuntimeTools(
	session: {
		getAllTools(): Array<{ name: string }>;
		setActiveToolsByName(toolNames: string[]): void;
	},
	unavailableBuiltinNames: ReadonlySet<string>,
): string[] {
	const names = session
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => !unavailableBuiltinNames.has(name));
	session.setActiveToolsByName(names);
	return names;
}

/** 供诊断与测试复用的常量集合。 */
export const EXTENSION_UNSUPPORTED_OPERATIONS = UNSUPPORTED_OPERATIONS;
