/**
 * Git SSH 分发模块实际使用的 Prisma 表面。
 *
 * 用显式 `Pick` 收窄依赖：本模块只需要这两张表的委托，依赖关系一眼可见。
 * 同时保留与生成客户端的结构一致性——`Pick` 直接取自 `PrismaService`，
 * 因此 schema 漂移（改列名/删委托）会在 `tsc` 编译期报错，不会静默失配。
 */
import type { PrismaService } from "../prisma/prisma.service.js";

export type GitSshPrisma = Pick<PrismaService, "gitSshKey" | "gitSshTarget">;

/** 密钥行：直接从真实委托推导，避免手写形状与实际表结构漂移。 */
export type GitSshKeyRow = NonNullable<
	Awaited<ReturnType<GitSshPrisma["gitSshKey"]["findFirst"]>>
>;

/** 目标行：同上。 */
export type GitSshTargetRow = NonNullable<
	Awaited<ReturnType<GitSshPrisma["gitSshTarget"]["findUnique"]>>
>;
