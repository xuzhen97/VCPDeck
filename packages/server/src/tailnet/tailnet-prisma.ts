/**
 * Tailnet 凭据模块实际使用的 Prisma 表面（ADR-0062）。
 *
 * 用显式 `Pick` 收窄依赖，同时保留与生成客户端的结构一致性：
 * schema 漂移（改列名/删委托）会在 `tsc` 编译期报错，不会静默失配。
 */
import type { PrismaService } from "../prisma/prisma.service.js";

export type TailnetPrisma = Pick<
	PrismaService,
	"tailnetCredential" | "tailnetClientOperation"
>;

/**
 * 调用方事务边界。
 *
 * 只收窄到本模块实际用到的委托：真实的 `Prisma.TransactionClient`
 * 与 `PrismaClient` 都与其结构兼容，无需引入生成客户端的内部类型。
 */
export type TailnetTransaction = Pick<TailnetPrisma, "tailnetCredential">;

/** 凭据行：直接从真实委托推导，避免手写形状与实际表结构漂移。 */
export type TailnetCredentialRow = NonNullable<
	Awaited<ReturnType<TailnetPrisma["tailnetCredential"]["findUnique"]>>
>;
