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
import type { FrpMappingCreateRequest } from "@vcpdeck/shared";

@Controller("api/frp")
export class FrpController {
  constructor(
    @Inject(FrpService) private readonly frpService: FrpService,
    @Inject(ClientGateway) private readonly gateway: ClientGateway,
  ) {}

  @Post("mappings")
  async create(@Body() body: FrpMappingCreateRequest) {
    if (!body.clientId || !body.name || !body.proxyType || body.localPort === undefined) {
      throw new BadRequestException("缺少必填字段：clientId, name, proxyType, localPort");
    }
    if (!["tcp", "http", "https"].includes(body.proxyType)) {
      throw new BadRequestException(`无效的 proxyType: ${body.proxyType}`);
    }

    try {
      const { mapping, dispatch } = await this.frpService.createMapping(body);
      this.gateway.sendDispatch(dispatch);
      return mapping;
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  @Get("mappings")
  async list(@Query("clientId") clientId?: string) {
    return this.frpService.listMappings(clientId);
  }

  @Get("mappings/:id")
  async get(@Param("id") id: string) {
    const m = await this.frpService.getMapping(id);
    if (!m) throw new BadRequestException(`映射 "${id}" 不存在`);
    return m;
  }

  @Delete("mappings/:id")
  async delete(@Param("id") id: string) {
    try {
      const result = await this.frpService.deleteMapping(id);
      if (!result) {
        throw new BadRequestException(`映射 "${id}" 不存在`);
      }
      this.gateway.sendDispatch(result.dispatch);
      return { id, deleted: true };
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }
}
