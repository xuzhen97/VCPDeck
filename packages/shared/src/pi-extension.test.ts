/**
 * 受信扩展网页协议（命令 / 非阻塞 UI / 状态快照 / 迁移确认输入）。
 *
 * 锁定 ADR-0040 决策 3、5 的跨信任边界行为：这些值都来自受信扩展代码，
 * 属于不可信展示数据，必须严格拒绝未知字段、超限内容与歧义形状。
 */
import { describe, expect, it } from "vitest";
import {
	MAX_EXTENSION_COMMANDS,
	MAX_EXTENSION_KEYS,
	MAX_EXTENSION_WIDGET_LINES,
	parsePiExecutionMigrationInput,
	parsePiExtensionCommands,
	parsePiExtensionUiSnapshot,
	parsePiExtensionUiUpdate,
} from "./pi-extension.js";
import { parsePiRuntimeSpecV5 } from "./pi.js";

const emptySnapshot = () => ({
	runtimeInstanceId: null,
	runtimeRevision: null,
	sequence: 0,
	title: null,
	statuses: [],
	widgets: [],
});

describe("非阻塞 UI 更新", () => {
	it("状态与 Widget 的清除用字段缺失表达，不与空字符串混淆", () => {
		expect(parsePiExtensionUiUpdate({ kind: "setStatus", key: "work" })).toEqual({
			kind: "setStatus",
			key: "work",
		});
		expect(parsePiExtensionUiUpdate({ kind: "setWidget", key: "w" })).toEqual({
			kind: "setWidget",
			key: "w",
		});
	});

	it("空编辑填充分量是合法值（清空草稿）而不是缺字段", () => {
		expect(
			parsePiExtensionUiUpdate({
				kind: "set_editor_text",
				requestId: "r1",
				text: "",
			}),
		).toEqual({ kind: "set_editor_text", requestId: "r1", text: "" });
	});

	it.each([
		["非法 placement", { kind: "setWidget", key: "w", lines: ["a"], placement: "middle" }],
		["未知 kind", { kind: "custom", key: "w" }],
		["未知字段", { kind: "notify", message: "m", level: "info", extra: 1 }],
		["非法 level", { kind: "notify", message: "m", level: "fatal" }],
		["空 key", { kind: "setStatus", key: "" }],
		["缺失 requestId", { kind: "set_editor_text", text: "x" }],
		["setStatus 携带 lines", { kind: "setStatus", key: "k", lines: ["x"] }],
	])("%s 被拒绝", (_label, value) => {
		expect(() => parsePiExtensionUiUpdate(value)).toThrow();
	});

	it("文本按 Unicode code point 而非 UTF-16 长度限额", () => {
		// 4097 个 emoji：UTF-16 长度是 8194，但 code point 只有 4097，必须按后者拒绝。
		const emoji = "😀".repeat(4097);
		expect(() =>
			parsePiExtensionUiUpdate({ kind: "notify", message: emoji, level: "info" }),
		).toThrow();
		// 恰好 4096 个 code point 合法；若误用 UTF-16 长度则会被误拒。
		expect(
			parsePiExtensionUiUpdate({
				kind: "notify",
				message: "😀".repeat(4096),
				level: "info",
			}).kind,
		).toBe("notify");
	});
});

describe("扩展 UI 状态快照", () => {
	it("空快照是合法初值（无 wrapper 时不伪造运行态）", () => {
		expect(parsePiExtensionUiSnapshot(emptySnapshot())).toEqual(emptySnapshot());
	});

	it("拒绝超过 key 数量上限的快照", () => {
		const statuses = Array.from({ length: MAX_EXTENSION_KEYS + 1 }, (_, index) => ({
			key: `k${index}`,
			text: "t",
		}));
		expect(() => parsePiExtensionUiSnapshot({ ...emptySnapshot(), statuses })).toThrow();
	});

	it("拒绝超过行数上限的 Widget", () => {
		const lines = Array.from({ length: MAX_EXTENSION_WIDGET_LINES + 1 }, () => "l");
		expect(() =>
			parsePiExtensionUiSnapshot({
				...emptySnapshot(),
				widgets: [{ key: "w", lines, placement: "aboveEditor" }],
			}),
		).toThrow();
	});

	it("拒绝序列化后超出总字节预算的快照（单条合法但合计超限）", () => {
		const statuses = Array.from({ length: MAX_EXTENSION_KEYS }, (_, index) => ({
			key: `k${index}`,
			text: "x".repeat(4096),
		}));
		expect(() => parsePiExtensionUiSnapshot({ ...emptySnapshot(), statuses })).toThrow();
	});

	it("拒绝非单调 sequence 与非法 runtime 身份组合", () => {
		expect(() => parsePiExtensionUiSnapshot({ ...emptySnapshot(), sequence: -1 })).toThrow();
		expect(() =>
			parsePiExtensionUiSnapshot({ ...emptySnapshot(), runtimeInstanceId: "abc" }),
		).toThrow();
	});
});

