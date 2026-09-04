import {
	BadRequestException,
	Controller,
	Delete,
	Get,
	HttpException,
	Inject,
	Param,
	Post,
	Body,
	Query,
} from "@nestjs/common";
import type {
	ActorContext,
	CreateStorageShareRequest,
	StorageShareStatus,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { StorageShareService } from "./storage-share.service.js";

const STATUS = new Set<StorageShareStatus>(["active", "revoked", "invalid"]);

function pageValue(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return fallback;
	return parsed;
}

function toHttp(error: unknown): HttpException {
	const failure = error as { code?: string; message?: string; statusCode?: number };
	if (failure.statusCode) {
		return new HttpException(
			{ code: failure.code, message: failure.message },
			failure.statusCode,
		);
	}
	return new HttpException({ code: "STORAGE_SHARE_FAILED", message: "Storage share operation failed" }, 500);
}

@Controller("api/storage/shares")
export class StorageShareController {
	constructor(
		@Inject(StorageShareService) private readonly service: StorageShareService,
	) {}

	@Post()
	async create(@Body() body: CreateStorageShareRequest, @Actor() actor: ActorContext) {
		if (!body || typeof body.fileId !== "string" || !body.fileId || Object.keys(body).some((key) => key !== "fileId")) {
			throw new BadRequestException("fileId is required");
		}
		try {
			return await this.service.create(body, actor);
		} catch (error) {
			throw toHttp(error);
		}
	}

	@Get()
	async list(
		@Query("fileId") fileId?: string,
		@Query("status") status?: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		if (status && !STATUS.has(status as StorageShareStatus)) {
			throw new BadRequestException("status must be active, revoked, or invalid");
		}
		try {
			return await this.service.list({
				fileId,
				status: status as StorageShareStatus | undefined,
				page: pageValue(page, 1),
				pageSize: Math.min(100, pageValue(pageSize, 20)),
			});
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw toHttp(error);
		}
	}

	@Get(":id")
	async get(@Param("id") id: string) {
		try {
			return await this.service.get(id);
		} catch (error) {
			throw toHttp(error);
		}
	}

	@Delete(":id")
	async revoke(@Param("id") id: string, @Actor() actor: ActorContext) {
		try {
			return await this.service.revoke(id, actor);
		} catch (error) {
			throw toHttp(error);
		}
	}
}
