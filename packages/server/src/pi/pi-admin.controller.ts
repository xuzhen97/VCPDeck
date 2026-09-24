/**
 * 远程 Pi 集中配置管理 REST API（Plan 1：Profile / Credential / Binding）。
 *
 * 设计来源：docs/design/remote-pi-control-plane.md §17。
 * 安全约束：响应永不包含凭据密文或明文；错误消息不含 Secret。
 */
import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpException,
	Inject,
	Param,
	Patch,
	Optional,
	Post,
	Put,
	Query,
} from "@nestjs/common";
import {
	PiAdminProtocolError,
	parsePiCredentialCreateInput,
	parsePiCredentialUpdateInput,
	parsePiProfileCreateInput,
	parsePiProfileUpdateInput,
	parsePiProviderCreateInput,
	parsePiProviderDiscoveryInput,
	parsePiProviderUpdateInput,
} from "@vcpdeck/shared";
import { PiCredentialService } from "./pi-credential.service.js";
import { PiProfileService } from "./pi-profile.service.js";
import { PiProviderService } from "./pi-provider.service.js";
import { PiRuntimeService } from "./pi-runtime.service.js";

/** 协议输入错误 → 400；其余稳定错误码沿用原状态并只回安全文案。 */
function piHttpError(error: unknown, fallbackMessage: string): HttpException {
	if (error instanceof PiAdminProtocolError) {
		return new BadRequestException({
			code: "PI_PROTOCOL_INVALID",
			message: error.message,
		});
	}
	const failure = error as { code?: string; message?: string };
	if (failure.code === "PI_PROVIDER_VALIDATION_FAILED") {
		return new BadRequestException({
			code: failure.code,
			message: fallbackMessage,
		});
	}
	if (failure.code === "PI_CONFIG_UNAVAILABLE") {
		return new BadRequestException({
			code: failure.code,
			message: failure.message ?? fallbackMessage,
		});
	}
	return new HttpException(
		{ code: "PI_OPERATION_FAILED", message: fallbackMessage },
		500,
	);
}

/** 分页参数：与仓库约定一致，pageSize 限制在 1-100。 */
function pageParams(page?: string, pageSize?: string) {
	return {
		page: page ? Math.max(1, Number.parseInt(page, 10) || 1) : 1,
		pageSize: pageSize
			? Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 1))
			: 20,
	};
}

@Controller("api/pi")
export class PiAdminController {
	constructor(
		@Inject(PiProfileService) private readonly profiles: PiProfileService,
		@Inject(PiCredentialService)
		private readonly credentials: PiCredentialService,
		@Inject(PiProviderService)
		private readonly providers: PiProviderService,
		/** 配置变更后重新下发 RuntimeSpec（可选注入：旧测试构造保持兼容） */
		@Optional()
		@Inject(PiRuntimeService)
		private readonly runtime?: PiRuntimeService,
	) {}

	// ── Provider ──

	@Get("providers")
	async listProviders(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		const { page: p, pageSize: s } = pageParams(page, pageSize);
		return this.providers.list(p, s);
	}

	@Post("providers")
	async createProvider(@Body() body: unknown) {
		try {
			const provider = await this.providers.create(parsePiProviderCreateInput(body));
			return provider;
		} catch (error) {
			throw piHttpError(error, "Pi Provider 创建失败");
		}
	}

	@Post("providers/discover-models")
	async discoverTransientProviderModels(@Body() body: unknown) {
		try {
			return await this.providers.discover(parsePiProviderDiscoveryInput(body));
		} catch (error) {
			throw piHttpError(error, "Pi Provider 模型发现失败");
		}
	}

	@Get("providers/:id")
	async getProvider(@Param("id") id: string) {
		try {
			return await this.providers.get(id);
		} catch (error) {
			throw piHttpError(error, "Pi Provider 不存在");
		}
	}

	@Patch("providers/:id")
	async updateProvider(@Param("id") id: string, @Body() body: unknown) {
		try {
			return await this.providers.update(id, parsePiProviderUpdateInput(body));
		} catch (error) {
			throw piHttpError(error, "Pi Provider 更新失败");
		}
	}

	@Delete("providers/:id")
	async removeProvider(@Param("id") id: string) {
		try {
			await this.providers.remove(id);
			return { ok: true };
		} catch (error) {
			throw piHttpError(error, "Pi Provider 删除失败");
		}
	}

