"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createControlServer = createControlServer;
exports.runPreStart = runPreStart;
/**
 * Launcher 本地控制通道服务端。
 * 详见 docs/design/release-and-update.md。
 * 监听 127.0.0.1 随机端口 + 随机 token，写 control.json 供被守护进程调用：
 * - POST /prepare：下载/校验/解压新版本（服务进程仍在运行）
 * - POST /apply：停掉本进程并切换版本（响应可能无法送达，属正常）
 * preStart 钩子（如 prisma db push）在切换前由编排侧调用 runPreStart。
 */
const node_http_1 = require("node:http");
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf-8");
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1024 * 1024) {
                reject(new Error("请求体过大"));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch (e) {
                reject(new Error(`请求体 JSON 无效: ${e.message}`));
            }
        });
        req.on("error", reject);
    });
}
function respond(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}
/** 启动控制通道 HTTP 服务并写 control.json */
async function createControlServer(options) {
    const token = options.token ?? (0, node_crypto_1.randomUUID)();
    const log = options.log ?? (() => undefined);
    const server = (0, node_http_1.createServer)(async (req, res) => {
        if (req.headers["x-launcher-token"] !== token) {
            respond(res, 401, { code: "UNAUTHORIZED", message: "token 无效" });
            return;
        }
        try {
            if (req.method === "POST" && req.url === "/prepare") {
                const body = (await readJsonBody(req));
                if (!body.version || !body.url || !body.sha256) {
                    respond(res, 400, {
                        code: "BAD_REQUEST",
                        message: "缺少 version/url/sha256",
                    });
                    return;
                }
                await options.handlers.prepare({
                    version: body.version,
                    url: body.url,
                    sha256: body.sha256,
                });
                respond(res, 200, { ok: true });
                return;
            }
            if (req.method === "POST" && req.url === "/apply") {
                await options.handlers.apply();
                respond(res, 200, { ok: true });
                return;
            }
            respond(res, 404, { code: "NOT_FOUND", message: "未知路径" });
        }
        catch (e) {
            log(`[launcher] 控制通道请求失败: ${e.message}`);
            respond(res, 500, {
                code: "INTERNAL",
                message: e instanceof Error ? e.message : String(e),
            });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    await (0, promises_1.writeFile)(options.controlFile, JSON.stringify({ port: address.port, token, pid: process.pid }), "utf-8");
    log(`[launcher] 控制通道已监听 127.0.0.1:${address.port}`);
    return {
        port: address.port,
        token,
        close: () => new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
}
/**
 * preStart 钩子：切换版本前在构件目录执行（如 prisma db push）。
 * 命令为空时跳过；失败抛错（含命令摘要，不含输出细节）。
 */
async function runPreStart(cmd, cwd, execImpl = execFileAsync) {
    if (!cmd)
        return;
    try {
        await execImpl(cmd, { cwd, shell: true, timeout: 120_000 });
    }
    catch {
        throw new Error(`preStart 失败: ${cmd}`);
    }
}
