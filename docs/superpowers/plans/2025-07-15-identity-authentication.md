# 身份认证系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 VCPDeck 实现用户名+密码浏览器登录 + CLI Bearer Token 认证，admin 管理其他身份，所有身份功能权限相同。

**Architecture:** NestJS 全局 AuthGuard → ActorContext → 业务模块；Cookie（浏览器）和 Bearer Token（CLI）两种认证方式；Socket.IO 拆为 `/client`（PSK）和 `/app`（用户凭证）两个 namespace；前端 React + Vite，用 react-router-dom 路由、Context 存身份。

**Tech Stack:** NestJS 10, Prisma 7 + SQLite (libsql), bcryptjs, cookie-parser, React 18, react-router-dom v6

## Global Constraints

- 不建 Role/Permission 表，唯一权限判断：`isAdmin` 控制 `/api/identities/**`
- Token 明文 32 字节 hex + `vcp_` 前缀，数据库只存 SHA-256
- 密码用 bcryptjs，cost factor 10
- 所有认证失败统一返回 `{ code, message }`，不区分"用户不存在"和"密码错误"
- Session Cookie: HttpOnly, Secure(生产), SameSite=Strict, 默认 7 天
- 前端不持久化 Token 明文（只用 Cookie），CLI Token 生成后前端也不保存
- 日志不记录 password、token、Cookie、Authorization header

---

### Task 1: 共享类型定义

**Files:**

- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Produces: `ActorContext`, `AuthErrorCode`, `LoginRequest`, `LoginResponse`, `IdentityInfo`, `CreateIdentityRequest`, `UpdateMeRequest`, `CreateTokenRequest`, `TokenInfo`

- [ ] **Step 1: 在 `packages/shared/src/index.ts` 末尾追加认证相关类型**

```ts
// ── 认证 ──

export interface ActorContext {
  identityId: string;
  displayName: string;
  isAdmin: boolean;
  credentialId: string | null;
  sessionId: string | null;
  source: "web" | "cli";
  requestId: string;
}

export const AuthErrorCode = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_INVALID: "AUTH_INVALID",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  AUTH_REVOKED: "AUTH_REVOKED",
  IDENTITY_DISABLED: "IDENTITY_DISABLED",
  FORBIDDEN: "FORBIDDEN",
} as const;

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  identity: {
    id: string;
    username: string;
    displayName: string;
    isAdmin: boolean;
  };
}

export interface IdentityInfo {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
}

export interface CreateIdentityRequest {
  username: string;
  password: string;
  displayName: string;
}

export interface UpdateMeRequest {
  username?: string;
  password?: string;
  currentPassword: string;
}

export interface CreateTokenRequest {
  label: string;
}

export interface TokenInfo {
  id: string;
  label: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateTokenResponse {
  id: string;
  token: string;
  label: string;
}
```

- [ ] **Step 2: 构建验证类型正确导出**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/shared build
```

Expected: PASS，无类型错误

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): 新增 ActorContext、认证类型和错误码常量"
```

---

### Task 2: 数据库 Schema + 迁移

**Files:**

- Modify: `packages/server/prisma/schema.prisma`
- Create: `packages/server/prisma/migrations/` (Prisma 自动生成)

**Interfaces:**

- Consumes: 无
- Produces: `Identity`, `Credential`, `AuthSession` 表；`Job` 表新增 `createdByIdentityId`, `createdByName`, `createdVia`

- [ ] **Step 1: 修改 `packages/server/prisma/schema.prisma`**

在 `model Job` 之后追加：

```prisma
model Identity {
  id           String         @id
  username     String         @unique
  displayName  String
  passwordHash String
  isAdmin      Boolean        @default(false)
  disabledAt   DateTime?
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  credentials  Credential[]
  sessions     AuthSession[]
}

model Credential {
  id         String    @id
  identityId String
  identity   Identity  @relation(fields: [identityId], references: [id])
  label      String
  tokenHash  String    @unique
  lastUsedAt DateTime?
  expiresAt  DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())
}

model AuthSession {
  id          String    @id
  identityId  String
  identity    Identity  @relation(fields: [identityId], references: [id])
  sessionHash String    @unique
  expiresAt   DateTime
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())
}
```

在 `model Job` 的现有字段中追加三个审计字段（在 `updatedAt` 之前）：

```prisma
  createdByIdentityId String?
  createdByName       String?
  createdVia          String?
```

- [ ] **Step 2: 运行 `prisma db push` 同步数据库并验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server exec prisma db push
```

Expected: "Your database is now in sync with your schema."

- [ ] **Step 3: 生成 Prisma Client**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server exec prisma generate
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/prisma/schema.prisma
git commit -m "feat(db): 新增 Identity/Credential/AuthSession 表，Job 新增审计字段"
```

---

### Task 3: Auth 模块（登录/登出/Token/个人信息）

**Files:**

