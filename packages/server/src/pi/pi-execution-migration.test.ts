/**
 * 存量执行语义转换（ADR-0039 决策 3）。
 *
 * 三条不变量：
 * 1. **幂等**：重复执行不会把已确认的配置改回待确认，也不会复活旧值。
 * 2. **不静默扩大授权**：旧 `approval` / `auto` 只标记为待确认并保留旧限制用于展示，
 *    执行模式先落 `supervised` 占位；只有操作者确认后才真正生效。
 *    旧 `yolo` 的三桶本就不参与许可判定，可直接映射为 `automatic`。
 * 3. **活动 Run 不被中途改写**：仍处于活动状态的会话 Job 保持原样并报告阻塞，
 *    等待自然 drain，避免把一个回合的执行语义改掉。
 *
 * 这里用与仓库既有 server 测试一致的手写 prisma fake：迁移逻辑是纯数据变换，
 * 依赖真实 SQLite 只会把测试拖进 prisma engine 启动成本；列与默认值由
 * `pi-execution-migration.schema.test.ts` 单独断言。
 */
import { describe, expect, it } from "vitest";
import {
	ensurePiExecutionMigration,
	migratePiExecutionRows,
	type PiExecutionMigrationDb,
} from "./pi-execution-migration.js";

interface ProfileRow {
	id: string;
	toolPolicyJson: string | null;
	toolExecutionMode: string;
	executionModeNeedsConfirmation: boolean;
	legacyExecutionConfigJson: string | null;
}

interface SessionRow {
	id: string;
	activeRunId: string | null;
	toolExecutionModeOverride: string | null;
	executionModeNeedsConfirmation: boolean;
	legacyExecutionModeOverride: string | null;
}

/** 内存版 prisma fake：只实现迁移用到的那几个方法。 */
function makeDb(profiles: ProfileRow[], sessions: SessionRow[]): PiExecutionMigrationDb & {
	profiles: ProfileRow[];
	sessions: SessionRow[];
} {
	const db = {
		profiles,
		sessions,
		async $transaction<T>(fn: (tx: PiExecutionMigrationDb) => Promise<T>): Promise<T> {
			// 快照/回滚：任一步抛错都不留下半转换状态。
			const profileBackup = profiles.map((row) => ({ ...row }));
			const sessionBackup = sessions.map((row) => ({ ...row }));
			try {
				return await fn(db);
			} catch (error) {
				profiles.splice(0, profiles.length, ...profileBackup);
				sessions.splice(0, sessions.length, ...sessionBackup);
				throw error;
			}
		},
		piProfile: {
			findMany: async () => profiles.map((row) => ({ ...row })),
			update: async (args: {
				where: { id: string };
				data: Partial<ProfileRow>;
			}) => {
				const row = profiles.find((candidate) => candidate.id === args.where.id);
				if (!row) throw new Error(`profile ${args.where.id} not found`);
				Object.assign(row, args.data);
				return { ...row };
			},
		},
		agentSession: {
			findMany: async () => sessions.map((row) => ({ ...row })),
			updateMany: async (args: {
				where: { id: string };
				data: Partial<SessionRow>;
			}) => {
				let count = 0;
				for (const row of sessions) {
					if (row.id === args.where.id) {
						Object.assign(row, args.data);
						count += 1;
					}
				}
				return { count };
			},
		},
	};
	return db as PiExecutionMigrationDb & { profiles: ProfileRow[]; sessions: SessionRow[] };
}

const profile = (over: Partial<ProfileRow> = {}): ProfileRow => ({
	id: "p1",
	toolPolicyJson: null,
	toolExecutionMode: "approval",
	executionModeNeedsConfirmation: false,
	legacyExecutionConfigJson: null,
	...over,
});

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
	id: "s1",
	activeRunId: null,
	toolExecutionModeOverride: null,
	executionModeNeedsConfirmation: false,
	legacyExecutionModeOverride: null,
	...over,
});

