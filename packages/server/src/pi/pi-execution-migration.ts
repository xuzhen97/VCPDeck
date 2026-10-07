/**
 * 存量执行语义转换（ADR-0039 决策 3、4）。
 *
 * 背景：升级前 Profile 保存逐工具三桶 + `approval/auto/yolo`，Session Job 保存
 * 同值覆盖。ADR-0039 删除三桶并只保留 `supervised/automatic`，因此必须把存量行
 * 显式转成新语义，且**不得静默扩大授权**。
 *
 * 规则：
 * - 旧 `yolo`：三桶本就不参与许可判定，直接映射为 `automatic`，旧策略列清空；
 * - 旧 `approval` / `auto`：先落 `supervised` 占位并标记待确认，**保留旧限制原文**
 *   仅供操作者判断；确认前该 Profile/会话不参与新 RuntimeSpec；
 * - 活动 Run（pending/running/waiting_input/disconnected）的会话保持原样并报告阻塞，
 *   等自然 drain，避免在回合中途改写执行语义；
 * - 未知旧值不猜：保持原样并报告，由上层以稳定错误码判定 Pi 不可用。
 *
 * 之所以是应用内可重入转换而不是一条 migration.sql：本仓库 Server 启动/发布
 * 都走 `prisma db push`（见 `scripts/pack-release.ts` 的 preStart），SQL 迁移目录
 * 不会自动执行数据转换。
 */
import {
	isPiLegacyToolExecutionMode,
	isPiToolExecutionMode,
	parsePiToolPolicy,
	type LegacyPiToolPolicy,
} from "@vcpdeck/shared";

/** 迁移读取的 Profile 列（旧列保留为迁移源，不再参与运行时授权）。 */
export interface PiExecutionMigrationProfileRow {
	id: string;
	toolPolicyJson: string | null;
	toolExecutionMode: string;
	executionModeNeedsConfirmation: boolean;
	legacyExecutionConfigJson: string | null;
}

/** 迁移读取的 Job 列。 */
export interface PiExecutionMigrationJobRow {
	id: string;
	type: string;
	status: string;
	toolExecutionModeOverride: string | null;
	runExecutionMode: string | null;
	executionModeNeedsConfirmation: boolean;
	legacyExecutionModeOverride: string | null;
}

/** 迁移用到的 prisma 最小面；与 `PrismaService` 结构兼容。 */
export interface PiExecutionMigrationDb {
	$transaction<T>(fn: (tx: PiExecutionMigrationDb) => Promise<T>): Promise<T>;
	piProfile: {
		findMany(): Promise<PiExecutionMigrationProfileRow[]>;
		update(args: {
			where: { id: string };
			data: Partial<PiExecutionMigrationProfileRow>;
		}): Promise<unknown>;
	};
	job: {
		findMany(): Promise<PiExecutionMigrationJobRow[]>;
		updateMany(args: {
			where: { id: string };
			data: Partial<PiExecutionMigrationJobRow>;
		}): Promise<{ count: number }>;
	};
}

export interface PiExecutionMigrationResult {
	/** 本次实际改写的行数（Profile + 会话 Job）。 */
	migrated: number;
	/** 仍需操作者显式确认的 Profile/会话数量。 */
	pendingConfirmations: number;
	/** 旧值非法、未被转换的 Profile。 */
	blockedProfiles: string[];
	/** 活动 Run 或旧值非法的会话（等待 drain 或人工处理）。 */
	blockedSessions: string[];
}

/** 与 Run 状态机一致的活动状态：这些会话不能被改写。 */
const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"running",
	"waiting_input",
	"disconnected",
]);

/** 仅迁移 Pi 会话 Job；普通 Job 的同名列属于无关数据。 */
const SESSION_JOB_TYPE = "agent.session";

/**
 * 旧策略列 → 可展示的旧策略。
 *
 * 按旧三桶形状严格校验：损坏或形状非法的列返回 null（界面提示人工判断），
 * 不把任意 JSON 原文写入迁移材料并回显到网页。
 */