- Create: `packages/server/src/auth/auth.module.ts`
- Create: `packages/server/src/auth/auth.service.ts`
- Create: `packages/server/src/auth/auth.controller.ts`
- Create: `packages/server/src/auth/auth.guard.ts`
- Create: `packages/server/src/auth/actor.decorator.ts`
- Create: `packages/server/src/auth/public.decorator.ts`

**Interfaces:**

- Consumes: `PrismaService` (from existing prisma module), `ActorContext`, `LoginRequest`, `LoginResponse`, `IdentityInfo`, `UpdateMeRequest`, `CreateTokenRequest`, `TokenInfo`, `CreateTokenResponse` (from shared)
- Produces: `AuthService`, `AuthGuard`, `@Public()`, `@Actor()` decorator

- [ ] **Step 1: 创建 `packages/server/src/auth/public.decorator.ts`**

```ts
import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 2: 创建 `packages/server/src/auth/actor.decorator.ts`**

```ts
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { ActorContext } from "@vcpdeck/shared";

export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActorContext => {
    const req = ctx.switchToHttp().getRequest();
    return req.actor;
  },
);
```

- [ ] **Step 3: 创建 `packages/server/src/auth/auth.guard.ts`**

```ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "@vcpdeck/shared";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const actor = await this.resolveActor(req);
    if (!actor) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: "AUTH_REQUIRED",
        message: "Authentication required",
      });
    }
    req.actor = actor;
    return true;
  }

  private async resolveActor(req: any): Promise<ActorContext | null> {
    // 1. Cookie session
    const sessionToken = req.cookies?.vcpdeck_session;
    if (sessionToken) {
      const hash = sha256(sessionToken);
      const session = await this.prisma.authSession.findUnique({ where: { sessionHash: hash } });
      if (session && !session.revokedAt && session.expiresAt > new Date()) {
        const identity = await this.prisma.identity.findUnique({ where: { id: session.identityId } });
        if (identity && !identity.disabledAt) {
          return {
            identityId: identity.id,
            displayName: identity.displayName,
            isAdmin: identity.isAdmin,
            credentialId: null,
            sessionId: session.id,
            source: "web",
            requestId: randomUUID(),
          };
        }
      }
    }

    // 2. Bearer token
    const auth = req.headers?.authorization;
    if (auth?.startsWith("Bearer ")) {
      const token = auth.slice(7);
      const hash = sha256(token);
      const cred = await this.prisma.credential.findUnique({ where: { tokenHash: hash } });
      if (cred && !cred.revokedAt && (!cred.expiresAt || cred.expiresAt > new Date())) {
        const identity = await this.prisma.identity.findUnique({ where: { id: cred.identityId } });
        if (identity && !identity.disabledAt) {
          return {
            identityId: identity.id,
            displayName: identity.displayName,
            isAdmin: identity.isAdmin,
            credentialId: cred.id,
            sessionId: null,
            source: "cli",
            requestId: randomUUID(),
          };
        }
      }
    }

    return null;
  }
}
```

- [ ] **Step 4: 创建 `packages/server/src/auth/auth.service.ts`**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import type { ActorContext, TokenInfo, CreateTokenResponse } from "@vcpdeck/shared";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function generateToken(): string {
  return "vcp_" + randomBytes(32).toString("hex");
}

const SESSION_TTL = parseInt(process.env.VCPDECK_SESSION_TTL_SECONDS || "604800", 10);

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async login(username: string, password: string) {
    const identity = await this.prisma.identity.findUnique({ where: { username } });
    if (!identity) {
      throw new Error("AUTH_INVALID");
    }
    if (identity.disabledAt) {
      throw new Error("IDENTITY_DISABLED");
    }
    const valid = await bcrypt.compare(password, identity.passwordHash);
    if (!valid) {
      throw new Error("AUTH_INVALID");
    }

    const sessionToken = randomBytes(32).toString("hex");
    await this.prisma.authSession.create({
      data: {
        id: randomUUID(),
        identityId: identity.id,
        sessionHash: sha256(sessionToken),
        expiresAt: new Date(Date.now() + SESSION_TTL * 1000),
      },
    });

    return {
      sessionToken,
      identity: {
        id: identity.id,
        username: identity.username,
        displayName: identity.displayName,
        isAdmin: identity.isAdmin,
      },
    };
  }

  async logout(actor: ActorContext) {
    if (actor.sessionId) {
      await this.prisma.authSession.update({
        where: { id: actor.sessionId },
        data: { revokedAt: new Date() },
      });
    }
  }

  async getMe(actor: ActorContext) {
    const identity = await this.prisma.identity.findUnique({ where: { id: actor.identityId } });
    if (!identity) throw new Error("AUTH_INVALID");
    return {
      id: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      isAdmin: identity.isAdmin,
    };
  }

  async updateMe(actor: ActorContext, data: { username?: string; password?: string; currentPassword: string }) {
    const identity = await this.prisma.identity.findUnique({ where: { id: actor.identityId } });
    if (!identity) throw new Error("AUTH_INVALID");

    const valid = await bcrypt.compare(data.currentPassword, identity.passwordHash);
    if (!valid) {
      throw new Error("AUTH_INVALID");
    }

    const updateData: any = {};
    if (data.username) {
      const existing = await this.prisma.identity.findUnique({ where: { username: data.username } });
      if (existing && existing.id !== identity.id) {
        throw new Error("USERNAME_TAKEN");
      }
      updateData.username = data.username;
    }
    if (data.password) {
      updateData.passwordHash = await bcrypt.hash(data.password, 10);
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.identity.update({ where: { id: actor.identityId }, data: updateData });
    }
  }

  async createToken(actor: ActorContext, label: string): Promise<CreateTokenResponse> {
    const token = generateToken();
    const id = randomUUID();
    await this.prisma.credential.create({
      data: {
        id,
        identityId: actor.identityId,
        label,
        tokenHash: sha256(token),
      },
    });
    return { id, token, label };
  }

  async listTokens(actor: ActorContext): Promise<TokenInfo[]> {
    const creds = await this.prisma.credential.findMany({
      where: { identityId: actor.identityId },
      orderBy: { createdAt: "desc" },
    });
    return creds.map((c) => ({
      id: c.id,
      label: c.label,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      revokedAt: c.revokedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async revokeToken(actor: ActorContext, credentialId: string) {
    const cred = await this.prisma.credential.findUnique({ where: { id: credentialId } });
    if (!cred || cred.identityId !== actor.identityId) {
      throw new Error("AUTH_INVALID");
    }
    await this.prisma.credential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });
  }
}
```

