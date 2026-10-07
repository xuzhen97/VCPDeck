import type {
	PiExtensionUiSnapshot,
	PiExtensionUiUpdate,
	PiExtensionWidgetPlacement,
} from "@vcpdeck/shared";
import {
	MAX_EXTENSION_KEYS,
	MAX_EXTENSION_SNAPSHOT_BYTES,
} from "@vcpdeck/shared";

/**
 * 更新被接收或被拒绝的原因。
 *
 * - `STALE_GENERATION`：句柄来自已被替换的运行时换代/revision，晚到状态不得回写。
 * - `TOO_MANY_KEYS`：该类别 key 数已达上限，且请求要新增 key。
 * - `SNAPSHOT_TOO_LARGE`：写入后快照超过字节上限，已回滚。
 * - `TRANSIENT`：一次性动作（notify），不属于持续状态。
 * - `NOOP`：内容未变化或清除不存在的 key，未产生实际状态变更。
 */
export type PiExtensionUiRejectReason =
	| "STALE_GENERATION"
	| "TOO_MANY_KEYS"
	| "SNAPSHOT_TOO_LARGE"
	| "TRANSIENT"
	| "NOOP";

export type PiExtensionUiApplyResult =
	| { applied: true }
	| { applied: false; reason: PiExtensionUiRejectReason };

interface WidgetEntry {
	lines: string[];
	placement: PiExtensionWidgetPlacement;
}

/**
 * 单次运行时换代的有界 UI 状态写入句柄。
 *
 * 句柄在创建时绑定具体的运行时身份与 revision；`PiExtensionUiState` 一旦
 * 绑定到新的身份或 revision，旧句柄即失效。这样即使在 Worker 换代后收到
 * 迟到的旧状态，也无法覆盖新状态（ADR-0040 决策 4）。
 */
export interface PiExtensionUiView {
	apply(update: PiExtensionUiUpdate): PiExtensionUiApplyResult;
}

/**
 * 按会话运行时保存 status / widget / title 的最新有界快照。
 *
 * 不持久化：Worker 销毁或 Session 替换时调用 `clear()` 即可丢弃全部内容。
 * notify 属于一次性投影，由调用方转发，不进入本状态。
 */
export class PiExtensionUiState {
	private generation = 0;
	private instanceId: string | null = null;
	private revision: string | null = null;
	private sequence = 0;
	private title: string | null = null;
	private readonly statuses = new Map<string, string>();
	private readonly widgets = new Map<string, WidgetEntry>();

	/**
	 * 绑定到某一运行时换代，返回只对该换代有效的写入句柄。
	 *
	 * 身份或 revision 与当前不同即视为换代，清空全部旧状态；
	 * 与当前相同则保留已有状态（例如浏览器重连后重新读取最新快照）。
	 */
	bind(instanceId: string | null, revision: string | null): PiExtensionUiView {
		if (instanceId !== this.instanceId || revision !== this.revision) {
			this.reset(instanceId, revision);
		}
		const boundGeneration = this.generation;
		return {
			apply: (update) => this.apply(boundGeneration, update),
		};
	}

	/** 丢弃全部持续状态（Worker 销毁 / Session 替换）。 */
	clear(): void {
		this.reset(null, null);
	}

	snapshot(): PiExtensionUiSnapshot {
		return {
			runtimeInstanceId: this.instanceId,
			runtimeRevision: this.revision,
			sequence: this.sequence,
			title: this.title,
			statuses: [...this.statuses].map(([key, text]) => ({ key, text })),
			widgets: [...this.widgets].map(([key, entry]) => ({
				key,
				lines: [...entry.lines],
				placement: entry.placement,
			})),
		};
	}

	private reset(instanceId: string | null, revision: string | null): void {
		this.generation++;
		this.instanceId = instanceId;
		this.revision = revision;
		this.sequence = 0;
		this.title = null;
		this.statuses.clear();
		this.widgets.clear();
	}

	private apply(
		boundGeneration: number,
		update: PiExtensionUiUpdate,
	): PiExtensionUiApplyResult {
		if (boundGeneration !== this.generation) {
			return { applied: false, reason: "STALE_GENERATION" };
		}
		// notify 是一次性投影：状态层不留痕，也不推进 sequence。
		if (update.kind === "notify") {
			return { applied: false, reason: "TRANSIENT" };
		}
		// set_editor_text 是发给编辑器的请求，不是持续状态。
		if (update.kind === "set_editor_text") {
			return { applied: false, reason: "TRANSIENT" };
		}

		// 先做会失败的校验，再落盘；失败时不改动任何状态。
		if (update.kind === "setStatus" && update.text !== undefined) {
			if (
				!this.statuses.has(update.key) &&
				this.statuses.size >= MAX_EXTENSION_KEYS
			) {
				return { applied: false, reason: "TOO_MANY_KEYS" };
			}
		}
		if (update.kind === "setWidget" && update.lines !== undefined) {
			if (!this.widgets.has(update.key) && this.widgets.size >= MAX_EXTENSION_KEYS) {
				return { applied: false, reason: "TOO_MANY_KEYS" };
			}
		}

		const restore = this.capture(update);
		const changed = this.mutate(update);
		if (!changed) return { applied: false, reason: "NOOP" };

		if (this.snapshotBytes() > MAX_EXTENSION_SNAPSHOT_BYTES) {
			this.restoreFrom(restore);
			return { applied: false, reason: "SNAPSHOT_TOO_LARGE" };
		}

		this.sequence++;
		return { applied: true };
	}

	/** 记录受影响条目的原值，供超限回滚。 */
	private capture(update: PiExtensionUiUpdate): () => void {
		if (update.kind === "setTitle") {
			const previous = this.title;
			return () => {
				this.title = previous;
			};
		}
		if (update.kind === "setStatus") {
			const had = this.statuses.has(update.key);
			const previous = this.statuses.get(update.key);
			return () => {
				if (had) this.statuses.set(update.key, previous as string);
				else this.statuses.delete(update.key);
			};
		}
		// 仅 setWidget 会走到这里；其余 kind 在 apply 中已提前返回。
		if (update.kind !== "setWidget") return () => {};
		const had = this.widgets.has(update.key);
		const previous = this.widgets.get(update.key);
		return () => {
			if (had) this.widgets.set(update.key, previous as WidgetEntry);
			else this.widgets.delete(update.key);
		};
	}

	private restoreFrom(restore: () => void): void {
		restore();
	}

	/** 返回是否真正改变了状态；未变化视为 NOOP，不推进 sequence。 */
	private mutate(update: PiExtensionUiUpdate): boolean {
		switch (update.kind) {
			case "setTitle":
				if (this.title === update.title) return false;
				this.title = update.title;
				return true;
			case "setStatus": {
				if (update.text === undefined) {
					// 省略 text 表示清除；清除不存在的 key 是无操作。
					return this.statuses.delete(update.key);
				}
				if (this.statuses.get(update.key) === update.text) return false;
				this.statuses.set(update.key, update.text);
				return true;
			}
			case "setWidget": {
				if (update.lines === undefined) {
					return this.widgets.delete(update.key);
				}
				const placement = update.placement ?? "belowEditor";
				const previous = this.widgets.get(update.key);
				if (
					previous &&
					previous.placement === placement &&
					previous.lines.length === update.lines.length &&
					previous.lines.every((line, i) => line === update.lines?.[i])
				) {
					return false;
				}
				this.widgets.set(update.key, { lines: [...update.lines], placement });
				return true;
			}
			default:
				return false;
		}
	}

	private snapshotBytes(): number {
		return Buffer.byteLength(JSON.stringify(this.snapshot()), "utf8");
	}
}
