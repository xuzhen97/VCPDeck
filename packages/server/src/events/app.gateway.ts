import { Inject, Optional } from "@nestjs/common";
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
import { RemoteDevService } from "../remote-dev/remote-dev.service.js";
import { RemoteDevAttachmentService } from "../remote-dev/remote-dev-attachment.service.js";
import { RemoteDevPortService } from "../remote-dev/remote-dev-port.service.js";
import { RemoteDevForwardGateway } from "../remote-dev/remote-dev-forward.gateway.js";
import { createHash } from "node:crypto";
import { Events } from "@vcpdeck/shared";
import type {
	ActorContext,
	RemoteDevClientEvent,
	TerminalAck,
	TerminalBrowserAttached,
	TerminalErrorCode,
} from "@vcpdeck/shared";
import {
	TERMINAL_ERROR_CODES,
	parseRemoteDevBrowserAttach,
	parseRemoteDevBrowserCancel,
	parseRemoteDevBrowserDetach,
	parseRemoteDevBrowserPermission,
	parseRemoteDevBrowserPortClose,
	parseRemoteDevBrowserPortOpen,
	parseRemoteDevBrowserPrompt,
	parseRemoteDevBrowserResync,
	parseTerminalBrowserAckOutput,
	parseTerminalBrowserAttach,
	parseTerminalBrowserDetach,
	parseTerminalBrowserInput,
	parseTerminalBrowserResize,
	parseTerminalBrowserResync,
	parseTerminalBrowserTakeover,
	safeTerminalErrorMessage,
} from "@vcpdeck/shared";
import { resolveFrontendOrigin } from "../auth/trusted-origins.js";

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
  cors: { origin: resolveFrontendOrigin(), credentials: true },
})
export class AppGateway {
  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TerminalService) private readonly terminalService: TerminalService,
    @Optional()
    @Inject(RemoteDevService)
    private readonly remoteDev?: RemoteDevService,
    @Optional()
    @Inject(RemoteDevAttachmentService)
    private readonly remoteDevAttachments?: RemoteDevAttachmentService,
    @Optional()
    @Inject(RemoteDevPortService)
    private readonly remoteDevPorts?: RemoteDevPortService,
    @Optional()
    @Inject(RemoteDevForwardGateway)
    private readonly remoteDevForwarder?: RemoteDevForwardGateway,
  ) {}

  afterInit() {
    this.terminalService.bindBrowserEmitter((socketId, event, payload) => {
      this.server.to(socketId).emit(event, payload);
    });
    this.remoteDev?.bindBrowserEmitter((sessionId, event) => {
      this.server
        .to(this.rdsRoom(sessionId))
        .emit(Events.RDS_AGENT_EVENT, event);
      if (event.type === "session.ended") {
        this.remoteDevAttachments?.clear(sessionId);
        this.server.to(this.rdsRoom(sessionId)).emit(Events.RDS_CLOSED, {
          sessionId,
          reason: event.reason,
        });
      }
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
    this.remoteDevAttachments?.detach(client.id);
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

  // ── Remote Dev Session（/app） ──

  @SubscribeMessage(Events.RDS_ATTACH)
  async handleRdsAttach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      const parsed = parseRemoteDevBrowserAttach(data);
      if (!this.remoteDev || !this.remoteDevAttachments) {
        throw new Error("RDS is not available");
      }
      const session = await this.remoteDev.get(parsed.sessionId);
      const attachment = this.remoteDevAttachments.attach(
        parsed.sessionId,
        actorOf(client),
        client.id,
        parsed.reconnectToken,
      );
      await client.join(this.rdsRoom(parsed.sessionId));
      client.emit(Events.RDS_STATE, {
        session,
        ports: await this.remoteDev.ports(parsed.sessionId),
        attachment,
      });
      // 回放历史对话：单独一个事件而不是塞进 attach 响应，避免旧前端解析失败。
      // 回放失败不影响附着本身。
      await this.remoteDev
        .transcript(parsed.sessionId)
        .then((transcript) => {
          client.emit(Events.RDS_TRANSCRIPT, transcript);
        })
        .catch(() => undefined);
      return { ok: true, data: attachment };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_DETACH)
  async handleRdsDetach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      const parsed = parseRemoteDevBrowserDetach(data);
      this.remoteDevAttachments?.detach(client.id);
      await client.leave(this.rdsRoom(parsed.sessionId));
      return { ok: true };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_PROMPT)
  async handleRdsPrompt(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      if (!this.remoteDev || !this.remoteDevAttachments) {
        throw new Error("RDS is not available");
      }
      const parsed = parseRemoteDevBrowserPrompt(data);
      this.remoteDevAttachments.assertOperator(parsed.sessionId, client.id);
      await this.remoteDev.prompt(parsed.sessionId, parsed.text, actorOf(client));
      return { ok: true };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_CANCEL)
  async handleRdsCancel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      if (!this.remoteDev || !this.remoteDevAttachments) {
        throw new Error("RDS is not available");
      }
      const parsed = parseRemoteDevBrowserCancel(data);
      this.remoteDevAttachments.assertOperator(parsed.sessionId, client.id);
      await this.remoteDev.cancel(parsed.sessionId, actorOf(client));
      return { ok: true };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_PERMISSION)
  async handleRdsPermission(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      if (!this.remoteDev || !this.remoteDevAttachments) {
        throw new Error("RDS is not available");
      }
      const parsed = parseRemoteDevBrowserPermission(data);
      this.remoteDevAttachments.assertOperator(parsed.sessionId, client.id);
      await this.remoteDev.permission(
        parsed.sessionId,
        parsed.requestId,
        parsed.optionId,
        actorOf(client),
      );
      return { ok: true };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_PORT_OPEN)
  async handleRdsPortOpen(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      if (!this.remoteDev || !this.remoteDevAttachments) {
        throw new Error("RDS is not available");
      }
      const parsed = parseRemoteDevBrowserPortOpen(data);
      this.remoteDevAttachments.assertOperator(parsed.sessionId, client.id);
      const port = await this.remoteDev.openPort(
        parsed.sessionId,
        {
          remotePort: parsed.remotePort,
          ...(parsed.label ? { label: parsed.label } : {}),
        },
        actorOf(client),
      );
      this.server.to(this.rdsRoom(parsed.sessionId)).emit(Events.RDS_PORT_STATE, port);
      return { ok: true, data: port };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_PORT_CLOSE)
  async handleRdsPortClose(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      if (!this.remoteDev || !this.remoteDevAttachments) {
        throw new Error("RDS is not available");
      }
      const parsed = parseRemoteDevBrowserPortClose(data);
      this.remoteDevAttachments.assertOperator(parsed.sessionId, client.id);
      const port = await this.remoteDev.closePort(
        parsed.sessionId,
        parsed.portId,
        actorOf(client),
      );
      this.remoteDevPorts?.revokePort(parsed.portId);
      this.remoteDevForwarder?.disconnectPort(parsed.portId);
      this.server.to(this.rdsRoom(parsed.sessionId)).emit(Events.RDS_PORT_STATE, port);
      return { ok: true, data: port };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  @SubscribeMessage(Events.RDS_RESYNC)
  async handleRdsResync(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ) {
    try {
      if (!this.remoteDev) throw new Error("RDS is not available");
      const parsed = parseRemoteDevBrowserResync(data);
      client.emit(Events.RDS_STATE, {
        session: await this.remoteDev.get(parsed.sessionId),
        ports: await this.remoteDev.ports(parsed.sessionId),
      });
      return { ok: true };
    } catch (error) {
      return this.rdsError(error);
    }
  }

  private rdsRoom(sessionId: string): string {
    return `rds:${sessionId}`;
  }

  private rdsError(cause: unknown): {
    ok: false;
    error: { code: string; message: string };
  } {
    const code = (cause as { code?: unknown }).code;
    const message = (cause as { message?: unknown }).message;
    return {
      ok: false,
      error: {
        code: typeof code === "string" ? code : "RDS_PROTOCOL_INVALID",
        message: typeof message === "string" ? message.slice(0, 500) : "RDS error",
      },
    };
  }

}
