import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	HttpException,
	Inject,
	Param,
	Post,
	Put,
	Query,
	Res,
} from "@nestjs/common";
import type { ActorContext, ReleasePlatform } from "@vcpdeck/shared";
import type { Response } from "express";
import { Actor } from "../auth/actor.decorator.js";
import { Public } from "../auth/public.decorator.js";
import {
	ClientInstallerError,
	ClientInstallerService,
	type ClientInstallerBootstrap,
	type ClientInstallerConfigInfo,
	type ClientInstallerPreflight,
} from "./client-installer.service.js";

function parsePlatform(value: unknown): ReleasePlatform {
	if (value === "win-x64" || value === "linux-x64") return value;
	throw new Error("platform 必须为 win-x64 或 linux-x64");
}

function parseConfigUpdate(value: unknown): { enabled: boolean } {
	if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.enabled !== "boolean") {
		throw new Error("body 必须且只能包含 boolean enabled");
	}
	return { enabled: value.enabled };
}

function parseNameUpdate(value: unknown): { name: string } {
	if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.name !== "string") {
		throw new Error("body 必须且只能包含 string name");
	}
	const name = value.name.trim();
	if (!name || name.length > 100) throw new Error("name 长度必须为 1-100");
	return { name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
	"install-client-bootstrap.sh": "text/x-shellscript; charset=utf-8",
	"install-client-bootstrap.ps1": "text/plain; charset=utf-8",
	"install-client.cjs": "text/javascript; charset=utf-8",
	"install.cjs": "text/javascript; charset=utf-8",
};

/** Client 一键安装配置、脚本、bootstrap 与上线验收 API。 */
@Controller("api/client-installer")
export class ClientInstallerController {
	constructor(
		@Inject(ClientInstallerService)
		private readonly service: ClientInstallerService,
	) {}

	@Get("config")
	getConfig(): Promise<ClientInstallerConfigInfo> {
		return this.service.getConfig();
	}

	@Put("config")
	updateConfig(
		@Body() raw: unknown,
		@Actor() actor: ActorContext,
	): Promise<ClientInstallerConfigInfo> {
		try {
			const { enabled } = parseConfigUpdate(raw);
			return this.service.updateConfig(enabled, actor);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Public()
	@Get("scripts/:platform")
	@Header("Cache-Control", "no-cache")
	getScript(
		@Param("platform") rawPlatform: string,
		@Res() response: Response,
	): void {
		try {
			const platform = parsePlatform(rawPlatform);
			const name =
				platform === "win-x64"
					? "install-client-bootstrap.ps1"
					: "install-client-bootstrap.sh";
			response.type(ASSET_CONTENT_TYPES[name]!).send(this.service.readAsset(name));
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Public()
	@Get("assets/:name")
	@Header("Cache-Control", "no-cache")
	getAsset(@Param("name") name: string, @Res() response: Response): void {
		if (!(name in ASSET_CONTENT_TYPES)) {
			throw new BadRequestException("未知安装资产");
		}
		try {
			response
				.type(ASSET_CONTENT_TYPES[name]!)
				.send(
					this.service.readAsset(
						name as
							| "install-client-bootstrap.sh"
							| "install-client-bootstrap.ps1"
							| "install-client.cjs"
							| "install.cjs",
					),
				);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Public()
	@Get("preflight")
	@Header("Cache-Control", "no-store")
	preflight(
		@Query("platform") rawPlatform?: string,
	): Promise<ClientInstallerPreflight> {
		try {
			return this.service.preflight(parsePlatform(rawPlatform));
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Public()
	@Post("bootstrap")
	@Header("Cache-Control", "no-store, private")
	bootstrap(@Body() raw: unknown): Promise<ClientInstallerBootstrap> {
		try {
			if (!isRecord(raw) || Object.keys(raw).length !== 1) {
				throw new Error("body 必须且只能包含 platform");
			}
			return this.service.bootstrap(parsePlatform(raw.platform));
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Public()
	@Get("clients/:clientId/status")
	@Header("Cache-Control", "no-store")
	getClientStatus(
		@Param("clientId") clientId: string,
		@Query("psk") _forbiddenQueryPsk: string | undefined,
		@Res({ passthrough: true }) response: Response,
	) {
		try {
			if (_forbiddenQueryPsk !== undefined) {
				throw new Error("PSK 不得通过 query 传递");
			}
			this.service.assertPsk(response.req.header("x-vcpdeck-psk"));
			return this.service.getClientStatus(clientId);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Public()
	@Put("clients/:clientId/name")
	@Header("Cache-Control", "no-store")
	renameClient(
		@Param("clientId") clientId: string,
		@Body() raw: unknown,
		@Res({ passthrough: true }) response: Response,
	) {
		try {
			this.service.assertPsk(response.req.header("x-vcpdeck-psk"));
			const { name } = parseNameUpdate(raw);
			return this.service.renameClient(clientId, name);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	private toHttp(error: unknown): HttpException {
		if (error instanceof HttpException) return error;
		if (error instanceof ClientInstallerError) {
			return new HttpException(
				{ code: error.code, message: error.message },
				error.statusCode,
			);
		}
		if (error instanceof Error) {
			return new BadRequestException({ code: "INVALID_REQUEST", message: error.message });
		}
		return new BadRequestException("请求无效");
	}
}
