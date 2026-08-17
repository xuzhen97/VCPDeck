import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayUpdateChannel } from "./update-channel.js";

function mockClients() {
	return {
		listOnline: vi.fn(),
	};
}

describe("GatewayUpdateChannel", () => {
	let clients: ReturnType<typeof mockClients>;
	let channel: GatewayUpdateChannel;

	beforeEach(() => {
		clients = mockClients();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		channel = new GatewayUpdateChannel(clients as any);
	});

	it("listOnlineClients 映射为 { clientId, clientVersion, os }", async () => {
		clients.listOnline.mockResolvedValue([
			{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			{ clientId: "c2", clientVersion: "1.2.1", os: "linux 6.8 x64" },
		]);

		const list = await channel.listOnlineClients();

		expect(list).toEqual([
			{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			{ clientId: "c2", clientVersion: "1.2.1", os: "linux 6.8 x64" },
		]);
	});

	it("未绑定时发送抛错", () => {
		expect(() =>
			channel.sendUpdateRequest("c1", {
				releaseVersion: "1.2.1",
				url: "/x",
				sha256: "a".repeat(64),
			}),
		).toThrow("未绑定");
	});

	it("bindEmitters 后 sendUpdateRequest / broadcastShutdown 走绑定函数", () => {
		const sendUpdateRequest = vi.fn();
		const broadcastShutdown = vi.fn();
		channel.bindEmitters({ sendUpdateRequest, broadcastShutdown });

		const req = {
			releaseVersion: "1.2.1",
			url: "/api/releases/1.2.1/file",
			sha256: "a".repeat(64),
		};
		channel.sendUpdateRequest("c1", req);
		channel.broadcastShutdown({ expectedVersion: "1.2.1" });

		expect(sendUpdateRequest).toHaveBeenCalledWith("c1", req);
		expect(broadcastShutdown).toHaveBeenCalledWith({
			expectedVersion: "1.2.1",
		});
	});
});
