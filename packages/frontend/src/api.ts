const BASE = "http://localhost:3001";

async function request<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(BASE + path, {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		credentials: "include",
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ message: res.statusText }));
		throw new Error(err.code || err.message || "Request failed");
	}
	return res.json();
}

export const api = {
	login: (data: { username: string; password: string }) =>
		request<{
			identity: {
				id: string;
				username: string;
				displayName: string;
				isAdmin: boolean;
			};
		}>("POST", "/api/auth/login", data),

	logout: () => request<{ ok: boolean }>("POST", "/api/auth/logout"),

	getMe: () =>
		request<{
			id: string;
			username: string;
			displayName: string;
			isAdmin: boolean;
			disabledAt: string | null;
			createdAt: string;
		}>("GET", "/api/auth/me"),

	updateMe: (data: {
		username?: string;
		password?: string;
		currentPassword: string;
	}) => request<{ ok: boolean }>("PUT", "/api/auth/me", data),

	createToken: (label: string) =>
		request<{ id: string; token: string; label: string }>(
			"POST",
			"/api/auth/tokens",
			{ label },
		),

	listTokens: () =>
		request<
			{
				id: string;
				label: string;
				lastUsedAt: string | null;
				expiresAt: string | null;
				revokedAt: string | null;
				createdAt: string;
			}[]
		>("GET", "/api/auth/tokens"),

	revokeToken: (id: string) =>
		request<{ ok: boolean }>("DELETE", `/api/auth/tokens/${id}`),

	listIdentities: () =>
		request<
			{
				id: string;
				username: string;
				displayName: string;
				isAdmin: boolean;
				disabledAt: string | null;
				createdAt: string;
			}[]
		>("GET", "/api/identities"),

	createIdentity: (data: {
		username: string;
		password: string;
		displayName: string;
	}) => request<{ ok: boolean }>("POST", "/api/identities", data),

	disableIdentity: (id: string) =>
		request<{ ok: boolean }>("POST", `/api/identities/${id}/disable`),

	enableIdentity: (id: string) =>
		request<{ ok: boolean }>("POST", `/api/identities/${id}/enable`),
};
