/** @file FRP 映射 REST API */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  BadRequestException,
  HttpException,
  Inject,
} from "@nestjs/common";
import { FrpService } from "./frp.service.js";
import { ClientGateway } from "../events/client.gateway.js";
import {
  FRP_ERROR_CODES,
  FrpProtocolError,
  parseFrpMappingCreateRequest,
  parseFrpOperationTimeout,
} from "@vcpdeck/shared";

/** Dashboard 侧错误统一 503（服务端配置/可达性问题，不是请求错误）。 */
const FRP_DASHBOARD_ERROR_CODES: readonly string[] = [
  "FRPS_DASHBOARD_REQUIRED",
  "FRPS_DASHBOARD_UNREACHABLE",
  "FRPS_DASHBOARD_AUTH_FAILED",
];

/** FRP 错误码 → HTTP 状态码：busy 409、Dashboard 503、已知协议 400、未知 500。 */
function frpHttpError(
  error: unknown,
  fallbackMessage: string,
): HttpException | BadRequestException {
  const failure = error as { code?: string; message?: string };
  const code = failure.code;
  if (code === "FRP_RECONCILE_BUSY") {
    return new HttpException(
      { code, message: failure.message ?? fallbackMessage },
      409,
    );
  }
  if (code && FRP_DASHBOARD_ERROR_CODES.includes(code)) {
    return new HttpException(
      { code, message: failure.message ?? fallbackMessage },
      503,
    );
  }
  if (code && (FRP_ERROR_CODES as readonly string[]).includes(code)) {
    return new BadRequestException({ code, message: failure.message ?? fallbackMessage });
  }
  // 未知错误：固定安全文案，不透传内部 message。
  return new HttpException({ code: "FRP_OPERATION_FAILED", message: "FRP 操作失败" }, 500);
}

@Controller("api/frp")
export class FrpController {
  constructor(
    @Inject(FrpService) private readonly frpService: FrpService,
    @Inject(ClientGateway) private readonly gateway: ClientGateway,
  ) {}

  @Post("mappings")
  async create(@Body() body: unknown) {
    try {
      const input = parseFrpMappingCreateRequest(body);
      const { mapping, dispatch } = await this.frpService.createMapping(input);
      this.gateway.sendDispatch(dispatch);
      return mapping;
    } catch (error) {
      if (error instanceof FrpProtocolError) {
        throw new BadRequestException({
          code: "FRP_PROTOCOL_INVALID",
          message: error.message,
        });
      }
      throw frpHttpError(error, "FRP 映射创建失败");
    }
  }

  @Get("mappings")
  async list(
    @Query("clientId") clientId?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.frpService.listMappings(
      clientId,
      page ? Math.max(1, parseInt(page, 10)) : undefined,
      pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined,
    );
  }

  @Get("mappings/:id")
  async get(@Param("id") id: string) {
    const m = await this.frpService.getMapping(id);
    if (!m) throw new BadRequestException(`映射 "${id}" 不存在`);
    return m;
  }

  @Delete("mappings/:id")
  async delete(
    @Param("id") id: string,
    @Query("timeoutSeconds") timeoutSeconds?: string,
  ) {
    try {
      const timeout = parseFrpOperationTimeout(timeoutSeconds);
      const result = await this.frpService.deleteMapping(id, timeout);
      if (!result) {
        throw new BadRequestException({
          code: "FRP_MAPPING_NOT_FOUND",
          message: `映射 "${id}" 不存在`,
        });
      }
      this.gateway.sendDispatch(result.dispatch);
      return result.mapping;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof FrpProtocolError) {
        throw new BadRequestException({
          code: "FRP_PROTOCOL_INVALID",
          message: error.message,
        });
      }
      throw frpHttpError(error, "FRP 映射删除失败");
    }
  }
}