- [ ] **Step 5: 创建 `packages/server/src/auth/auth.controller.ts`**

```ts
import { Controller, Post, Get, Put, Delete, Body, Req, Res, Param, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service.js";
import { AuthGuard } from "./auth.guard.js";
import { Public } from "./public.decorator.js";
import { Actor } from "./actor.decorator.js";
import type {
  ActorContext,
  LoginRequest,
  LoginResponse,
  IdentityInfo,
  UpdateMeRequest,
  CreateTokenRequest,
  TokenInfo,
  CreateTokenResponse,
} from "@vcpdeck/shared";

const COOKIE_SECURE = process.env.VCPDECK_COOKIE_SECURE !== "false";
const SESSION_TTL = parseInt(process.env.VCPDECK_SESSION_TTL_SECONDS || "604800", 10) * 1000;

@Controller("api/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("login")
  async login(@Body() body: LoginRequest, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    try {
      const { sessionToken, identity } = await this.authService.login(body.username, body.password);
      res.cookie("vcpdeck_session", sessionToken, {
        httpOnly: true,
        secure: COOKIE_SECURE,
        sameSite: "strict",
        path: "/",
        maxAge: SESSION_TTL,
      });
      return { identity };
    } catch (e: any) {
      const code = e.message;
      if (code === "IDENTITY_DISABLED") {
        throw Object.assign(new Error("Identity disabled"), { statusCode: 401, code });
      }
      throw Object.assign(new Error("Invalid credentials"), { statusCode: 401, code: "AUTH_INVALID" });
    }
  }

  @Post("logout")
  async logout(@Actor() actor: ActorContext, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(actor);
    res.clearCookie("vcpdeck_session", { path: "/" });
    return { ok: true };
  }

  @Get("me")
  async getMe(@Actor() actor: ActorContext): Promise<IdentityInfo> {
    return this.authService.getMe(actor);
  }

  @Put("me")
  async updateMe(@Actor() actor: ActorContext, @Body() body: UpdateMeRequest) {
    try {
      await this.authService.updateMe(actor, body);
      return { ok: true };
    } catch (e: any) {
      if (e.message === "USERNAME_TAKEN") {
        throw Object.assign(new Error("Username already taken"), { statusCode: 409, code: "USERNAME_TAKEN" });
      }
      throw Object.assign(new Error("Invalid credentials"), { statusCode: 401, code: "AUTH_INVALID" });
    }
  }

  @Post("tokens")
  async createToken(@Actor() actor: ActorContext, @Body() body: CreateTokenRequest): Promise<CreateTokenResponse> {
    return this.authService.createToken(actor, body.label);
  }

  @Get("tokens")
  async listTokens(@Actor() actor: ActorContext): Promise<TokenInfo[]> {
    return this.authService.listTokens(actor);
  }

  @Delete("tokens/:id")
  async revokeToken(@Actor() actor: ActorContext, @Param("id") id: string) {
    await this.authService.revokeToken(actor, id);
    return { ok: true };
  }
}
```

- [ ] **Step 6: 创建 `packages/server/src/auth/auth.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  providers: [AuthService, AuthGuard],
  controllers: [AuthController],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
```

