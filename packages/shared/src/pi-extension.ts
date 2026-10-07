/**
 * 受信 Pi 扩展的网页协议（ADR-0040 决策 3、5）。
 *
 * 覆盖三类跨信任边界数据：命令清单、非阻塞 UI 更新、持续 UI 状态快照，
 * 以及执行语义迁移的确认输入。它们都由受信扩展代码或操作者请求产生，
 * 属于**不可信展示数据**：必须严格拒绝未知字段、超限内容与歧义形状，
 * 不能把 SDK 对象宽松透传给网页。
 *
 * 依赖方向：本模块单向依赖 `./pi.js`（类型 + `isPiToolExecutionMode`），
 * 与 `pi-admin.ts` 同样的单向关系；`pi.ts` 不反向引用本模块，保持其自包含。
 */
import { isPiToolExecutionMode, type PiToolExecutionMode } from "./pi.js";

/** 协议输入错误：跨信任边界输入不满足契约。 */
export class PiExtensionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiExtensionProtocolError";
	}
}

/** 每类集合（statuses / widgets）的 key 数量上限。 */
export const MAX_EXTENSION_KEYS = 32;
/** key 的 Unicode code point 上限。 */
export const MAX_EXTENSION_KEY_CHARS = 128;
/** 单条 status / title / notify 文本上限。 */
export const MAX_EXTENSION_TEXT_CHARS = 4096;
/** 编辑框填充文本上限（不静默截断，超限即拒绝）。 */
export const MAX_EXTENSION_EDITOR_CHARS = 32768;
/** 单个 Widget 的行数上限。 */
export const MAX_EXTENSION_WIDGET_LINES = 100;
/** 单个 Widget 每行的 code point 上限。 */
export const MAX_EXTENSION_LINE_CHARS = 2048;
/** 状态快照序列化后的 UTF-8 字节上限。 */
export const MAX_EXTENSION_SNAPSHOT_BYTES = 128 * 1024;
/** 单次命令清单条数上限。 */
export const MAX_EXTENSION_COMMANDS = 128;
/** 命令调用名 code point 上限。 */
export const MAX_EXTENSION_COMMAND_NAME_CHARS = 128;
/** 命令描述 code point 上限。 */
export const MAX_EXTENSION_COMMAND_DESC_CHARS = 4096;
/** 命令参数 code point 上限。 */
export const MAX_EXTENSION_COMMAND_ARGS_CHARS = 32768;
/** runtime 身份字符串 code point 上限。 */
export const MAX_EXTENSION_ID_CHARS = 128;

export type PiExtensionWidgetPlacement = "aboveEditor" | "belowEditor";
export type PiExtensionNotifyLevel = "info" | "warning" | "error";

/** 网页可执行的扩展命令投影（不含本地来源路径）。 */
export interface PiExtensionCommand {
	name: string;
	description: string;
}

/** 命令清单：必须绑定具体运行时实例与 revision，避免跨换代误执行。 */
export interface PiExtensionCommands {
	runtimeInstanceId: string;
	runtimeRevision: string;
	commands: PiExtensionCommand[];
}

/** 持续 UI 状态快照（status / widget / title 的最新值）。 */
export interface PiExtensionUiSnapshot {
	runtimeInstanceId: string | null;
	runtimeRevision: string | null;
	sequence: number;
	title: string | null;
	statuses: Array<{ key: string; text: string }>;
	widgets: Array<{
		key: string;
		lines: string[];
		placement: PiExtensionWidgetPlacement;
	}>;
}

/**
 * 非阻塞 UI 更新。
 *
 * `setStatus` / `setWidget` 省略 `text` / `lines` 表示**清除**该 key；
 * `set_editor_text` 的空字符串是**合法的清空草稿请求**，与缺字段语义不同。
 */
export type PiExtensionUiUpdate =
	| { kind: "notify"; message: string; level: PiExtensionNotifyLevel }
	| { kind: "setStatus"; key: string; text?: string }
	| {
			kind: "setWidget";
			key: string;
			lines?: string[];
			placement?: PiExtensionWidgetPlacement;
		}
	| { kind: "setTitle"; title: string }
	| { kind: "set_editor_text"; requestId: string; text: string };

