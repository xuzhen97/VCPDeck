"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientLauncher = void 0;
/**
 * 本机 launcher 控制通道客户端（客户端侧，与服务端 release/launcher-client.ts 同协议）。
 * Launcher 监听 127.0.0.1 + token，并写入 control.json。
 * 详见 docs/design/release-and-update.md。
 * - prepare：launcher 下载/校验/解压新版本（客户端进程仍在运行）
 * - apply：launcher 停掉本进程并切换版本（响应无法送达属正常，视为成功）
 */
const node_os_1 = require("node:os");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const DEFAULT_CONTROL_FILE = (0, node_path_1.join)(process.env.VCPDECK_APP_DIR ?? (0, node_path_1.join)((0, node_os_1.homedir)(), ".vcpdeck", "launcher"), "control.json");
class ClientLauncher {
    controlFile;
    fetchImpl;
    constructor(options = {}) {
        this.controlFile = options.controlFile ?? DEFAULT_CONTROL_FILE;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async readControl() {
        const raw = await (0, promises_1.readFile)(this.controlFile, "utf-8");
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error(`launcher control.json 无效: ${this.controlFile}`);
        }
        if (!parsed?.port || !parsed?.token) {
            throw new Error(`launcher control.json 无效: ${this.controlFile}`);
        }
        return { port: parsed.port, token: parsed.token };
    }
    async post(ctl, path, body) {
        const res = await this.fetchImpl(`http://127.0.0.1:${ctl.port}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-launcher-token": ctl.token,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`launcher ${path} 失败: HTTP ${res.status} ${text}`);
        }
    }
    /** 第一阶段：让 launcher 准备新版本（下载/校验/解压） */
    async prepareUpdate(input) {
        const ctl = await this.readControl();
        await this.post(ctl, "/prepare", input);
    }
    /** 第二阶段：让 launcher 停掉本进程并切换版本（连接被掐断=成功） */
    async applyUpdate() {
        const ctl = await this.readControl();
        try {
            await this.post(ctl, "/apply", {});
        }
        catch (e) {
            // launcher 停止本进程时 HTTP 连接会被直接切断；网络层异常的具体
            // 类型随 Node/undici 版本变化。只有明确的 HTTP 错误仍需失败。
            if (e instanceof Error &&
                e.message.startsWith("launcher /apply 失败: HTTP "))
                throw e;
            return;
        }
    }
}
exports.ClientLauncher = ClientLauncher;
