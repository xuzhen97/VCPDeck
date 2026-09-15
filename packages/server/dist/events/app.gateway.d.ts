import type { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service.js";
import { TerminalService } from "../terminal/terminal.service.js";
import { TunnelSessionService } from "../tunnel/tunnel-session.service.js";
import type { TerminalAck, TerminalBrowserAttached } from "@vcpdeck/shared";
export declare class AppGateway {
    private readonly prisma;
    private readonly terminalService;
    private readonly tunnelSessions?;
    server: Server;
    constructor(prisma: PrismaService, terminalService: TerminalService, tunnelSessions?: TunnelSessionService | undefined);
    afterInit(): void;
    handleConnection(client: Socket): Promise<void>;
    handleDisconnect(client: Socket): Promise<void>;
    private authenticate;
    handleTerminalAttach(client: Socket, data: unknown): Promise<TerminalAck<TerminalBrowserAttached>>;
    handleTerminalDetach(client: Socket, data: unknown): Promise<TerminalAck<undefined>>;
    handleTerminalInput(client: Socket, data: unknown): Promise<TerminalAck<undefined>>;
    handleTerminalResize(client: Socket, data: unknown): Promise<TerminalAck<undefined>>;
    handleTerminalTakeover(client: Socket, data: unknown): Promise<TerminalAck<{
        mode: "operator" | "viewer";
    }>>;
    handleTerminalAckOutput(client: Socket, data: unknown): Promise<TerminalAck<undefined>>;
    handleTerminalResync(client: Socket, data: unknown): Promise<TerminalAck<undefined>>;
    private tunnelErrorAck;
    handleTunnelAttach(client: Socket, data: unknown): Promise<{
        ok: false;
        error: {
            code: string;
            message: string;
        };
    } | {
        ok: boolean;
        data: undefined;
    }>;
    handleTunnelSignal(client: Socket, data: unknown): Promise<{
        ok: false;
        error: {
            code: string;
            message: string;
        };
    } | {
        ok: boolean;
        data: undefined;
    }>;
    handleTunnelClose(client: Socket, data: unknown): Promise<{
        ok: false;
        error: {
            code: string;
            message: string;
        };
    } | {
        ok: boolean;
        data: {
            closed: boolean;
        };
    }>;
}