- [ ] **Step 7: 安装 bcryptjs 和 cookie-parser**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server add bcryptjs cookie-parser && pnpm --filter @vcpdeck/server add -D @types/cookie-parser @types/bcryptjs
```

- [ ] **Step 8: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/auth/ packages/server/package.json packages/server/pnpm-lock.yaml ../../pnpm-lock.yaml
git commit -m "feat(auth): Auth 模块 — 登录/登出/Token管理/个人信息 + AuthGuard"
```

---

### Task 4: Identity 模块 + Bootstrap

**Files:**

- Create: `packages/server/src/identity/identity.module.ts`
- Create: `packages/server/src/identity/identity.service.ts`
- Create: `packages/server/src/identity/identity.controller.ts`
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/src/app.module.ts`

**Interfaces:**

- Consumes: `PrismaService`, `AuthGuard`, `Actor` decorator, `CreateIdentityRequest`, `IdentityInfo` (from shared)
- Produces: `IdentityService`

- [ ] **Step 1: 创建 `packages/server/src/identity/identity.service.ts`**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import type { IdentityInfo } from "@vcpdeck/shared";

@Injectable()
export class IdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(username: string, password: string, displayName: string): Promise<IdentityInfo> {
    const existing = await this.prisma.identity.findUnique({ where: { username } });
    if (existing) {
      throw Object.assign(new Error("Username already taken"), { statusCode: 409, code: "USERNAME_TAKEN" });
    }
    const identity = await this.prisma.identity.create({
      data: {
        id: randomUUID(),
        username,
        displayName,
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    return toInfo(identity);
  }

  async list(): Promise<IdentityInfo[]> {
    const identities = await this.prisma.identity.findMany({ orderBy: { createdAt: "desc" } });
    return identities.map(toInfo);
  }

  async disable(id: string) {
    await this.prisma.identity.update({ where: { id }, data: { disabledAt: new Date() } });
    // 撤销所有 session
    await this.prisma.authSession.updateMany({
      where: { identityId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async enable(id: string) {
    await this.prisma.identity.update({ where: { id }, data: { disabledAt: null } });
  }
}

function toInfo(i: {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  createdAt: Date;
}): IdentityInfo {
  return {
    id: i.id,
    username: i.username,
    displayName: i.displayName,
    isAdmin: i.isAdmin,
    disabledAt: i.disabledAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}
```

- [ ] **Step 2: 创建 `packages/server/src/identity/identity.controller.ts`**

```ts
import { Controller, Get, Post, Param, Body, ForbiddenException } from "@nestjs/common";
import { IdentityService } from "./identity.service.js";
import { Actor } from "../auth/actor.decorator.js";
import type { ActorContext, CreateIdentityRequest, IdentityInfo } from "@vcpdeck/shared";

@Controller("api/identities")
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  private checkAdmin(actor: ActorContext) {
    if (!actor.isAdmin) {
      throw new ForbiddenException({ statusCode: 403, code: "FORBIDDEN", message: "Admin only" });
    }
  }

  @Get()
  async list(@Actor() actor: ActorContext): Promise<IdentityInfo[]> {
    this.checkAdmin(actor);
    return this.identityService.list();
  }

  @Post()
  async create(@Actor() actor: ActorContext, @Body() body: CreateIdentityRequest): Promise<IdentityInfo> {
    this.checkAdmin(actor);
    return this.identityService.create(body.username, body.password, body.displayName);
  }

  @Post(":id/disable")
  async disable(@Actor() actor: ActorContext, @Param("id") id: string) {
    this.checkAdmin(actor);
    await this.identityService.disable(id);
    return { ok: true };
  }

  @Post(":id/enable")
  async enable(@Actor() actor: ActorContext, @Param("id") id: string) {
    this.checkAdmin(actor);
    await this.identityService.enable(id);
    return { ok: true };
  }
}
```

- [ ] **Step 3: 创建 `packages/server/src/identity/identity.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { IdentityService } from "./identity.service.js";
import { IdentityController } from "./identity.controller.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  providers: [IdentityService],
  controllers: [IdentityController],
})
export class IdentityModule {}
```

- [ ] **Step 4: 修改 `packages/server/src/app.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module.js";
import { EventsModule } from "./events/events.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { IdentityModule } from "./identity/identity.module.js";

@Module({
  imports: [PrismaModule, AuthModule, IdentityModule, EventsModule],
})
export class AppModule {}
```

- [ ] **Step 5: 修改 `packages/server/src/main.ts`——加 cookie-parser + CORS + bootstrap + 全局 AuthGuard**

