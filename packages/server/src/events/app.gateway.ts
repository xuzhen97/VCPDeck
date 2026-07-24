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
