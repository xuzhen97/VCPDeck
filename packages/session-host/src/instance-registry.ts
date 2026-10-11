import {
	type SessionHostErrorCode,
	type SessionHostInstanceInfo,
	type SessionHostKind,
	sessionHostError,
} from "@vcpdeck/shared";
import type { PtySession } from "./pty-session.js";

/** 宿主侧操作失败。与协议错误区分：这是已通过校验的请求在业务上的失败。 */
export class SessionHostOperationError extends Error {
	readonly code: SessionHostErrorCode;
	readonly safeMessage: string;
	constructor(code: SessionHostErrorCode, message: string) {
		super(message);
		this.name = "SessionHostOperationError";
		this.code = code;
		this.safeMessage = sessionHostError(code, message).message;
	}
}

export interface RegistryInstance {
	instanceId: string;
	kind: SessionHostKind;
	cwd: string;
	operationId: string;
	/** 实例创建时刻。必须在启动时固化，不得在每次查询时重新取当前时间。 */
	startedAt: string;
	session: PtySession;
}

export interface InstanceRegistryOptions {
	/** 同时在管实例上限。越限拒绝，不排队、不驱逐已有实例。 */
	maxInstances?: number;
	createId: () => string;
	now?: () => string;
	start: (input: { instanceId: string; kind: SessionHostKind; cwd: string }) => PtySession;
}

export interface InstanceRegistry {
	start(input: { operationId: string; kind: SessionHostKind; cwd: string }): {
		instanceId: string;
		reused: boolean;
	};
	list(): SessionHostInstanceInfo[];
	get(instanceId: string): RegistryInstance | undefined;
	/** 终止实例并返回退出确认结果；未确认时不冒充已退出。 */
	stop(instanceId: string): Promise<{ exited: boolean }>;
	size(): number;
}

const DEFAULT_MAX_INSTANCES = 16;

/**
 * 受管实例登记表。
 *
 * 语义要点：
 * - `operationId` 是幂等键。同键重复 start 一律复用既有实例，绝不重复启动 ——
 *   重试、响应丢失后的重发都不能造成第二个进程。
 * - 只有 operationId 相同才复用；不同 operationId 即使 kind 与 cwd 相同也各自独立。
 * - 越限拒绝而非驱逐：静默杀掉别人的实例比拒绝启动危险得多。
 */
export function createInstanceRegistry(options: InstanceRegistryOptions): InstanceRegistry {
	const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
	const now = options.now ?? (() => new Date().toISOString());
	const byId = new Map<string, RegistryInstance>();
	const byOperationId = new Map<string, string>();

	return {
		start(input) {
			const existingId = byOperationId.get(input.operationId);
			if (existingId !== undefined) {
				// 幂等复用：无论该实例当前是什么状态，都返回同一个 instanceId，
				// 由调用方据实读取状态，不新建、不重启、不伪装。
				return { instanceId: existingId, reused: true };
			}

			if (byId.size >= maxInstances) {
				throw new SessionHostOperationError(
					"SESSION_HOST_INSTANCE_LIMIT_REACHED",
					`同时在管实例已达上限 ${maxInstances}`,
				);
			}

			// instanceId 由宿主生成，不使用 pid，也不由调用方指定。
			const instanceId = options.createId();
			if (byId.has(instanceId) || instanceId.length === 0) {
				throw new SessionHostOperationError("SESSION_HOST_INSTANCE_CONFLICT", "生成的身份冲突或为空");
			}

			const startedAt = now();
			const session = options.start({ instanceId, kind: input.kind, cwd: input.cwd });
			byId.set(instanceId, {
				instanceId,
				kind: input.kind,
				cwd: input.cwd,
				operationId: input.operationId,
				startedAt,
				session,
			});
			byOperationId.set(input.operationId, instanceId);
			return { instanceId, reused: false };
		},

		list() {
			// 只出站公开字段：不含 cwd 与 operationId，避免路径出现在链路与审计里。
			return [...byId.values()].map((record) => ({
				instanceId: record.instanceId,
				kind: record.kind,
				state: record.session.state,
				startedAt: record.startedAt,
				lastSeq: record.session.lastSeq,
			}));
		},

		get(instanceId) {
			return byId.get(instanceId);
		},

		async stop(instanceId) {
			const record = byId.get(instanceId);
			if (record === undefined) {
				throw new SessionHostOperationError("SESSION_HOST_INSTANCE_NOT_FOUND", "实例不存在或已结束");
			}
			return record.session.stop();
		},

		size() {
			return byId.size;
		},
	};
}