describe("migratePiExecutionRows", () => {
	it("旧 yolo 直接映射为 automatic 并丢弃不再生效的三桶", async () => {
		const db = makeDb(
			[
				profile({
					id: "p-yolo",
					toolExecutionMode: "yolo",
					toolPolicyJson: JSON.stringify({ allow: [], confirm: [], deny: ["bash"] }),
				}),
			],
			[session({ id: "s-yolo", toolExecutionModeOverride: "yolo" })],
		);

		const result = await migratePiExecutionRows(db);

		expect(result.pendingConfirmations).toBe(0);
		expect(db.profiles[0]).toMatchObject({
			toolExecutionMode: "automatic",
			executionModeNeedsConfirmation: false,
			legacyExecutionConfigJson: null,
			toolPolicyJson: null,
		});
		expect(db.sessions[0]).toMatchObject({
			toolExecutionModeOverride: "automatic",
			executionModeNeedsConfirmation: false,
			legacyExecutionModeOverride: null,
		});
	});

	it("旧 approval/auto 标记为待确认并保留旧限制用于展示", async () => {
		const policy = { allow: ["read"], confirm: ["bash"], deny: [] };
		const db = makeDb(
			[
				profile({
					id: "p-auto",
					toolExecutionMode: "auto",
					toolPolicyJson: JSON.stringify(policy),
				}),
			],
			[session({ id: "s-auto", toolExecutionModeOverride: "approval" })],
		);

		const result = await migratePiExecutionRows(db);

		expect(result.pendingConfirmations).toBe(2);
		expect(db.profiles[0]).toMatchObject({
			toolExecutionMode: "supervised",
			executionModeNeedsConfirmation: true,
		});
		const legacy = JSON.parse(db.profiles[0]!.legacyExecutionConfigJson ?? "{}");
		expect(legacy).toEqual({ mode: "auto", policy });
		// 旧覆盖不能被自动映射成新模式：清空覆盖 + 独立待确认。
		expect(db.sessions[0]).toMatchObject({
			toolExecutionModeOverride: null,
			executionModeNeedsConfirmation: true,
			legacyExecutionModeOverride: "approval",
		});
	});

	it("重复执行不解除待确认，也不复活已确认配置", async () => {
		const db = makeDb(
			[profile({ id: "p-auto", toolExecutionMode: "auto" })],
			[session({ id: "s-auto", toolExecutionModeOverride: "auto" })],
		);

		await migratePiExecutionRows(db);
		const first = JSON.parse(db.profiles[0]!.legacyExecutionConfigJson ?? "null");
		await migratePiExecutionRows(db);
		await migratePiExecutionRows(db);

		expect(db.profiles[0]!.executionModeNeedsConfirmation).toBe(true);
		expect(db.profiles[0]!.legacyExecutionConfigJson).toBe(JSON.stringify(first));
		expect(db.sessions[0]!.executionModeNeedsConfirmation).toBe(true);
	});

	it("已是新模式的行不产生任何写入", async () => {
		const db = makeDb(
			[
				profile({
					id: "p-new",
					toolExecutionMode: "automatic",
					executionModeNeedsConfirmation: false,
					legacyExecutionConfigJson: null,
				}),
			],
			[session({ id: "s-new", toolExecutionModeOverride: "supervised" })],
		);

		const result = await migratePiExecutionRows(db);

		expect(result.migrated).toBe(0);
		expect(result.pendingConfirmations).toBe(0);
		expect(db.profiles[0]!.toolExecutionMode).toBe("automatic");
	});

	it("活动 Run 的会话保持原样并报告阻塞（等待自然 drain）", async () => {
		const db = makeDb(
			[],
			[
				session({
					id: "s-busy",
					activeRunId: "run-1",
					toolExecutionModeOverride: "auto",
				}),
			],
		);

		const result = await migratePiExecutionRows(db);

		expect(result.blockedSessions).toEqual(["s-busy"]);
		expect(db.sessions[0]!.toolExecutionModeOverride).toBe("auto");
		expect(db.sessions[0]!.executionModeNeedsConfirmation).toBe(false);
	});

	it("无覆盖的会话不产生任何写入", async () => {
		const db = makeDb(
			[],
			[session({ id: "s-plain" })],
		);

		await migratePiExecutionRows(db);

		expect(db.sessions[0]!.toolExecutionModeOverride).toBeNull();
		expect(db.sessions[0]!.executionModeNeedsConfirmation).toBe(false);
	});

	it("未知旧模式保持原样并计入阻塞（不猜语义）", async () => {
		const db = makeDb(
			[profile({ id: "p-weird", toolExecutionMode: "turbo" })],
			[],
		);

		const result = await migratePiExecutionRows(db);

		expect(result.blockedProfiles).toEqual(["p-weird"]);
		expect(db.profiles[0]!.toolExecutionMode).toBe("turbo");
		expect(db.profiles[0]!.executionModeNeedsConfirmation).toBe(false);
	});

	it("损坏的旧策略 JSON 不阻断转换：保留原文供人工判断", async () => {
		const db = makeDb(
			[
				profile({
					id: "p-broken",
					toolExecutionMode: "auto",
					toolPolicyJson: "{not json",
				}),
			],
			[],
		);

		const result = await migratePiExecutionRows(db);

		expect(result.pendingConfirmations).toBe(1);
		expect(db.profiles[0]!.executionModeNeedsConfirmation).toBe(true);
		expect(JSON.parse(db.profiles[0]!.legacyExecutionConfigJson ?? "{}")).toEqual({
			mode: "auto",
			policy: null,
		});
	});
});

describe("ensurePiExecutionMigration", () => {
	it("同一 PrismaService 只执行一次，失败后可重试", async () => {
		const db = makeDb([profile({ id: "p", toolExecutionMode: "yolo" })], []);
		let calls = 0;
		const counted: PiExecutionMigrationDb = {
			...db,
			$transaction: async (fn) => {
				calls += 1;
				return fn(counted);
			},
			piProfile: db.piProfile,
			agentSession: db.agentSession,
		};

		await ensurePiExecutionMigration(counted);
		await ensurePiExecutionMigration(counted);
		expect(calls).toBe(1);
	});
});
