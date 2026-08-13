import { Inject } from "@nestjs/common";
import {
	ConnectedSocket,
	MessageBody,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service.js";
import { TerminalService } from "../terminal/terminal.service.js";
import { createHash } from "node:crypto";
import { Events } from "@vcpdeck/shared";
import type {
	ActorContext,
	TerminalAck,
	TerminalBrowserAttached,
	TerminalErrorCode,
} from "@vcpdeck/shared";
import {
	TERMINAL_ERROR_CODES,
	parseTerminalBrowserAckOutput,
	parseTerminalBrowserAttach,
	parseTerminalBrowserDetach,
	parseTerminalBrowserInput,
	parseTerminalBrowserResize,
	parseTerminalBrowserResync,
	parseTerminalBrowserTakeover,
	safeTerminalErrorMessage,
} from "@vcpdeck/shared";

const FRONTEND_ORIGIN = process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isTerminalErrorCode(v: unknown): v is TerminalErrorCode {
  return typeof v === "string" && (TERMINAL_ERROR_CODES as readonly string[]).includes(v);
}

/** 把业务错误转成安全 ack。 */
function errorAck(error: unknown): TerminalAck<never> {
  const code = isTerminalErrorCode((error as { code?: unknown }).code)
    ? (error as { code: TerminalErrorCode }).code
    : "TERMINAL_PROTOCOL_INVALID";
  return {
    ok: false,
    error: { code, message: safeTerminalErrorMessage((error as { message?: unknown }).message) },
  };
}

/** 从 socket 读取已认证 actor。 */
function actorOf(client: Socket): ActorContext {
  return (client as unknown as { actor: ActorContext }).actor;
}

@WebSocketGateway({
  namespace: "/app",
  cors: { origin: FRONTEND_ORIGIN, credentials: true },
})
export class AppGateway {
  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TerminalService) private readonly terminalService: TerminalService,
  ) {}

  afterInit() {
    this.terminalService.bindBrowserEmitter((socketId, event, payload) => {
      this.server.to(socketId).emit(event, payload);
    });
  }

  async handleConnection(client: Socket) {
    try {
      const actor = await this.authenticate(client);
      if (!actor) {
        client.emit("error", "Authentication required");
        client.disconnect();
        return;
      }
      (client as unknown as { actor: ActorContext }).actor = actor;
      console.log(`[ws:app] connected: ${actor.displayName} (${actor.source})`);
    } catch {
      client.emit("error", "Authentication failed");
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    await this.terminalService.detachBrowserSocket(client.id);
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

  // ── 终端事件（身份来自 handleConnection 的 actor） ──

  @SubscribeMessage(Events.TERMINAL_ATTACH)
  async handleTerminalAttach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<TerminalBrowserAttached>> {
    try {
      const parsed = parseTerminalBrowserAttach(data);
      const result = await this.terminalService.attachBrowser({
        sessionId: parsed.sessionId,
        actor: actorOf(client),
        socketId: client.id,
        reconnectToken: parsed.reconnectToken,
      });
      return {
        ok: true,
        data: {
          sessionId: parsed.sessionId,
          attachmentId: result.attachmentId,
          reconnectToken: result.reconnectToken,
          mode: result.mode,
          controlProtectedUntil: result.controlProtectedUntil,
        },
      };
    } catch (error) {
      return errorAck(error);
    }
  }

  @SubscribeMessage(Events.TERMINAL_DETACH)
  async handleTerminalDetach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<undefined>> {
    try {
      const parsed = parseTerminalBrowserDetach(data);
      await this.terminalService.detachBrowser({ socketId: client.id, ...parsed });
      return { ok: true, data: undefined };
    } catch (error) {
      return errorAck(error);
    }
  }

  @SubscribeMessage(Events.TERMINAL_INPUT)
  async handleTerminalInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<undefined>> {
    try {
      const parsed = parseTerminalBrowserInput(data);
      await this.terminalService.browserInput({ socketId: client.id, ...parsed });
      return { ok: true, data: undefined };
    } catch (error) {
      return errorAck(error);
    }
  }

  @SubscribeMessage(Events.TERMINAL_RESIZE)
  async handleTerminalResize(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<undefined>> {
    try {
      const parsed = parseTerminalBrowserResize(data);
      await this.terminalService.browserResize({ socketId: client.id, ...parsed });
      return { ok: true, data: undefined };
    } catch (error) {
      return errorAck(error);
    }
  }

  @SubscribeMessage(Events.TERMINAL_TAKEOVER)
  async handleTerminalTakeover(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<{ mode: "operator" | "viewer" }>> {
    try {
      const parsed = parseTerminalBrowserTakeover(data);
      const result = await this.terminalService.browserTakeover({ socketId: client.id, ...parsed });
      return { ok: true, data: result };
    } catch (error) {
      return errorAck(error);
    }
  }

  @SubscribeMessage(Events.TERMINAL_ACK_OUTPUT)
  async handleTerminalAckOutput(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<undefined>> {
    try {
      const parsed = parseTerminalBrowserAckOutput(data);
      await this.terminalService.browserAckOutput({ socketId: client.id, ...parsed });
      return { ok: true, data: undefined };
    } catch (error) {
      return errorAck(error);
    }
  }

  @SubscribeMessage(Events.TERMINAL_RESYNC)
  async handleTerminalResync(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<TerminalAck<undefined>> {
    try {
      const parsed = parseTerminalBrowserResync(data);
      await this.terminalService.browserResync({ socketId: client.id, ...parsed });
      return { ok: true, data: undefined };
    } catch (error) {
      return errorAck(error);
    }
  }

}