function parseLegacyPolicy(raw: string | null): LegacyPiToolPolicy | null {
	if (raw === null) return null;
	try {
		return parsePiToolPolicy(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** 在单个事务内完成 Profile 与会话 Job 的转换。 */
export async function migratePiExecutionRows(
	db: PiExecutionMigrationDb,
): Promise<PiExecutionMigrationResult> {
	return db.$transaction(async (tx) => {
		const result: PiExecutionMigrationResult = {
			migrated: 0,
			pendingConfirmations: 0,
			blockedProfiles: [],
			blockedSessions: [],
		};

		for (const row of await tx.piProfile.findMany()) {
			// 已处于待确认：幂等跳过，绝不把已确认配置改回待确认。
			if (row.executionModeNeedsConfirmation) {
				result.pendingConfirmations += 1;
				continue;
			}
			const mode = row.toolExecutionMode;
			if (isPiToolExecutionMode(mode)) continue;
			if (mode === "yolo") {
				await tx.piProfile.update({
					where: { id: row.id },
					data: {
						toolExecutionMode: "automatic",
						toolPolicyJson: null,
						executionModeNeedsConfirmation: false,
						legacyExecutionConfigJson: null,
					},
				});
				result.migrated += 1;
				continue;
			}
			if (isPiLegacyToolExecutionMode(mode)) {
				await tx.piProfile.update({
					where: { id: row.id },
					data: {
						toolExecutionMode: "supervised",
						executionModeNeedsConfirmation: true,
						legacyExecutionConfigJson: JSON.stringify({
							mode,
							policy: parseLegacyPolicy(row.toolPolicyJson),
						}),
					},
				});
				result.pendingConfirmations += 1;
				continue;
			}
			// 未知旧值：保持原样并上报，由上层 fail closed。
			result.blockedProfiles.push(row.id);
		}

		for (const row of await tx.job.findMany()) {
			if (row.type !== SESSION_JOB_TYPE) continue;
			if (ACTIVE_JOB_STATUSES.has(row.status)) {
				result.blockedSessions.push(row.id);
				continue;
			}
			if (row.executionModeNeedsConfirmation) {
				result.pendingConfirmations += 1;
				continue;
			}
			const override = row.toolExecutionModeOverride;
			if (override === null) continue;
			if (override === "yolo") {
				await tx.job.updateMany({
					where: { id: row.id },
					data: {
						toolExecutionModeOverride: "automatic",
						executionModeNeedsConfirmation: false,
						legacyExecutionModeOverride: null,
					},
				});
				result.migrated += 1;
				continue;
			}
			if (isPiLegacyToolExecutionMode(override)) {
				// 旧 approval/auto 的限制语义不能被自动映射：清空覆盖并独立置为待确认。
				await tx.job.updateMany({
					where: { id: row.id },
					data: {
						toolExecutionModeOverride: null,
						executionModeNeedsConfirmation: true,
						legacyExecutionModeOverride: override,
					},
				});
				result.pendingConfirmations += 1;
				continue;
			}
			result.blockedSessions.push(row.id);
		}

		return result;
	});
}

/**
 * 进程内单例入口：同一 PrismaService 只转换一次，失败后删除缓存允许重试。
 *
 * 调用方（Profile/Run 服务、Runtime 下发）在使用数据前 await 本函数，
 * 保证不会先按旧枚举解释新协议，也不会在未转换时组装 RuntimeSpec。
 */
const inflight = new WeakMap<object, Promise<PiExecutionMigrationResult>>();

export function ensurePiExecutionMigration(
	db: PiExecutionMigrationDb,
): Promise<PiExecutionMigrationResult> {
	const existing = inflight.get(db);
	if (existing) return existing;
	const running = migratePiExecutionRows(db).catch((error: unknown) => {
		// 失败不粘滞：删掉缓存，让下一次请求重新尝试（升级窗口内可能短暂失败）。
		inflight.delete(db);
		throw error;
	});
	inflight.set(db, running);
	return running;
}
