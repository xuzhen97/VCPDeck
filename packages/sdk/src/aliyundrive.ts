import type { VcpDeckClient } from "./client.js";

/** 阿里云盘安全状态；不包含访问凭证。 */
export interface AliyunDriveStatus {
	configured: boolean;
	authorized: boolean;
	hasAuth: boolean;
	isExpired: boolean;
	clientId?: string;
	openapiBase: string;
	transferFolder: string;
	driveId?: string;
	expiresAt?: number;
}

/** 阿里云盘公开配置输入。 */
export interface AliyunDriveConfigInput {
	clientId: string;
	clientSecret?: string | null;
	openapiBase?: string;
	transferFolder?: string;
}

/** 创建阿里云盘 OAuth API。 */
export function createAliyunDriveApi(client: Pick<VcpDeckClient, "request">) {
	return {
		status: (signal?: AbortSignal) =>
			client.request<AliyunDriveStatus>(
				"GET",
				"/api/aliyundrive/status",
				undefined,
				signal,
			),
		configure: (input: AliyunDriveConfigInput, signal?: AbortSignal) =>
			client.request<Omit<AliyunDriveConfigInput, "clientSecret">>(
				"PUT",
				"/api/aliyundrive/config",
				input,
				signal,
			),
		startOAuth: (signal?: AbortSignal) =>
			client.request<{
				state: string;
				authorizationUrl: string;
				expiresAt: number;
			}>("POST", "/api/aliyundrive/oauth/start", undefined, signal),
		completeOAuth: (
			input: { state: string; code: string },
			signal?: AbortSignal,
		) =>
			client.request<{ authorized: true; expiresAt: number }>(
				"POST",
				"/api/aliyundrive/oauth/complete",
				input,
				signal,
			),
		revoke: (signal?: AbortSignal) =>
			client.request<{ revoked: true }>(
				"POST",
				"/api/aliyundrive/oauth/revoke",
				undefined,
				signal,
			),
	};
}
