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
      disabledAt: identity.disabledAt?.toISOString() ?? null,
      createdAt: identity.createdAt.toISOString(),
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
