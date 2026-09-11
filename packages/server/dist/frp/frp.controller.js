"use strict";
/** @file FRP 映射 REST API */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrpController = void 0;
const common_1 = require("@nestjs/common");
const frp_service_js_1 = require("./frp.service.js");
const client_gateway_js_1 = require("../events/client.gateway.js");
const shared_1 = require("@vcpdeck/shared");
/** Dashboard 侧错误统一 503（服务端配置/可达性问题，不是请求错误）。 */
const FRP_DASHBOARD_ERROR_CODES = [
    "FRPS_DASHBOARD_REQUIRED",
    "FRPS_DASHBOARD_UNREACHABLE",
    "FRPS_DASHBOARD_AUTH_FAILED",
];
/** FRP 错误码 → HTTP 状态码：busy 409、Dashboard 503、已知协议 400、未知 500。 */
function frpHttpError(error, fallbackMessage) {
    const failure = error;
    const code = failure.code;
    if (code === "FRP_RECONCILE_BUSY") {
        return new common_1.HttpException({ code, message: failure.message ?? fallbackMessage }, 409);
    }
    if (code && FRP_DASHBOARD_ERROR_CODES.includes(code)) {
        return new common_1.HttpException({ code, message: failure.message ?? fallbackMessage }, 503);
    }
    if (code && shared_1.FRP_ERROR_CODES.includes(code)) {
        return new common_1.BadRequestException({ code, message: failure.message ?? fallbackMessage });
    }
    // 未知错误：固定安全文案，不透传内部 message。
    return new common_1.HttpException({ code: "FRP_OPERATION_FAILED", message: "FRP 操作失败" }, 500);
}
let FrpController = class FrpController {
    frpService;
    gateway;
    constructor(frpService, gateway) {
        this.frpService = frpService;
        this.gateway = gateway;
    }
    async create(body) {
        try {
            const input = (0, shared_1.parseFrpMappingCreateRequest)(body);
            const { mapping, dispatch } = await this.frpService.createMapping(input);
            this.gateway.sendDispatch(dispatch);
            return mapping;
        }
        catch (error) {
            if (error instanceof shared_1.FrpProtocolError) {
                throw new common_1.BadRequestException({
                    code: "FRP_PROTOCOL_INVALID",
                    message: error.message,
                });
            }
            throw frpHttpError(error, "FRP 映射创建失败");
        }
    }
    async list(clientId, page, pageSize) {
        return this.frpService.listMappings(clientId, page ? Math.max(1, parseInt(page, 10)) : undefined, pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined);
    }
    async get(id) {
        const m = await this.frpService.getMapping(id);
        if (!m)
            throw new common_1.BadRequestException(`映射 "${id}" 不存在`);
        return m;
    }
    async delete(id, timeoutSeconds) {
        try {
            const timeout = (0, shared_1.parseFrpOperationTimeout)(timeoutSeconds);
            const result = await this.frpService.deleteMapping(id, timeout);
            if (!result) {
                throw new common_1.BadRequestException({
                    code: "FRP_MAPPING_NOT_FOUND",
                    message: `映射 "${id}" 不存在`,
                });
            }
            this.gateway.sendDispatch(result.dispatch);
            return result.mapping;
        }
        catch (error) {
            if (error instanceof common_1.BadRequestException)
                throw error;
            if (error instanceof shared_1.FrpProtocolError) {
                throw new common_1.BadRequestException({
                    code: "FRP_PROTOCOL_INVALID",
                    message: error.message,
                });
            }
            throw frpHttpError(error, "FRP 映射删除失败");
        }
    }
};
exports.FrpController = FrpController;
__decorate([
    (0, common_1.Post)("mappings"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], FrpController.prototype, "create", null);
__decorate([
    (0, common_1.Get)("mappings"),
    __param(0, (0, common_1.Query)("clientId")),
    __param(1, (0, common_1.Query)("page")),
    __param(2, (0, common_1.Query)("pageSize")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], FrpController.prototype, "list", null);
__decorate([
    (0, common_1.Get)("mappings/:id"),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FrpController.prototype, "get", null);
__decorate([
    (0, common_1.Delete)("mappings/:id"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Query)("timeoutSeconds")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], FrpController.prototype, "delete", null);
exports.FrpController = FrpController = __decorate([
    (0, common_1.Controller)("api/frp"),
    __param(0, (0, common_1.Inject)(frp_service_js_1.FrpService)),
    __param(1, (0, common_1.Inject)(client_gateway_js_1.ClientGateway)),
    __metadata("design:paramtypes", [frp_service_js_1.FrpService, client_gateway_js_1.ClientGateway])
], FrpController);