	@Post("providers/:id/validate")
	async validateProvider(@Param("id") id: string) {
		try {
			return await this.providers.validate(id);
		} catch (error) {
			throw piHttpError(error, "Pi Provider 校验失败");
		}
	}

	@Post("providers/:id/discover-models")
	async discoverProviderModels(@Param("id") id: string) {
		try {
			return await this.providers.discoverModels(id);
		} catch (error) {
			throw piHttpError(error, "Pi Provider 模型发现失败");
		}
	}

	@Get("profiles")
	async listProfiles(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		const { page: p, pageSize: s } = pageParams(page, pageSize);
		return this.profiles.list(p, s);
	}

	@Post("profiles")
	async createProfile(@Body() body: unknown) {
		try {
			const profile = await this.profiles.create(parsePiProfileCreateInput(body));
			await this.runtime?.pushToBoundClients(profile.id);
			return profile;
		} catch (error) {
			throw piHttpError(error, "Pi Profile 创建失败");
		}
	}

	@Get("profiles/:id")
	async getProfile(@Param("id") id: string) {
		try {
			return await this.profiles.get(id);
		} catch (error) {
			throw piHttpError(error, "Pi Profile 不存在");
		}
	}

	@Patch("profiles/:id")
	async updateProfile(@Param("id") id: string, @Body() body: unknown) {
		try {
			const profile = await this.profiles.update(
				id,
				parsePiProfileUpdateInput(body),
			);
			await this.runtime?.pushToBoundClients(profile.id);
			return profile;
		} catch (error) {
			throw piHttpError(error, "Pi Profile 更新失败");
		}
	}

	@Delete("profiles/:id")
	async removeProfile(@Param("id") id: string) {
		try {
			const boundClientIds = (await this.profiles.get(id)).boundClientIds;
			await this.profiles.remove(id);
			for (const clientId of boundClientIds) {
				await this.runtime?.pushTo(clientId);
			}
			return { ok: true };
		} catch (error) {
			throw piHttpError(error, "Pi Profile 删除失败");
		}
	}

	// ── Credential ──

	@Get("credentials")
	async listCredentials(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		const { page: p, pageSize: s } = pageParams(page, pageSize);
		return this.credentials.list(p, s);
	}

	@Post("credentials")
	async createCredential(@Body() body: unknown) {
		try {
			const created = await this.credentials.create(
				parsePiCredentialCreateInput(body),
			);
			await this.runtime?.pushToCredentialBoundClients(created.id);
			return created;
		} catch (error) {
			throw piHttpError(error, "Pi 凭据创建失败");
		}
	}

	@Patch("credentials/:id")
	async updateCredential(@Param("id") id: string, @Body() body: unknown) {
		try {
			const updated = await this.credentials.update(
				id,
				parsePiCredentialUpdateInput(body),
			);
			await this.runtime?.pushToCredentialBoundClients(updated.id);
			return updated;
		} catch (error) {
			throw piHttpError(error, "Pi 凭据更新失败");
		}
	}

	@Delete("credentials/:id")
	async revokeCredential(@Param("id") id: string) {
		try {
			const revoked = await this.credentials.revoke(id);
			await this.runtime?.pushToCredentialBoundClients(revoked.id);
			return revoked;
		} catch (error) {
			throw piHttpError(error, "Pi 凭据撤销失败");
		}
	}

	// ── Client → Profile 绑定 ──

	@Get("client-bindings")
	async listBindings() {
		return this.profiles.listBindings();
	}

	@Put("client-bindings/:clientId")
	async setBinding(
		@Param("clientId") clientId: string,
		@Body() body: unknown,
	) {
		const profileId = (body as { profileId?: unknown } | null)?.profileId;
		if (typeof profileId !== "string" || profileId.length === 0) {
			throw new BadRequestException({
				code: "PI_PROTOCOL_INVALID",
				message: "profileId 必须是非空字符串",
			});
		}
		try {
			await this.profiles.setBinding(clientId, profileId);
			await this.runtime?.pushTo(clientId);
			return { ok: true };
		} catch (error) {
			throw piHttpError(error, "Pi 绑定失败");
		}
	}

	@Delete("client-bindings/:clientId")
	async clearBinding(@Param("clientId") clientId: string) {
		try {
			await this.profiles.clearBinding(clientId);
			await this.runtime?.pushTo(clientId);
			return { ok: true };
		} catch (error) {
			throw piHttpError(error, "Pi 解绑失败");
		}
	}
}
