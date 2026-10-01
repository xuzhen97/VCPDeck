/**
 * Git SSH 共享密钥管理 REST API（ADR-0037 / ADR-0038）。
 *
 * 安全约束：
 * - 只返回公钥、指纹与分发状态，永不返回私钥或密文；
 * - 输入经 Shared 严格 parser 校验，未知字段与非法值 fail closed；
 * - 错误只返回稳定 code 与安全文案，不回显原始异常或内部路径。
 */
import {
	BadRequestException,
	Body,
	Controller,
	Get,
	HttpException,
	Inject,
	Post,
	Put,
} from "@nestjs/common";
import {
	GitSshProtocolError,
	parseGitSshTargetInput,
} from "@vcpdeck/shared";
import { GitSshService } from "./git-ssh.service.js";

/** 协议输入错误 → 400；密钥不可用 → 400；其余 → 500 且只回安全文案。 */
function gitSshHttpError(error: unknown, fallbackMessage: string): HttpException {
	if (error instanceof GitSshProtocolError) {
		return new BadRequestException({
			code: "GIT_SSH_PROTOCOL_INVALID",
			message: error.message,
		});
	}
	const failure = error as { code?: string; message?: string };
	if (failure.code === "GIT_SSH_KEY_UNAVAILABLE") {
		return new BadRequestException({
			code: failure.code,
			message: failure.message ?? fallbackMessage,
		});
	}
	return new HttpException(
		{ code: "GIT_SSH_OPERATION_FAILED", message: fallbackMessage },
		500,
	);
}

@Controller("api/git-ssh")
export class GitSshController {
	constructor(@Inject(GitSshService) private readonly gitSsh: GitSshService) {}

	/** 当前公钥投影；未生成密钥时返回 null。 */
	@Get()
	async getKey() {
		return this.gitSsh.getPublicInfo();
	}

	/** 生成新一代密钥；公钥由操作者人工登记到 Git 服务。 */
	@Post("generate")
	async generate() {
		try {
			return await this.gitSsh.generate();
		} catch (error) {
			throw gitSshHttpError(error, "Git SSH 密钥生成失败");
		}
	}

	/** 替换选机集合（全量）。 */
	@Put("targets")
	async setTargets(@Body() body: unknown) {
		try {
			const { clientIds } = parseGitSshTargetInput(body);
			return await this.gitSsh.setTargets(clientIds);
		} catch (error) {
			throw gitSshHttpError(error, "Git SSH 选机更新失败");
		}
	}

	/** 密钥与每机分发状态投影。 */
	@Get("status")
	async status() {
		return this.gitSsh.status();
	}
}
