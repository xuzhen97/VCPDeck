import { describe, expect, it } from "vitest";
import {
	MAX_EXTENSION_KEYS,
	MAX_EXTENSION_LINE_CHARS,
	MAX_EXTENSION_SNAPSHOT_BYTES,
} from "@vcpdeck/shared";
import { PiExtensionUiState } from "./extension-ui.js";

function makeState() {
	return new PiExtensionUiState();
}

describe("PiExtensionUiState 有界持续状态", () => {
	it("status 数量有界：第 33 个新 key 被拒绝，已有 key 仍可更新", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");

		for (let i = 0; i < MAX_EXTENSION_KEYS; i++) {
			expect(view.apply({ kind: "setStatus", key: `k${i}`, text: "1" })).toMatchObject(
				{ applied: true },
			);
		}

		// 新 key 超限：拒绝并给出可诊断原因，不得静默丢弃或顶掉旧 key。
		expect(
			view.apply({ kind: "setStatus", key: "overflow", text: "x" }),
		).toMatchObject({ applied: false, reason: "TOO_MANY_KEYS" });
		expect(state.snapshot().statuses).toHaveLength(MAX_EXTENSION_KEYS);
		expect(
			state.snapshot().statuses.some((s) => s.key === "overflow"),
		).toBe(false);

		// 已有 key 的更新不受上限影响。
		expect(view.apply({ kind: "setStatus", key: "k0", text: "2" })).toMatchObject(
			{ applied: true },
		);
		expect(state.snapshot().statuses.find((s) => s.key === "k0")?.text).toBe("2");
	});

	it("setStatus 省略 text 表示清除该 key（与空串语义不同）", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");

		view.apply({ kind: "setStatus", key: "k", text: "hello" });
		expect(state.snapshot().statuses).toEqual([{ key: "k", text: "hello" }]);

		// 空串是合法文本，仍在快照里。
		view.apply({ kind: "setStatus", key: "k", text: "" });
		expect(state.snapshot().statuses).toEqual([{ key: "k", text: "" }]);

		// 省略 text 才是清除。
		view.apply({ kind: "setStatus", key: "k" });
		expect(state.snapshot().statuses).toEqual([]);
	});

	it("setWidget 省略 lines 表示清除；placement 缺省为 belowEditor", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");

		view.apply({ kind: "setWidget", key: "w", lines: ["a", "b"] });
		expect(state.snapshot().widgets).toEqual([
			{ key: "w", lines: ["a", "b"], placement: "belowEditor" },
		]);

		view.apply({
			kind: "setWidget",
			key: "w",
			lines: ["c"],
			placement: "aboveEditor",
		});
		expect(state.snapshot().widgets).toEqual([
			{ key: "w", lines: ["c"], placement: "aboveEditor" },
		]);

		view.apply({ kind: "setWidget", key: "w" });
		expect(state.snapshot().widgets).toEqual([]);
	});

	it("换代后晚到的旧状态不得覆盖新状态（ADR-0040 决策 4）", () => {
		const state = makeState();
		const oldView = state.bind("rt-1", "rev-1");
		oldView.apply({ kind: "setStatus", key: "k", text: "old" });

		// Worker 换代：身份与 revision 都变了。
		const newView = state.bind("rt-2", "rev-2");
		expect(state.snapshot().statuses).toEqual([]);
		newView.apply({ kind: "setStatus", key: "k", text: "new" });
		expect(state.snapshot().statuses).toEqual([{ key: "k", text: "new" }]);

		// 旧句柄（来自已淘汰的换代）不得写回。
		expect(
			oldView.apply({ kind: "setStatus", key: "k", text: "late" }),
		).toMatchObject({ applied: false, reason: "STALE_GENERATION" });
		expect(state.snapshot().statuses).toEqual([{ key: "k", text: "new" }]);
	});

	it("revision 变化同样使旧句柄失效", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");
		state.bind("rt-1", "rev-2");

		expect(
			view.apply({ kind: "setTitle", title: "stale" }),
		).toMatchObject({ applied: false, reason: "STALE_GENERATION" });
		expect(state.snapshot().title).toBeNull();
	});

	it("setTitle 只改标题，不影响 status/widget", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");
		view.apply({ kind: "setStatus", key: "k", text: "1" });
		view.apply({ kind: "setWidget", key: "w", lines: ["x"] });

		view.apply({ kind: "setTitle", title: "构建中" });

		const snap = state.snapshot();
		expect(snap.title).toBe("构建中");
		expect(snap.statuses).toEqual([{ key: "k", text: "1" }]);
		expect(snap.widgets).toHaveLength(1);
	});

	it("sequence 只在更新真正应用时递增", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");
		expect(state.snapshot().sequence).toBe(0);

		view.apply({ kind: "setStatus", key: "k", text: "1" });
		expect(state.snapshot().sequence).toBe(1);

		// 清除不存在的 key 是无操作：不推进 sequence。
		view.apply({ kind: "setStatus", key: "absent" });
		expect(state.snapshot().sequence).toBe(1);

		view.apply({ kind: "setTitle", title: "t" });
		expect(state.snapshot().sequence).toBe(2);
	});

	it("notify 不进入持续快照（短暂动作不重放）", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");

		const result = view.apply({
			kind: "notify",
			message: "本机不支持该命令",
			level: "warning",
		});

		// 通知属于一次性投影，由调用方转发；状态层不留痕、不推进 sequence。
		expect(result).toMatchObject({ applied: false, reason: "TRANSIENT" });
		const snap = state.snapshot();
		expect(snap.sequence).toBe(0);
		expect(snap.statuses).toEqual([]);
		expect(snap.widgets).toEqual([]);
	});

	it("快照超过字节上限时拒绝该更新，而不是静默截断内容", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");

		// 单条 widget 行受 MAX_EXTENSION_LINE_CHARS 限制，靠数量堆到超限。
		const line = "x".repeat(MAX_EXTENSION_LINE_CHARS);
		const lines = Array.from({ length: 100 }, () => line);
		let rejected = 0;
		for (let i = 0; i < MAX_EXTENSION_KEYS; i++) {
			const result = view.apply({ kind: "setWidget", key: `w${i}`, lines });
			if (!result.applied) {
				expect(result.reason).toBe("SNAPSHOT_TOO_LARGE");
				rejected++;
				break;
			}
		}

		expect(rejected).toBeGreaterThan(0);
		const snap = state.snapshot();
		// 被拒绝的更新不得留下半截内容。
		expect(JSON.stringify(snap).length).toBeLessThanOrEqual(
			MAX_EXTENSION_SNAPSHOT_BYTES,
		);
		for (const widget of snap.widgets) {
			expect(widget.lines).toHaveLength(100);
		}
	});

	it("快照携带绑定时的运行时身份与 revision", () => {
		const state = makeState();
		state.bind("rt-9", "rev-9");
		expect(state.snapshot()).toMatchObject({
			runtimeInstanceId: "rt-9",
			runtimeRevision: "rev-9",
		});
	});

	it("clear() 清空全部持续状态（Worker 销毁 / Session 替换）", () => {
		const state = makeState();
		const view = state.bind("rt-1", "rev-1");
		view.apply({ kind: "setStatus", key: "k", text: "1" });
		view.apply({ kind: "setTitle", title: "t" });

		state.clear();

		expect(state.snapshot()).toMatchObject({
			runtimeInstanceId: null,
			runtimeRevision: null,
			title: null,
			statuses: [],
			widgets: [],
		});
		// 清空后旧句柄同样失效。
		expect(
			view.apply({ kind: "setStatus", key: "k", text: "2" }),
		).toMatchObject({ applied: false, reason: "STALE_GENERATION" });
	});
});
