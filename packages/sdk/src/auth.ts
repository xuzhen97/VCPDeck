import type {
	CreateIdentityRequest,
	CreateTokenRequest,
	CreateTokenResponse,
	IdentityInfo,
	LoginRequest,
	LoginResponse,
	TokenInfo,
	UpdateMeRequest,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** Node.js 登录后可显式携带的 Cookie 会话。 */
export interface LoginSession {
	login: LoginResponse;
	cookie: string;
}

/** 创建认证与个人凭证 API。 */
export function createAuthApi(
	client: Pick<VcpDeckClient, "request" | "requestRaw">,
) {
	return {
		login: (input: LoginRequest, signal?: AbortSignal) =>
			client.request<LoginResponse>("POST", "/api/auth/login", input, signal),
		/** 登录并提取 Cookie；仅供不会自动维护 Cookie 的 Node.js 调用方。 */
		loginSession: async (
			input: LoginRequest,
			signal?: AbortSignal,
		): Promise<LoginSession> => {
			const { data, response } = await client.requestRaw<LoginResponse>(
				"POST",
				"/api/auth/login",
				{
					body: JSON.stringify(input),
					headers: { "Content-Type": "application/json" },
					signal,
				},
			);
			const setCookie = response.headers.get("set-cookie");
			const session = setCookie?.match(/vcpdeck_session=([^;]+)/)?.[1];
			if (!session) {
				throw new Error("Login response did not include a session cookie");
			}
			return { login: data, cookie: `vcpdeck_session=${session}` };
		},
		logout: (signal?: AbortSignal) =>
			client.request<{ ok: true }>("POST", "/api/auth/logout", undefined, signal),
		me: (signal?: AbortSignal) =>
			client.request<IdentityInfo>("GET", "/api/auth/me", undefined, signal),
		updateMe: (input: UpdateMeRequest, signal?: AbortSignal) =>
			client.request<{ ok: true }>("PUT", "/api/auth/me", input, signal),
		tokens: {
			list: (signal?: AbortSignal) =>
				client.request<TokenInfo[]>("GET", "/api/auth/tokens", undefined, signal),
			create: (input: CreateTokenRequest, signal?: AbortSignal) =>
				client.request<CreateTokenResponse>(
					"POST",
					"/api/auth/tokens",
					input,
					signal,
				),
			revoke: (id: string, signal?: AbortSignal) =>
				client.request<{ ok: true }>(
					"DELETE",
					`/api/auth/tokens/${encodeURIComponent(id)}`,
					undefined,
					signal,
				),
		},
	};
}

/** 创建管理员身份 API。 */
export function createIdentitiesApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (signal?: AbortSignal) =>
			client.request<IdentityInfo[]>("GET", "/api/identities", undefined, signal),
		create: (input: CreateIdentityRequest, signal?: AbortSignal) =>
			client.request<IdentityInfo>("POST", "/api/identities", input, signal),
		disable: (id: string, signal?: AbortSignal) =>
			client.request<{ ok: true }>(
				"POST",
				`/api/identities/${encodeURIComponent(id)}/disable`,
				undefined,
				signal,
			),
		enable: (id: string, signal?: AbortSignal) =>
			client.request<{ ok: true }>(
				"POST",
				`/api/identities/${encodeURIComponent(id)}/enable`,
				undefined,
				signal,
			),
	};
}
