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

/** 创建认证与个人凭证 API。 */
export function createAuthApi(client: Pick<VcpDeckClient, "request">) {
	return {
		login: (input: LoginRequest, signal?: AbortSignal) =>
			client.request<LoginResponse>("POST", "/api/auth/login", input, signal),
		logout: (signal?: AbortSignal) =>
			client.request<{ ok: true }>(
				"POST",
				"/api/auth/logout",
				undefined,
				signal,
			),
		me: (signal?: AbortSignal) =>
			client.request<IdentityInfo>("GET", "/api/auth/me", undefined, signal),
		updateMe: (input: UpdateMeRequest, signal?: AbortSignal) =>
			client.request<{ ok: true }>("PUT", "/api/auth/me", input, signal),
		tokens: {
			list: (signal?: AbortSignal) =>
				client.request<TokenInfo[]>(
					"GET",
					"/api/auth/tokens",
					undefined,
					signal,
				),
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
			client.request<IdentityInfo[]>(
				"GET",
				"/api/identities",
				undefined,
				signal,
			),
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
