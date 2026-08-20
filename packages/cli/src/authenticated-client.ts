import { VcpDeckClient } from "@vcpdeck/sdk";
import type { ResolvedEnvironment } from "./environment.js";

/** 按已解析环境创建 SDK 客户端；Bearer 直接代表身份，密码仅保留兼容登录。 */
export async function createAuthenticatedClient(
	environment: ResolvedEnvironment,
): Promise<VcpDeckClient> {
	if (!environment.credentials) throw new Error("环境凭据未解析");
	if (environment.credentials.type === "bearer") {
		return new VcpDeckClient({
			baseUrl: environment.server,
			auth: { type: "bearer", token: environment.credentials.token },
		});
	}
	const loginClient = new VcpDeckClient({
		baseUrl: environment.server,
		auth: { type: "cookie" },
	});
	const { cookie } = await loginClient.auth.loginSession({
		username: environment.credentials.username,
		password: environment.credentials.password,
	});
	return new VcpDeckClient({
		baseUrl: environment.server,
		auth: { type: "cookie", cookie },
	});
}