```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import * as cookieParser from "cookie-parser";
import { PrismaService } from "./prisma/prisma.service.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";

const FRONTEND_ORIGIN = process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";

async function bootstrapAdmin(prisma: PrismaService) {
  const count = await prisma.identity.count({ where: { isAdmin: true } });
  if (count > 0) return;

  const username = process.env.VCPDECK_ADMIN_USERNAME || "admin";
  const password = process.env.VCPDECK_ADMIN_PASSWORD;
  if (!password) {
    console.error("[bootstrap] VCPDECK_ADMIN_PASSWORD is required for first boot");
    process.exit(1);
  }

  await prisma.identity.create({
    data: {
      id: randomUUID(),
      username,
      displayName: username,
      passwordHash: await bcrypt.hash(password, 10),
      isAdmin: true,
    },
  });
  console.log(`[bootstrap] admin identity created: ${username}`);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());
  app.enableCors({ origin: FRONTEND_ORIGIN, credentials: true });

  const prisma = app.get(PrismaService);
  const authGuard = app.get(AuthGuard);
  app.useGlobalGuards(authGuard);

  await bootstrapAdmin(prisma);

  await app.listen(3001);
  console.log("VCPDeck server listening on http://localhost:3001");
}

bootstrap();
```

- [ ] **Step 6: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/identity/ packages/server/src/main.ts packages/server/src/app.module.ts
git commit -m "feat(identity): Identity 模块（admin 管理身份）+ Bootstrap + 全局 AuthGuard + CORS"
```

---

### Task 5: EventsController 加 @Actor + @Public + /api/health

**Files:**

- Modify: `packages/server/src/events/events.controller.ts`

**Interfaces:**

- Consumes: `Public` decorator, `Actor` decorator, `ActorContext`
- Produces: 无（现有接口行为不变，加上健康检查）

- [ ] **Step 1: 修改 `packages/server/src/events/events.controller.ts`**

`createJob` 和 `cancelJob` 加 `@Actor()` 参数传给 JobService；加 `GET /api/health`：

```ts
import {
  BadRequestException,
  Controller,
  Inject,
  NotFoundException,
  Post,
  Get,
  Body,
  Param,
} from "@nestjs/common";
import { JobService } from "../job/job.service.js";
import { ClientService } from "../client/client.service.js";
import { EventsGateway } from "./events.gateway.js";
import { Actor } from "../auth/actor.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type { JobCreate, DispatchPayload, ActorContext } from "@vcpdeck/shared";

@Controller("api")
export class EventsController {
  constructor(
    @Inject(JobService) private readonly jobService: JobService,
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(EventsGateway) private readonly gateway: EventsGateway,
  ) {}

  @Public()
  @Get("health")
  health() {
    return { ok: true };
  }