/** 执行语义迁移确认输入：绑定 revision，避免并发确认写回过期配置。 */
export interface PiExecutionMigrationInput {
	expectedRevision: number;
	mode: PiToolExecutionMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按 Unicode code point 计数（避免 emoji 被按 UTF-16 双倍计费）。 */
function codePointLength(value: string): number {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}

function requireCodePoints(
	value: unknown,
	what: string,
	max: number,
): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new PiExtensionProtocolError(`${what} 必须是非空字符串`);
	}
	if (codePointLength(value) > max) {
		throw new PiExtensionProtocolError(`${what} 长度超过上限 ${max}`);
	}
	return value;
}

function optionalCodePoints(
	value: unknown,
	what: string,
	max: number,
): string | undefined {
	if (value === undefined) return undefined;
	return requireCodePoints(value, what, max);
}

function requireKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new PiExtensionProtocolError(`${what} 含未知字段 ${key}`);
		}
	}
}

function requirePlacement(value: unknown, what: string): PiExtensionWidgetPlacement {
	if (value !== "aboveEditor" && value !== "belowEditor") {
		throw new PiExtensionProtocolError(`${what} 必须是 aboveEditor 或 belowEditor`);
	}
	return value;
}

function requireLevel(value: unknown, what: string): PiExtensionNotifyLevel {
	if (value !== "info" && value !== "warning" && value !== "error") {
		throw new PiExtensionProtocolError(`${what} 必须是 info、warning 或 error`);
	}
	return value;
}

const encoder = new TextEncoder();

/** 严格解析非阻塞 UI 更新；不接受任何额外字段。 */
export function parsePiExtensionUiUpdate(value: unknown): PiExtensionUiUpdate {
	if (!isRecord(value)) {
		throw new PiExtensionProtocolError("extensionUiUpdate 必须是对象");
	}
	switch (value.kind) {
		case "notify": {
			requireKeys(value, ["kind", "message", "level"], "extensionUiUpdate.notify");
			return {
				kind: "notify",
				message: requireCodePoints(
					value.message,
					"notify.message",
					MAX_EXTENSION_TEXT_CHARS,
				),
				level: requireLevel(value.level, "notify.level"),
			};
		}
		case "setStatus": {
			requireKeys(value, ["kind", "key", "text"], "extensionUiUpdate.setStatus");
			const text = optionalCodePoints(
				value.text,
				"setStatus.text",
				MAX_EXTENSION_TEXT_CHARS,
			);
			return {
				kind: "setStatus",
				key: requireCodePoints(
					value.key,
					"setStatus.key",
					MAX_EXTENSION_KEY_CHARS,
				),
				...(text === undefined ? {} : { text }),
			};
		}
		case "setWidget": {
			requireKeys(
				value,
				["kind", "key", "lines", "placement"],
				"extensionUiUpdate.setWidget",
			);
			let lines: string[] | undefined;
			if (value.lines !== undefined) {
				if (!Array.isArray(value.lines)) {
					throw new PiExtensionProtocolError("setWidget.lines 必须是数组");
				}
				if (value.lines.length > MAX_EXTENSION_WIDGET_LINES) {
					throw new PiExtensionProtocolError(
						`setWidget.lines 数量超过上限 ${MAX_EXTENSION_WIDGET_LINES}`,
					);
				}
				lines = value.lines.map((line, index) =>
					requireCodePoints(
						line,
						`setWidget.lines[${index}]`,
						MAX_EXTENSION_LINE_CHARS,
					),
				);
			}
			return {
				kind: "setWidget",
				key: requireCodePoints(
					value.key,
					"setWidget.key",
					MAX_EXTENSION_KEY_CHARS,
				),
				...(lines === undefined ? {} : { lines }),
				...(value.placement === undefined
					? {}
					: { placement: requirePlacement(value.placement, "setWidget.placement") }),
			};
		}
		case "setTitle": {
			requireKeys(value, ["kind", "title"], "extensionUiUpdate.setTitle");
			return {
				kind: "setTitle",
				title: requireCodePoints(
					value.title,
					"setTitle.title",
					MAX_EXTENSION_TEXT_CHARS,
				),
			};
		}
		case "set_editor_text": {
			requireKeys(
				value,
				["kind", "requestId", "text"],
				"extensionUiUpdate.set_editor_text",
			);
			if (typeof value.text !== "string") {
				throw new PiExtensionProtocolError("set_editor_text.text 必须是字符串");
			}
			if (codePointLength(value.text) > MAX_EXTENSION_EDITOR_CHARS) {
				throw new PiExtensionProtocolError(
					`set_editor_text.text 长度超过上限 ${MAX_EXTENSION_EDITOR_CHARS}`,
				);
			}
			return {
				kind: "set_editor_text",
				requestId: requireCodePoints(
					value.requestId,
					"set_editor_text.requestId",
					MAX_EXTENSION_ID_CHARS,
				),
				text: value.text,
			};
		}
		default:
			throw new PiExtensionProtocolError(
				`extensionUiUpdate.kind 不受支持: ${String(value.kind)}`,
			);
	}
}

