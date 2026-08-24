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
  Inject,
} from "@nestjs/common";
import { FrpService } from "./frp.service.js";
import { ClientGateway } from "../events/client.gateway.js";
import {
  FrpProtocolError,
  parseFrpMappingCreateRequest,
  parseFrpOperationTimeout,
} from "@vcpdeck/shared";

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
      const failure = error as { code?: string; message?: string };
      throw new BadRequestException({
        code: failure.code ?? "FRP_OPERATION_FAILED",
        message: failure.message ?? "FRP 映射创建失败",
      });
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
      const failure = error as { code?: string; message?: string };
      throw new BadRequestException({
        code: failure.code ?? "FRP_OPERATION_FAILED",
        message: failure.message ?? "FRP 映射删除失败",
      });
    }
  }
}
