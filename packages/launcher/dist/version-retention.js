"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionRetention = void 0;
/** Launcher 本地版本保留与清理。
 *
 * retention.json 只记录 Launcher 已确认健康切换成功的版本。文件缺失时只建立
 * current 基线，不删除未知旧目录；文件损坏时停用自动清理，等待人工修复。
 */
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const realFs = {
    readFile: (path, encoding) => (0, promises_1.readFile)(path, encoding),
    writeFile: (path, data, encoding) => (0, promises_1.writeFile)(path, data, encoding),
    rename: (oldPath, newPath) => (0, promises_1.rename)(oldPath, newPath),
    rm: (path) => (0, promises_1.rm)(path, { force: true }),
};
function isValidVersion(version) {
    return typeof version === "string" && VERSION_RE.test(version);
}
function parseState(raw) {
    try {
        const value = JSON.parse(raw);
        if (typeof value !== "object" ||
            value === null ||
            !Array.isArray(value.successfulVersions)) {
            return null;
        }
        const successfulVersions = value
            .successfulVersions;
        if (successfulVersions.length === 0 ||
            !successfulVersions.every(isValidVersion) ||
            new Set(successfulVersions).size !== successfulVersions.length) {
            return null;
        }
        return { successfulVersions: [...successfulVersions] };
    }
    catch {
        return null;
    }
}
class VersionRetention {
    options;
    stateFile;
    tempStateFile;
    state = null;
    initialized = false;
    disabled = false;
    fs;
    constructor(options) {
        this.options = options;
        this.stateFile = (0, node_path_1.join)(options.appsDir, "retention.json");
        this.tempStateFile = `${this.stateFile}.tmp`;
        this.fs = options.fs ?? realFs;
    }
    /** 读取或建立保留状态；状态不可信时停用自动清理。 */
    async initialize() {
        if (this.initialized)
            return;
        this.initialized = true;
        let raw;
        try {
            raw = await this.fs.readFile(this.stateFile, "utf-8");
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                this.disabled = true;
                return;
            }
            await this.initializeMissingState();
            return;
        }
        const parsed = parseState(raw);
        if (!parsed) {
            this.disabled = true;
            return;
        }
        this.state = parsed;
        const current = await this.options.versions.currentVersion();
        if (!isValidVersion(current) || !this.state.successfulVersions.includes(current)) {
            this.state = null;
            this.disabled = true;
        }
    }
    /** 记录一次已通过探活的成功切换，并将其置于历史首位。 */
    async recordSuccessful(version) {
        await this.initialize();
        if (this.disabled || !isValidVersion(version) || !this.state)
            return false;
        const nextState = {
            successfulVersions: [
                version,
                ...this.state.successfulVersions.filter((item) => item !== version),
            ],
        };
        try {
            await this.writeState(nextState);
            this.state = nextState;
            return true;
        }
        catch {
            // 新成功历史无法持久化时，旧历史已不足以证明当前保护集合，
            // 立即停用删除，避免在不可信状态下回收版本目录。
            this.disabled = true;
            return false;
        }
    }
    /** 清理不在 current、最近两个成功历史或调用方保护集合中的版本目录。 */
    async cleanup(protectedVersions = new Set()) {
        await this.initialize();
        if (this.disabled || !this.state) {
            return { removed: [], failed: [], disabled: true };
        }
        const current = await this.options.versions.currentVersion();
        if (!isValidVersion(current)) {
            return { removed: [], failed: [], disabled: true };
        }
        const successful = this.state.successfulVersions;
        if (!successful.includes(current)) {
            return { removed: [], failed: [], disabled: true };
        }
        if (successful.length - 1 < 2) {
            return { removed: [], failed: [], disabled: false };
        }
        const keep = new Set([
            current,
            ...successful.filter((version) => version !== current).slice(0, 2),
        ]);
        for (const version of protectedVersions) {
            if (isValidVersion(version))
                keep.add(version);
        }
        const candidates = (await this.options.versions.listVersions()).filter((version) => isValidVersion(version) && !keep.has(version));
        const removed = [];
        const failed = [];
        for (const version of candidates) {
            try {
                await this.options.versions.removeVersion(version);
                removed.push(version);
            }
            catch {
                failed.push(version);
            }
        }
        return { removed, failed, disabled: false };
    }
    async initializeMissingState() {
        const current = await this.options.versions.currentVersion();
        if (!isValidVersion(current)) {
            this.disabled = true;
            return;
        }
        const nextState = { successfulVersions: [current] };
        try {
            await this.writeState(nextState);
            this.state = nextState;
        }
        catch {
            this.disabled = true;
        }
    }
    async writeState(state) {
        try {
            await this.fs.writeFile(this.tempStateFile, JSON.stringify(state), "utf-8");
            await this.fs.rename(this.tempStateFile, this.stateFile);
        }
        catch (error) {
            await this.fs.rm(this.tempStateFile).catch(() => undefined);
            throw error;
        }
    }
}
exports.VersionRetention = VersionRetention;
