import { describe, expect, it, vi } from "vitest";
import { createAuthApi } from "./auth.js";

describe("auth.loginSession", () => {
	it("从登录响应中提取最小 Cookie 会话", async () => {
		const requestRaw = vi.fn(async () => ({
			data: { identity: { id: "identity-1" } },
			response: new Response("{}", {
				headers: {
					"set-cookie":
						"vcpdeck_session=session_token; Path=/; HttpOnly; SameSite=Strict",
				},
			}),
		}));
		const api = createAuthApi({
			request: vi.fn(),
			requestRaw,
		} as never);

		await expect(
			api.loginSession({ username: "admin", password: "secret" }),
		).resolves.toMatchObject({ cookie: "vcpdeck_session=session_token" });
		expect(requestRaw).toHaveBeenCalledWith("POST", "/api/auth/login", {
			body: JSON.stringify({ username: "admin", password: "secret" }),
			headers: { "Content-Type": "application/json" },
			signal: undefined,
		});
	});

	it("登录响应缺少 Cookie 时明确失败", async () => {
		const api = createAuthApi({
			request: vi.fn(),
			requestRaw: vi.fn(async () => ({
				data: { identity: { id: "identity-1" } },
				response: new Response("{}"),
			})),
		} as never);

		await expect(
			api.loginSession({ username: "admin", password: "secret" }),
		).rejects.toThrow("session cookie");
	});
});
