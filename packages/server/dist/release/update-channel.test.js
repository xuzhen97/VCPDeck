"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const update_channel_js_1 = require("./update-channel.js");
function mockClients() {
    return {
        listOnline: vitest_1.vi.fn(),
    };
}
(0, vitest_1.describe)("GatewayUpdateChannel", () => {
    let clients;
    let channel;
    (0, vitest_1.beforeEach)(() => {
        clients = mockClients();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel = new update_channel_js_1.GatewayUpdateChannel(clients);
    });
    (0, vitest_1.it)("listOnlineClients 映射为 { clientId, clientVersion, os }", async () => {
        clients.listOnline.mockResolvedValue([
            { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            { clientId: "c2", clientVersion: "1.2.1", os: "linux 6.8 x64" },
        ]);
        const list = await channel.listOnlineClients();
        (0, vitest_1.expect)(list).toEqual([
            { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            { clientId: "c2", clientVersion: "1.2.1", os: "linux 6.8 x64" },
        ]);
    });
    (0, vitest_1.it)("未绑定时发送抛错", () => {
        (0, vitest_1.expect)(() => channel.sendUpdateRequest("c1", {
            releaseVersion: "1.2.1",
            url: "/x",
            sha256: "a".repeat(64),
        })).toThrow("未绑定");
    });
    (0, vitest_1.it)("bindEmitters 后 sendUpdateRequest / broadcastShutdown 走绑定函数", () => {
        const sendUpdateRequest = vitest_1.vi.fn();
        const broadcastShutdown = vitest_1.vi.fn();
        channel.bindEmitters({ sendUpdateRequest, broadcastShutdown });
        const req = {
            releaseVersion: "1.2.1",
            url: "/api/releases/1.2.1/file",
            sha256: "a".repeat(64),
        };
        channel.sendUpdateRequest("c1", req);
        channel.broadcastShutdown({ expectedVersion: "1.2.1" });
        (0, vitest_1.expect)(sendUpdateRequest).toHaveBeenCalledWith("c1", req);
        (0, vitest_1.expect)(broadcastShutdown).toHaveBeenCalledWith({
            expectedVersion: "1.2.1",
        });
    });
});
