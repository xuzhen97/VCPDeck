import { createServer, } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runClientsCommand } from "./clients-command.js";
import { saveCliConfig } from "./config.js";
const tempDirectories = [];
const servers = [];
async function fixture(port) {
    const root = await mkdtemp(join(tmpdir(), "vcpdeck-clients-command-"));
    tempDirectories.push(root);
    const paths = { globalConfigPath: join(root, "config.json"), cwd: root };
    await saveCliConfig(paths.globalConfigPath, {
        version: 1,
        defaultEnvironment: "test",
        environments: {
            test: {
                server: `http://127.0.0.1:${port}`,
                auth: { type: "bearer", tokenEnv: "VCPDECK_TEST_TOKEN" },
            },
        },
    });
    return {
        root,
        paths,
        processEnv: { VCPDECK_TEST_TOKEN: "vcp_test_token" },
    };
}
function clientInfo(overrides = {}) {
    return {
        clientId: "client-1",
        name: "workstation",
        hostname: "WORKSTATION",
        os: "win32 24H2",
        cpuModel: "Test CPU",
        totalMemMB: 32_768,
        clientVersion: "0.2.5",
        capabilities: ["pi", "terminal"],
        capabilityDetails: {},
        online: true,
        cpuPercent: 12.4,
        memPercent: 55.6,
        disks: [],
        lastHeartbeatAt: "2026-08-22T00:00:00.000Z",
        ...overrides,
    };
}
async function listen(handler) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("测试 Server 未监听");
    return { server, port: address.port };
}
afterEach(async () => {
    await Promise.all(servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await Promise.all(tempDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })));
});
describe("clients command", () => {
    it("未知子命令返回用法错误", async () => {
        await expect(runClientsCommand(undefined, [])).rejects.toThrow("Clients 命令");
        await expect(runClientsCommand("rename", [])).rejects.toThrow("vcpdeck clients list");
    });
    it("--help 输出用法并以零开销返回", async () => {
        const lines = [];
        await runClientsCommand("list", ["--help"], {
            log: (message) => lines.push(message),
        });
        await runClientsCommand(undefined, ["-h"], {
            log: (message) => lines.push(message),
        });
        expect(lines.filter((line) => line.includes("vcpdeck clients list"))).toHaveLength(2);
    });
    it("拒绝未知选项和冲突别名", async () => {
        await expect(runClientsCommand("list", ["--watch"])).rejects.toThrow("未知选项");
        await expect(runClientsCommand("list", ["--env=a", "--environment=b"])).rejects.toThrow("不能同时使用");
    });
    it("命名 Bearer 环境请求 /api/clients 并输出人类可读摘要", async () => {
        const requests = [];
        const { port } = await listen((request, response) => {
            requests.push({
                url: request.url ?? "",
                authorization: request.headers.authorization,
            });
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify([
                clientInfo({
                    clientId: "client-2",
                    name: "nas",
                    online: false,
                    cpuPercent: null,
                    memPercent: null,
                }),
                clientInfo(),
            ]));
        });
        const { paths, processEnv } = await fixture(port);
        const lines = [];
        await runClientsCommand("list", [], {
            paths,
            processEnv,
            log: (message) => lines.push(message),
        });
        expect(requests).toEqual([
            { url: "/api/clients", authorization: "Bearer vcp_test_token" },
        ]);
        expect(lines[0]).toContain("test");
        const summary = lines.join("\n");
        expect(summary).toContain("共 2 台 · 在线 1 · 离线 1");
        expect(summary.indexOf("workstation")).toBeLessThan(summary.indexOf("nas"));
        expect(summary).toContain("online");
        expect(summary).toContain("offline");
        expect(summary).toContain("-");
        expect(summary).not.toContain("vcp_test_token");
    });
    it("--json 输出原始 ClientInfo 数组", async () => {
        const clients = [clientInfo()];
        const { port } = await listen((_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(clients));
        });
        const { paths, processEnv } = await fixture(port);
        const lines = [];
        await runClientsCommand("list", ["--json"], {
            paths,
            processEnv,
            log: (message) => lines.push(message),
        });
        const parsed = JSON.parse(lines.join("\n"));
        expect(parsed).toEqual(clients);
    });
    it("空列表给出明确提示", async () => {
        const { port } = await listen((_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify([]));
        });
        const { paths, processEnv } = await fixture(port);
        const lines = [];
        await runClientsCommand("list", [], {
            paths,
            processEnv,
            log: (message) => lines.push(message),
        });
        expect(lines.at(-1)).toBe("没有已注册的 Client。");
    });
});
