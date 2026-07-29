/** @file FRP 实例配置 REST API */

import {
	Controller,
	Get,
	Post,
	Put,
	Delete,
	Param,
	Query,
	Body,
	BadRequestException,
	Inject,
} from "@nestjs/common";
import { FrpsInstancesService } from "./frp-instances.service.js";
import type {
	FrpsInstanceCreateRequest,
	FrpsInstanceUpdateRequest,
} from "@vcpdeck/shared";

@Controller("api/frp/instances")
export class FrpsInstancesController {
	constructor(
		@Inject(FrpsInstancesService)
		private readonly instancesService: FrpsInstancesService,
	) {}

	@Post()
	async create(@Body() body: FrpsInstanceCreateRequest) {
		if (!body.name || !body.serverAddr) {
			throw new BadRequestException("缺少必填字段：name, serverAddr");
		}
		return this.instancesService.create(body);
	}

	@Get()
	async list(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.instancesService.list(
			page ? Math.max(1, parseInt(page, 10)) : undefined,
			pageSize
				? Math.min(100, Math.max(1, parseInt(pageSize, 10)))
				: undefined,
		);
	}

	@Get(":id")
	async get(@Param("id") id: string) {
		const instance = await this.instancesService.getById(id);
		if (!instance) {
			throw new BadRequestException(`实例 "${id}" 不存在`);
		}
		return instance;
	}

	@Put(":id")
	async update(
		@Param("id") id: string,
		@Body() body: FrpsInstanceUpdateRequest,
	) {
		try {
			return await this.instancesService.update(id, body);
		} catch (e: any) {
			throw new BadRequestException(e.message);
		}
	}

	@Delete(":id")
	async delete(@Param("id") id: string) {
		try {
			const deleted = await this.instancesService.delete(id);
			if (!deleted) {
				throw new BadRequestException(`实例 "${id}" 不存在`);
			}
			return { id, deleted: true };
		} catch (e: any) {
			throw new BadRequestException(e.message);
		}
	}

	@Post(":id/probe")
	async probe(@Param("id") id: string) {
		try {
			return await this.instancesService.probe(id);
		} catch (e: any) {
			throw new BadRequestException(e.message);
		}
	}

	@Post(":id/set-default")
	async setDefault(@Param("id") id: string) {
		try {
			return await this.instancesService.setDefault(id);
		} catch (e: any) {
			throw new BadRequestException(e.message);
		}
	}
}
