"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LauncherHttpClient = void 0;
/**
 * 本机 Launcher 控制通道 HTTP 客户端。
 * 详见 docs/design/release-and-update.md。
 *
 * launcher 启动时监听 127.0.0.1 随机端口并写入 control.json：
 *   { port, token, pid }
 * 两阶段自更新协议：
 *   1) POST /prepare —— launcher 下载/校验/解压新版本（服务端此时仍在运行）
 *   2) POST /apply   —— launcher 停掉本进程并切换版本（响应通常无法送达）
 */
const common_1 = require("@nestjs/common");
const node_os_1 = require("node:os");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const DEFAULT_CONTROL_FILE = (0, node_path_1.join)(process.env.VCPDECK_APP_DIR ?? (0, node_path_1.join)((0, node_os_1.homedir)(), ".vcpdeck", "launcher"), "control.json");
let LauncherHttpClient = class LauncherHttpClient {
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
    /**
     * 第二阶段：让 launcher 停掉本进程并切换版本。
     * 2xx 或连接被 launcher 掐断（本进程被停）都视为成功。
     */
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
};
exports.LauncherHttpClient = LauncherHttpClient;
exports.LauncherHttpClient = LauncherHttpClient = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [Object])
], LauncherHttpClient);
