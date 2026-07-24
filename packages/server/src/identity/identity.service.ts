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