/** 严格解析持续 UI 状态快照；无 wrapper 时允许空身份。 */
export function parsePiExtensionUiSnapshot(value: unknown): PiExtensionUiSnapshot {
	if (!isRecord(value)) {
		throw new PiExtensionProtocolError("extensionUiSnapshot 必须是对象");
	}
	requireKeys(
		value,
		[
			"runtimeInstanceId",
			"runtimeRevision",
			"sequence",
			"title",
			"statuses",
			"widgets",
		],
		"extensionUiSnapshot",
	);
	if (
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) < 0
	) {
		throw new PiExtensionProtocolError("extensionUiSnapshot.sequence 必须是非负整数");
	}
	const instanceId =
		value.runtimeInstanceId === null
			? null
			: requireCodePoints(
					value.runtimeInstanceId,
					"runtimeInstanceId",
					MAX_EXTENSION_ID_CHARS,
				);
	const revision =
		value.runtimeRevision === null
			? null
			: requireCodePoints(
					value.runtimeRevision,
					"runtimeRevision",
					MAX_EXTENSION_ID_CHARS,
				);
	if ((instanceId === null) !== (revision === null)) {
		throw new PiExtensionProtocolError(
			"runtimeInstanceId 与 runtimeRevision 必须同时为空或同时存在",
		);
	}
	const title =
		value.title === null
			? null
			: requireCodePoints(value.title, "title", MAX_EXTENSION_TEXT_CHARS);
	if (!Array.isArray(value.statuses) || value.statuses.length > MAX_EXTENSION_KEYS) {
		throw new PiExtensionProtocolError(
			`statuses 数量超过上限 ${MAX_EXTENSION_KEYS}`,
		);
	}
	if (!Array.isArray(value.widgets) || value.widgets.length > MAX_EXTENSION_KEYS) {
		throw new PiExtensionProtocolError(
			`widgets 数量超过上限 ${MAX_EXTENSION_KEYS}`,
		);
	}
	const statuses = value.statuses.map((item, index) => {
		if (!isRecord(item)) {
			throw new PiExtensionProtocolError(`statuses[${index}] 必须是对象`);
		}
		requireKeys(item, ["key", "text"], `statuses[${index}]`);
		return {
			key: requireCodePoints(
				item.key,
				`statuses[${index}].key`,
				MAX_EXTENSION_KEY_CHARS,
			),
			text: requireCodePoints(
				item.text,
				`statuses[${index}].text`,
				MAX_EXTENSION_TEXT_CHARS,
			),
		};
	});
	const widgets = value.widgets.map((item, index) => {
		if (!isRecord(item)) {
			throw new PiExtensionProtocolError(`widgets[${index}] 必须是对象`);
		}
		requireKeys(item, ["key", "lines", "placement"], `widgets[${index}]`);
		if (!Array.isArray(item.lines) || item.lines.length > MAX_EXTENSION_WIDGET_LINES) {
			throw new PiExtensionProtocolError(
				`widgets[${index}].lines 数量超过上限 ${MAX_EXTENSION_WIDGET_LINES}`,
			);
		}
		return {
			key: requireCodePoints(
				item.key,
				`widgets[${index}].key`,
				MAX_EXTENSION_KEY_CHARS,
			),
			lines: item.lines.map((line, lineIndex) =>
				requireCodePoints(
					line,
					`widgets[${index}].lines[${lineIndex}]`,
					MAX_EXTENSION_LINE_CHARS,
				),
			),
			placement: requirePlacement(
				item.placement,
				`widgets[${index}].placement`,
			),
		};
	});
	const snapshot: PiExtensionUiSnapshot = {
		runtimeInstanceId: instanceId,
		runtimeRevision: revision,
		sequence: value.sequence as number,
		title,
		statuses,
		widgets,
	};
	if (encoder.encode(JSON.stringify(snapshot)).length > MAX_EXTENSION_SNAPSHOT_BYTES) {
		throw new PiExtensionProtocolError(
			`extensionUiSnapshot 超过字节上限 ${MAX_EXTENSION_SNAPSHOT_BYTES}`,
		);
	}
	return snapshot;
}

