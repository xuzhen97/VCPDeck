import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStorageCommand } from "./storage-command.js";
import { saveCliConfig } from "./config.js";
const tempDirectories = [];
const servers = [];
async function fixture(port) {
    const root = await mkdtemp(join(tmpdir(), "vcpdeck-storage-command-"));
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
    return { paths, processEnv: { VCPDECK_TEST_TOKEN: "vcp_test_token" } };
}
afterEach(async () => {
    await Promise.all(servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(() => resolve()))));
    await Promise.all(tempDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })));
});
describe("storage command", () => {
    it("未知子命令返回错误；--help 零开销输出", async () => {
        await expect(runStorageCommand("set", [])).rejects.toThrow("Storage 命令");
        await expect(runStorageCommand(undefined, ["--help"])).resolves.toBeUndefined();
    });
    it("status 输出后端类型与更新时间", async () => {
        const server = createServer((_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ kind: "alibaba", updatedAt: "2026-08-20T00:00:00Z" }));
        });
        servers.push(server);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;
        const { paths, processEnv } = await fixture(port);
        const lines = [];
        await runStorageCommand("status", [], {
            paths,
            processEnv,
            log: (m) => lines.push(m),
        });
        const output = lines.join("\n");
        expect(output).toContain("Storage 后端: alibaba");
        expect(output).toContain("2026-08-20T00:00:00Z");
        expect(output).not.toContain("vcp_test_token");
        const jsonLines = [];
        await runStorageCommand("status", ["--json"], {
            paths,
            processEnv,
            log: (m) => jsonLines.push(m),
        });
        expect(JSON.parse(jsonLines.join("\n"))).toEqual({
            kind: "alibaba",
            updatedAt: "2026-08-20T00:00:00Z",
        });
    });
});
