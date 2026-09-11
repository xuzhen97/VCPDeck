"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionStore = void 0;
/**
 * 版本目录管理与原子切换（详见 docs/design/release-and-update.md）。
 * - Linux：apps/current 为符号链接，切换用「临时链接 + rename」原子完成
 * - Windows：不用 symlink（权限问题），apps/state.json 指针文件，写入用 tmp+rename
 * fs 操作可注入（测试在非 Linux 机器上模拟 symlink 语义）。
 */
const fs = __importStar(require("node:fs"));
const fsp = __importStar(require("node:fs/promises"));
const node_path_1 = require("node:path");
const realFs = {
    readFile: (p, e) => fsp.readFile(p, e),
    writeFile: (p, d) => fsp.writeFile(p, d, "utf-8"),
    readdir: (p) => fsp.readdir(p),
    readlink: (p) => fsp.readlink(p),
    symlinkSync: (t, p) => fs.symlinkSync(t, p, "dir"),
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    existsSync: fs.existsSync,
    rm: (p) => fsp.rm(p, { recursive: true, force: true }),
};
class VersionStore {
    appsDir;
    isWindows;
    stateFile;
    fs;
    constructor(options) {
        this.appsDir = options.appsDir;
        this.isWindows = (options.platform ?? process.platform) === "win32";
        this.stateFile = (0, node_path_1.join)(this.appsDir, "state.json");
        this.fs = options.fs ?? realFs;
    }
    /** 当前生效版本；未切换过返回 null */
    async currentVersion() {
        if (this.isWindows) {
            try {
                const state = JSON.parse(await this.fs.readFile(this.stateFile, "utf-8"));
                return state.current ?? null;
            }
            catch {
                return null;
            }
        }
        try {
            const target = await this.fs.readlink((0, node_path_1.join)(this.appsDir, "current"));
            const base = target.split(/[\\/]/).pop() ?? "";
            return /^\d+\.\d+\.\d+$/.test(base) ? base : null;
        }
        catch {
            return null;
        }
    }
    /** 切换 current 到指定版本（原子） */
    async switchTo(version) {
        if (this.isWindows) {
            await this.writeStateFileAtomic({ current: version });
            return;
        }
        const linkPath = (0, node_path_1.join)(this.appsDir, "current");
        const tmpLink = (0, node_path_1.join)(this.appsDir, `.current.tmp-${version}`);
        this.fs.symlinkSync((0, node_path_1.join)(this.appsDir, version), tmpLink);
        try {
            this.fs.renameSync(tmpLink, linkPath);
        }
        catch {
            this.fs.unlinkSync(tmpLink);
            throw new Error(`切换版本失败: ${version}`);
        }
    }
    /** 全部已解压版本目录（x.y.z 命名） */
    async listVersions() {
        const entries = await this.fs.readdir(this.appsDir);
        return entries.filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort();
    }
    /** 版本目录路径（解压目标） */
    versionDir(version) {
        return (0, node_path_1.join)(this.appsDir, version);
    }
    /** 判断指定构件的版本目录是否完整可启动 */
    async isPrepared(version, artifact) {
        const dir = this.versionDir(version);
        try {
            const manifest = JSON.parse(await this.fs.readFile((0, node_path_1.join)(dir, "manifest.json"), "utf-8"));
            const artifactInfo = manifest.artifacts?.[artifact];
            const expectedDir = artifact;
            const expectedEntry = artifact === "server" ? "dist/main.js" : "dist/index.js";
            if (manifest.version !== version ||
                artifactInfo?.dir !== expectedDir ||
                artifactInfo.entry !== expectedEntry) {
                return false;
            }
            const entry = (0, node_path_1.join)(dir, artifactInfo.dir, artifactInfo.entry);
            return this.fs.existsSync(entry);
        }
        catch {
            return false;
        }
    }
    /** 删除不完整版本目录 */
    async removeVersion(version) {
        await this.fs.rm(this.versionDir(version));
    }
    /** 版本目录存在性（解压结果校验用） */
    exists(version) {
        return this.fs.existsSync((0, node_path_1.join)(this.appsDir, version));
    }
    async writeStateFileAtomic(state) {
        const tmpFile = `${this.stateFile}.tmp`;
        await this.fs.writeFile(tmpFile, JSON.stringify(state));
        this.fs.renameSync(tmpFile, this.stateFile);
    }
}
exports.VersionStore = VersionStore;
