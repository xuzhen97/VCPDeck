import { Module } from "@nestjs/common";
import { TerminalService } from "./terminal.service.js";
import { TerminalRequestBroker } from "./terminal-request-broker.js";
import { TerminalAuditService } from "./terminal-audit.service.js";
import { TerminalController } from "./terminal.controller.js";

/** 交互式终端模块：REST 元数据 + 会话服务 + 请求代理 + 最小审计。 */
@Module({
	controllers: [TerminalController],
	providers: [TerminalService, TerminalRequestBroker, TerminalAuditService],
	exports: [TerminalService, TerminalRequestBroker],
})
export class TerminalModule {}
