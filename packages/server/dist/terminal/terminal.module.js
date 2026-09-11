"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalModule = void 0;
const common_1 = require("@nestjs/common");
const terminal_service_js_1 = require("./terminal.service.js");
const terminal_request_broker_js_1 = require("./terminal-request-broker.js");
const terminal_audit_service_js_1 = require("./terminal-audit.service.js");
const terminal_controller_js_1 = require("./terminal.controller.js");
/** 交互式终端模块：REST 元数据 + 会话服务 + 请求代理 + 最小审计。 */
let TerminalModule = class TerminalModule {
};
exports.TerminalModule = TerminalModule;
exports.TerminalModule = TerminalModule = __decorate([
    (0, common_1.Module)({
        controllers: [terminal_controller_js_1.TerminalController],
        providers: [terminal_service_js_1.TerminalService, terminal_request_broker_js_1.TerminalRequestBroker, terminal_audit_service_js_1.TerminalAuditService],
        exports: [terminal_service_js_1.TerminalService, terminal_request_broker_js_1.TerminalRequestBroker],
    })
], TerminalModule);