/** 命令调用名：不得含空白或斜杠，避免与模板语法混淆。 */
function requireCommandName(value: unknown, what: string): string {
	const name = requireCodePoints(value, what, MAX_EXTENSION_COMMAND_NAME_CHARS);
	if (/\s/.test(name) || name.includes("/") || name.includes("\\")) {
		throw new PiExtensionProtocolError(`${what} 不得包含空白或路径分隔符`);
	}
	return name;
}

/** 严格解析命令清单；未知字段（尤其来源路径）一律拒绝。 */
export function parsePiExtensionCommands(value: unknown): PiExtensionCommands {
	if (!isRecord(value)) {
		throw new PiExtensionProtocolError("extensionCommands 必须是对象");
	}
	requireKeys(
		value,
		["runtimeInstanceId", "runtimeRevision", "commands"],
		"extensionCommands",
	);
	if (!Array.isArray(value.commands) || value.commands.length > MAX_EXTENSION_COMMANDS) {
		throw new PiExtensionProtocolError(
			`commands 数量超过上限 ${MAX_EXTENSION_COMMANDS}`,
		);
	}
	const seen = new Set<string>();
	const commands = value.commands.map((item, index) => {
		if (!isRecord(item)) {
			throw new PiExtensionProtocolError(`commands[${index}] 必须是对象`);
		}
		requireKeys(item, ["name", "description"], `commands[${index}]`);
		const name = requireCommandName(item.name, `commands[${index}].name`);
		if (seen.has(name)) {
			throw new PiExtensionProtocolError(`commands 含重复调用名 ${name}`);
		}
		seen.add(name);
		return {
			name,
			description: requireCodePoints(
				item.description,
				`commands[${index}].description`,
				MAX_EXTENSION_COMMAND_DESC_CHARS,
			),
		};
	});
	return {
		runtimeInstanceId: requireCodePoints(
			value.runtimeInstanceId,
			"runtimeInstanceId",
			MAX_EXTENSION_ID_CHARS,
		),
		runtimeRevision: requireCodePoints(
			value.runtimeRevision,
			"runtimeRevision",
			MAX_EXTENSION_ID_CHARS,
		),
		commands,
	};
}

/** 严格解析命令参数（允许空串；不静默截断）。 */
export function assertPiExtensionCommandArgs(value: unknown): string {
	if (typeof value !== "string") {
		throw new PiExtensionProtocolError("command args 必须是字符串");
	}
	if (codePointLength(value) > MAX_EXTENSION_COMMAND_ARGS_CHARS) {
		throw new PiExtensionProtocolError(
			`command args 长度超过上限 ${MAX_EXTENSION_COMMAND_ARGS_CHARS}`,
		);
	}
	return value;
}

/** 严格解析迁移确认输入：正整数 revision + 两模式，无多余字段。 */
export function parsePiExecutionMigrationInput(
	value: unknown,
): PiExecutionMigrationInput {
	if (!isRecord(value)) {
		throw new PiExtensionProtocolError("executionMigration 必须是对象");
	}
	requireKeys(value, ["expectedRevision", "mode"], "executionMigration");
	if (
		!Number.isSafeInteger(value.expectedRevision) ||
		(value.expectedRevision as number) < 1
	) {
		throw new PiExtensionProtocolError("expectedRevision 必须是正整数");
	}
	if (!isPiToolExecutionMode(value.mode)) {
		throw new PiExtensionProtocolError(`mode 不受支持: ${String(value.mode)}`);
	}
	return {
		expectedRevision: value.expectedRevision as number,
		mode: value.mode,
	};
}
