import { Injectable, type CanActivate, type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { PrismaService } from "../prisma/prisma.service.js";
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