  @Post("jobs")
  async createJob(@Body() body: JobCreate, @Actor() actor: ActorContext) {
    let result: { jobId: string; status: string; type: string } | null = null;
    let dispatch: DispatchPayload | null = null;
    try {
      const r = await this.jobService.create(
        {
          clientId: body.clientId,
          type: body.type || "exec",
          payload: body.payload || {},
          timeout: body.timeout,
        },
        actor,
      );
      result = r.result;
      dispatch = r.dispatch;
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return result;
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@Param("jobId") jobId: string, @Actor() actor: ActorContext) {
    const { cancelled, needsDispatch, clientId } =
      await this.jobService.cancel(jobId, actor);
    if (cancelled) {
      return { jobId, status: "cancelled" };
    }
    if (needsDispatch && clientId) {
      this.gateway.sendCancel(clientId, jobId);
      return { jobId, status: "cancelling" };
    }
    throw new Error("Unexpected cancel state");
  }

  @Get("clients")
  async listClients() {
    return this.clientService.listOnline();
  }

  @Get("jobs")
  async listJobs() {
    return this.jobService.list();
  }

  @Get("jobs/:jobId")
  async getJob(@Param("jobId") jobId: string) {
    const job = await this.jobService.findById(jobId);
    if (!job) throw new NotFoundException(`Job "${jobId}" not found`);
    return job;
  }
}
```

- [ ] **Step 2: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/server build
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/events/events.controller.ts
git commit -m "feat(events): Controller 加 Actor 注入 + /api/health 公开接口"
```

---

### Task 6: JobService 审计集成

**Files:**

- Modify: `packages/server/src/job/job.service.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Consumes: `ActorContext`
- Produces: `create()` 和 `cancel()` 签名增加 `actor` 参数

- [ ] **Step 1: 修改 `packages/shared/src/index.ts`——JobInfo 加审计字段**

在 `JobInfo` 接口中追加：

```ts
export interface JobInfo {
  // ...现有字段...
  createdByIdentityId: string | null;
  createdByName: string | null;
  createdVia: string | null;
}
```

- [ ] **Step 2: 修改 `packages/server/src/job/job.service.ts`——create + cancel + toJobInfo**

`create` 方法签名加 `actor: ActorContext`，入库时写审计字段；`cancel` 加 `actor`；`toJobInfo` 映射新字段：

```ts
// 在文件顶部 import 中加 ActorContext
import type {
  JobCreateResult,
  DispatchPayload,
  StatusReport,
  JobInfo,
  ActorContext,
} from "@vcpdeck/shared";

// create 方法签名改为：
async create(
  params: {
    clientId: string;
    type: string;
    payload: Record<string, unknown>;
    timeout?: number;
  },
  actor: ActorContext,
): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {

// create 中 prisma.job.create 的 data 加：
  createdByIdentityId: actor.identityId,
  createdByName: actor.displayName,
  createdVia: actor.source,

// cancel 方法签名改为：
async cancel(jobId: string, actor: ActorContext): Promise<{...}> {

// toJobInfo 返回值加：
  createdByIdentityId: j.createdByIdentityId ?? null,
  createdByName: j.createdByName ?? null,
  createdVia: j.createdVia ?? null,

// toJobInfo 的 j 参数类型加三个字段：
function toJobInfo(j: {
  // ...existing...
  createdByIdentityId: string | null;
  createdByName: string | null;
  createdVia: string | null;
}): JobInfo {
```

- [ ] **Step 3: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm build
```

Expected: PASS（全量构建）

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/job/job.service.ts packages/shared/src/index.ts
git commit -m "feat(job): JobService create/cancel 接收 ActorContext，写审计字段"
```

---

### Task 7: Socket.IO 拆分为 ClientGateway + AppGateway

**Files:**

- Create: `packages/server/src/events/client.gateway.ts`
- Create: `packages/server/src/events/app.gateway.ts`
- Delete: `packages/server/src/events/events.gateway.ts`
- Modify: `packages/server/src/events/events.module.ts`

**Interfaces:**

- Consumes: `PrismaService`, `ClientService`, `JobService`
- Produces: `ClientGateway` (/client namespace), `AppGateway` (/app namespace)

- [ ] **Step 1: 将现有 `events.gateway.ts` 重命名为 `client.gateway.ts`**

```bash
cd D:/VCPHub/VCPDeck && mv packages/server/src/events/events.gateway.ts packages/server/src/events/client.gateway.ts
```

修改文件内容——类名改为 `ClientGateway`，加 `namespace: "/client"`：

```ts
// 改这一行：
@WebSocketGateway({ namespace: "/client", cors: { origin: "*" } })
export class ClientGateway {
```

其余内容不变。

- [ ] **Step 2: 创建 `packages/server/src/events/app.gateway.ts`**

```ts
import { Inject } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service.js";
import { createHash } from "node:crypto";
import type { ActorContext } from "@vcpdeck/shared";

const FRONTEND_ORIGIN = process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

@WebSocketGateway({
  namespace: "/app",
  cors: { origin: FRONTEND_ORIGIN, credentials: true },
})
export class AppGateway {
  @WebSocketServer()
  server!: Server;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async handleConnection(client: Socket) {
    try {
      const actor = await this.authenticate(client);
      if (!actor) {
        client.emit("error", "Authentication required");
        client.disconnect();
        return;
      }
      (client as any).actor = actor;
      console.log(`[ws:app] connected: ${actor.displayName} (${actor.source})`);
    } catch {
      client.emit("error", "Authentication failed");
      client.disconnect();
    }
  }

  private async authenticate(client: Socket): Promise<ActorContext | null> {
    // 1. Cookie session
    const rawCookie = client.handshake.headers.cookie;
    if (rawCookie) {
      const match = rawCookie.match(/vcpdeck_session=([^;]+)/);
      if (match) {
        const hash = sha256(match[1]);
        const session = await this.prisma.authSession.findUnique({ where: { sessionHash: hash } });
        if (session && !session.revokedAt && session.expiresAt > new Date()) {
          const identity = await this.prisma.identity.findUnique({ where: { id: session.identityId } });
          if (identity && !identity.disabledAt) {
            return {
              identityId: identity.id,
              displayName: identity.displayName,
              isAdmin: identity.isAdmin,
              credentialId: null,
              sessionId: session.id,
              source: "web",
              requestId: client.id,
            };
          }
        }
      }
    }

    // 2. Bearer token (handshake auth)
    const token = client.handshake.auth?.token;
    if (token) {
      const hash = sha256(token);
      const cred = await this.prisma.credential.findUnique({ where: { tokenHash: hash } });
      if (cred && !cred.revokedAt && (!cred.expiresAt || cred.expiresAt > new Date())) {
        const identity = await this.prisma.identity.findUnique({ where: { id: cred.identityId } });
        if (identity && !identity.disabledAt) {
          return {
            identityId: identity.id,
            displayName: identity.displayName,
            isAdmin: identity.isAdmin,
            credentialId: cred.id,
            sessionId: null,
            source: "cli",
            requestId: client.id,
          };
        }
      }
    }

    return null;
  }
}
```

- [ ] **Step 3: 修改 `packages/server/src/events/events.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { ClientGateway } from "./client.gateway.js";
import { AppGateway } from "./app.gateway.js";
import { EventsController } from "./events.controller.js";
import { ClientModule } from "../client/client.module.js";
import { JobModule } from "../job/job.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [ClientModule, JobModule, PrismaModule],
  providers: [ClientGateway, AppGateway],
  controllers: [EventsController],
})
export class EventsModule {}
```

- [ ] **Step 4: 更新 `events.controller.ts` 中注入的 Gateway——从 `EventsGateway` 改为同时注入 `ClientGateway` 和 `AppGateway`**

Controller 中原来用 `EventsGateway` 发送 dispatch。现在 dispatch 消息应该通过 `ClientGateway`（发给远程机器）。只需改注入：

```ts
// 原来：
import { EventsGateway } from "./events.gateway.js";
// 改为：
import { ClientGateway } from "./client.gateway.js";

// constructor 中：
@Inject(ClientGateway) private readonly gateway: ClientGateway,
```

- [ ] **Step 5: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm build
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/events/
git commit -m "feat(socketio): 拆分 /client(PSK) 和 /app(用户认证) namespace"
```

---

### Task 8: 前端——登录页 + 认证上下文 + Token 管理 + 身份管理

**Files:**

- Create: `packages/frontend/src/api.ts`
- Create: `packages/frontend/src/AuthContext.tsx`
- Create: `packages/frontend/src/LoginPage.tsx`
- Create: `packages/frontend/src/DashboardPage.tsx`
- Create: `packages/frontend/src/TokensPage.tsx`
- Create: `packages/frontend/src/IdentitiesPage.tsx`
- Modify: `packages/frontend/src/App.tsx`
- Modify: `packages/frontend/src/main.tsx`

**Interfaces:**

- Consumes: `LoginRequest`, `LoginResponse`, `IdentityInfo`, `TokenInfo`, `CreateTokenResponse` (from shared)
- Produces: 完整前端认证页面

- [ ] **Step 1: 安装 `react-router-dom`**

```bash
cd D:/VCPHub/VCPDeck && pnpm --filter @vcpdeck/frontend add react-router-dom && pnpm --filter @vcpdeck/frontend add -D @types/react-router-dom || true
```

> `react-router-dom` v6 自带 types，可能不需要 `@types/`。

- [ ] **Step 2: 创建 `packages/frontend/src/api.ts`——API 调用封装**

```ts
const BASE = "http://localhost:3001";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.code || err.message || "Request failed");
  }
  return res.json();
}

export const api = {
  login: (data: { username: string; password: string }) =>
    request<{ identity: { id: string; username: string; displayName: string; isAdmin: boolean } }>("POST", "/api/auth/login", data),

  logout: () => request("POST", "/api/auth/logout"),

  getMe: () =>
    request<{ id: string; username: string; displayName: string; isAdmin: boolean }>("GET", "/api/auth/me"),

  updateMe: (data: { username?: string; password?: string; currentPassword: string }) =>
    request("PUT", "/api/auth/me", data),

  createToken: (label: string) =>
    request<{ id: string; token: string; label: string }>("POST", "/api/auth/tokens", { label }),

  listTokens: () =>
    request<{ id: string; label: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }[]>("GET", "/api/auth/tokens"),

  revokeToken: (id: string) =>
    request(`DELETE`, `/api/auth/tokens/${id}`),

  listIdentities: () =>
    request<{ id: string; username: string; displayName: string; isAdmin: boolean; disabledAt: string | null; createdAt: string }[]>("GET", "/api/identities"),

  createIdentity: (data: { username: string; password: string; displayName: string }) =>
    request("POST", "/api/identities", data),

  disableIdentity: (id: string) =>
    request("POST", `/api/identities/${id}/disable`),

  enableIdentity: (id: string) =>
    request("POST", `/api/identities/${id}/enable`),
};
```

- [ ] **Step 3: 创建 `packages/frontend/src/AuthContext.tsx`——认证上下文**

```tsx
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { api } from "./api";

interface Identity {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

interface AuthState {
  identity: Identity | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  identity: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMe()
      .then((me) => setIdentity(me))
      .catch(() => setIdentity(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const { identity } = await api.login({ username, password });
    setIdentity(identity);
  };

  const logout = async () => {
    await api.logout();
    setIdentity(null);
  };

  return (
    <AuthContext.Provider value={{ identity, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
```

- [ ] **Step 4: 创建 `packages/frontend/src/LoginPage.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || "Login failed");
    }
  };

  return (
    <div>
      <h1>VCPDeck Login</h1>
      <form onSubmit={handleSubmit}>
        {error && <p style={{ color: "red" }}>{error}</p>}
        <div>
          <label>Username</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div>
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button type="submit">Login</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: 创建 `packages/frontend/src/DashboardPage.tsx`**

```tsx
import { useAuth } from "./AuthContext";
import { Link } from "react-router-dom";

export function DashboardPage() {
  const { identity, logout } = useAuth();

  return (
    <div>
      <h1>VCPDeck</h1>
      <p>Logged in as: {identity?.displayName} ({identity?.username}) {identity?.isAdmin ? "[admin]" : ""}</p>
      <nav>
        <Link to="/tokens">CLI Tokens</Link>
        {identity?.isAdmin && <Link to="/identities">Manage Identities</Link>}
      </nav>
      <button onClick={logout}>Logout</button>
    </div>
  );
}
```

- [ ] **Step 6: 创建 `packages/frontend/src/TokensPage.tsx`——Token 管理**

```tsx
import { useState, useEffect } from "react";
import { api } from "./api";
import { Link } from "react-router-dom";

interface Token {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);

  const load = async () => {
    const list = await api.listTokens();
    setTokens(list);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!label.trim()) return;
    const result = await api.createToken(label.trim());
    setNewToken(result.token);
    setLabel("");
    load();
  };

  const handleRevoke = async (id: string) => {
    await api.revokeToken(id);
    load();
  };

  return (
    <div>
      <h1>CLI Tokens</h1>
      <Link to="/">Back</Link>

      {newToken && (
        <div style={{ border: "2px solid orange", padding: "1rem", margin: "1rem 0" }}>
          <p><strong>New token (shown only once):</strong></p>
          <code>{newToken}</code>
          <br />
          <button onClick={() => setNewToken(null)}>I've saved it</button>
        </div>
      )}

      <div>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. office PC)" />
        <button onClick={handleCreate}>Generate Token</button>
      </div>

      <ul>
        {tokens.map((t) => (
          <li key={t.id}>
            {t.label} — {t.createdAt}
            {t.revokedAt ? " [revoked]" : <button onClick={() => handleRevoke(t.id)}>Revoke</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 7: 创建 `packages/frontend/src/IdentitiesPage.tsx`——admin 身份管理**

```tsx
import { useState, useEffect } from "react";
import { api } from "./api";
import { Link } from "react-router-dom";

interface Identity {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
}

export function IdentitiesPage() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const load = async () => {
    setIdentities(await api.listIdentities());
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    await api.createIdentity({ username, password, displayName });
    setUsername(""); setPassword(""); setDisplayName("");
    load();
  };

  return (
    <div>
      <h1>Manage Identities</h1>
      <Link to="/">Back</Link>

      <h2>Create Identity</h2>
      <div>
        <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display Name" />
        <button onClick={handleCreate}>Create</button>
      </div>

      <h2>All Identities</h2>
      <table>
        <thead><tr><th>Username</th><th>DisplayName</th><th>Admin</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {identities.map((i) => (
            <tr key={i.id}>
              <td>{i.username}</td>
              <td>{i.displayName}</td>
              <td>{i.isAdmin ? "Yes" : "No"}</td>
              <td>{i.disabledAt ? "Disabled" : "Active"}</td>
              <td>
                {i.disabledAt
                  ? <button onClick={() => api.enableIdentity(i.id).then(load)}>Enable</button>
                  : <button onClick={() => api.disableIdentity(i.id).then(load)}>Disable</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: 修改 `packages/frontend/src/App.tsx`——路由**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { LoginPage } from "./LoginPage";
import { DashboardPage } from "./DashboardPage";
import { TokensPage } from "./TokensPage";
import { IdentitiesPage } from "./IdentitiesPage";

function AppRoutes() {
  const { identity, loading } = useAuth();

  if (loading) return <p>Loading...</p>;

  if (!identity) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/tokens" element={<TokensPage />} />
      {identity.isAdmin && <Route path="/identities" element={<IdentitiesPage />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 9: 确保 `index.html` 有 root div**

确认 `packages/frontend/index.html` 包含 `<div id="root"></div>`（已有，不需要改）。

- [ ] **Step 10: 构建验证**

```bash
cd D:/VCPHub/VCPDeck && pnpm build
```

Expected: PASS（全量构建通过）

- [ ] **Step 11: Commit**

```bash
git add packages/frontend/src/ packages/frontend/package.json pnpm-lock.yaml
git commit -m "feat(frontend): 登录页 + 认证上下文 + Token 管理 + admin 身份管理"
```

---

### 验收检查

全部 Task 完成后：

```bash
# 1. 启动 Server（首次启动会自动创建 admin）
cd D:/VCPHub/VCPDeck && VCPDECK_ADMIN_PASSWORD=test123 pnpm dev

# 2. 用浏览器访问 http://localhost:5173/login
#    → 用 admin / test123 登录 → 进入 Dashboard

# 3. 生成 CLI Token → 复制 vcp_xxxxx

# 4. 用 Token 调用 API
curl -H "Authorization: Bearer vcp_xxxxx" http://localhost:3001/api/clients
#    → 200 OK

# 5. 无 Token 调用
curl http://localhost:3001/api/clients
#    → 401 AUTH_REQUIRED

# 6. 健康检查
curl http://localhost:3001/api/health
#    → 200 OK

# 7. admin 创建新身份 → 浏览器登录新身份 → 看不到 Identities 页

# 8. admin 禁用新身份 → 新身份无法登录
```