describe("扩展命令清单", () => {
	const commands = {
		runtimeInstanceId: "inst-1",
		runtimeRevision: "rev-1",
		commands: [{ name: "fixture_ok", description: "ok" }],
	};

	it("接受合法清单", () => {
		expect(parsePiExtensionCommands(commands).commands).toHaveLength(1);
	});

	it.each([
		["含空白", [{ name: "a b", description: "d" }]],
		["含斜杠", [{ name: "a/b", description: "d" }]],
		["空名", [{ name: "", description: "d" }]],
		["多余字段", [{ name: "a", description: "d", sourceInfo: "/local/path.mjs" }]],
	])("拒绝命令名%s", (_label, list) => {
		expect(() =>
			parsePiExtensionCommands({ ...commands, commands: list }),
		).toThrow();
	});

	it("拒绝重复调用名与超出数量上限的清单", () => {
		expect(() =>
			parsePiExtensionCommands({
				...commands,
				commands: [
					{ name: "dup", description: "a" },
					{ name: "dup", description: "b" },
				],
			}),
		).toThrow();
		const many = Array.from({ length: MAX_EXTENSION_COMMANDS + 1 }, (_, index) => ({
			name: `c${index}`,
			description: "d",
		}));
		expect(() => parsePiExtensionCommands({ ...commands, commands: many })).toThrow();
	});

	it("缺少运行时身份时拒绝（命令必须绑定具体 runtime 实例）", () => {
		const { runtimeInstanceId: _omitted, ...withoutInstance } = commands;
		expect(() => parsePiExtensionCommands(withoutInstance)).toThrow();
	});
});

describe("执行语义迁移确认输入", () => {
	it("接受正整数 revision 与两模式", () => {
		expect(
			parsePiExecutionMigrationInput({ expectedRevision: 7, mode: "automatic" }),
		).toEqual({ expectedRevision: 7, mode: "automatic" });
	});

	it.each([
		["非整数 revision", { expectedRevision: 1.5, mode: "automatic" }],
		["负 revision", { expectedRevision: -1, mode: "automatic" }],
		["旧模式", { expectedRevision: 1, mode: "auto" }],
		["多余字段", { expectedRevision: 1, mode: "automatic", force: true }],
	])("拒绝%s", (_label, value) => {
		expect(() => parsePiExecutionMigrationInput(value)).toThrow();
	});
});

describe("RuntimeSpec v5（两模式、无逐工具策略）", () => {
	const validV5 = {
		schemaVersion: 5,
		specId: "spec-1",
		profileId: "profile-1",
		profileRevision: 3,
		providers: [
			{
				providerId: "fixture/test",
				name: "Fixture",
				protocol: "openai-completions",
				headers: {},
				models: [
					{
						id: "m1",
						name: "M1",
						metadataSource: "explicit",
						metadata: {
							id: "m1",
							name: "M1",
							reasoning: false,
							input: ["text"],
							contextWindow: 1000,
							maxTokens: 100,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							compat: {},
						},
					},
				],
			},
		],
		modelPolicy: {
			defaultModel: { provider: "fixture/test", modelId: "m1" },
			allowedModels: [{ provider: "fixture/test", modelId: "m1" }],
			defaultThinkingLevel: "medium",
		},
		toolExecutionMode: "supervised",
		runtimeRevision: "0123456789abcdef",
	};

	it("接受两模式", () => {
		expect(parsePiRuntimeSpecV5(validV5).toolExecutionMode).toBe("supervised");
		expect(
			parsePiRuntimeSpecV5({ ...validV5, toolExecutionMode: "automatic" })
				.toolExecutionMode,
		).toBe("automatic");
	});

	it("拒绝旧逐工具策略字段", () => {
		expect(() =>
			parsePiRuntimeSpecV5({
				...validV5,
				toolPolicy: { allow: ["read"], confirm: [], deny: [] },
			}),
		).toThrow(/toolPolicy/);
	});

	it("拒绝旧三模式取值", () => {
		for (const mode of ["auto", "yolo", "approval"]) {
			expect(() => parsePiRuntimeSpecV5({ ...validV5, toolExecutionMode: mode })).toThrow(
				/toolExecutionMode/,
			);
		}
	});

	it("拒绝旧 schemaVersion", () => {
		for (const schemaVersion of [1, 3, 4]) {
			expect(() => parsePiRuntimeSpecV5({ ...validV5, schemaVersion })).toThrow(
				/schemaVersion/,
			);
		}
	});

	it("保留 requiredBundle 且拒绝未知顶层字段", () => {
		expect(
			parsePiRuntimeSpecV5({
				...validV5,
				requiredBundle: {
					protocolVersion: 1,
					bundleVersion: "0.16.0",
					resourceIds: ["vcp.tool-policy"],
				},
			}).requiredBundle?.resourceIds,
		).toEqual(["vcp.tool-policy"]);
		expect(() => parsePiRuntimeSpecV5({ ...validV5, extra: true })).toThrow();
	});
});
