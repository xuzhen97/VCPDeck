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
exports.ReleaseService = exports.ReleaseError = void 0;
exports.toPublicReleaseInfo = toPublicReleaseInfo;
exports.toReleaseInfo = toReleaseInfo;
/**
 * Release 领域服务：上传记录、状态流转、客户端状态维护、sha256 校验。
 * 详见 docs/design/release-and-update.md。
 */
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const shared_1 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
/** release 领域错误：code 稳定，message 安全（不含文件内容/密钥） */
class ReleaseError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ReleaseError";
    }
}
exports.ReleaseError = ReleaseError;
/** Release 状态机允许的流转。 */
const ALLOWED_TRANSITIONS = {
    [shared_1.ReleaseStatus.UPLOADED]: [shared_1.ReleaseStatus.UPDATING_SERVER, shared_1.ReleaseStatus.FAILED],
    [shared_1.ReleaseStatus.UPDATING_SERVER]: [
        shared_1.ReleaseStatus.UPDATING_CLIENTS,
        shared_1.ReleaseStatus.FAILED,
    ],
    [shared_1.ReleaseStatus.UPDATING_CLIENTS]: [shared_1.ReleaseStatus.DONE, shared_1.ReleaseStatus.FAILED],
    [shared_1.ReleaseStatus.DONE]: [],
    [shared_1.ReleaseStatus.FAILED]: [],
};
/** 单条客户端状态：兼容旧格式（裸枚举字符串）与新格式（{ state, reason?, at }） */
function normalizeEntry(value, fallbackAt) {
    if (typeof value === "string") {
        // 旧格式：裸状态枚举值（历史数据兼容）
        return { state: value, at: fallbackAt };
    }
    if (typeof value === "object" && value !== null) {
        const entry = value;
        if (typeof entry.state === "string") {
            return {
                state: entry.state,
                ...(typeof entry.reason === "string" && entry.reason
                    ? { reason: entry.reason }
                    : {}),
                at: typeof entry.at === "string" ? entry.at : fallbackAt,
            };
        }
    }
    return null;
}
function parseStorage(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const storage = value;
    if (typeof storage.provider !== "string" ||
        !storage.provider ||
        typeof storage.key !== "string" ||
        !storage.key ||
        storage.mode !== "direct") {
        return undefined;
    }
    return {
        provider: storage.provider,
        key: storage.key,
        mode: "direct",
    };
}
function parseArchive(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const entry = value;
    if (typeof entry.sha256 !== "string" ||
        typeof entry.fileName !== "string" ||
        typeof entry.size !== "number") {
        return null;
    }
    const base = {
        sha256: entry.sha256,
        size: entry.size,
        fileName: entry.fileName,
    };
    if (entry.availability === "cleaned") {
        if (typeof entry.cleanedAt !== "string" ||
            Number.isNaN(Date.parse(entry.cleanedAt)) ||
            entry.cleanupReason !== "retention_policy") {
            return null;
        }
        const summary = entry.storageSummary;
        let storageSummary;
        if (summary !== undefined) {
            if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
                return null;
            }
            const parsedSummary = summary;
            if (typeof parsedSummary.provider !== "string" ||
                !parsedSummary.provider ||
                parsedSummary.mode !== "direct") {
                return null;
            }
            storageSummary = {
                provider: parsedSummary.provider,
                mode: "direct",
            };
        }
        return {
            ...base,
            availability: "cleaned",
            ...(storageSummary ? { storageSummary } : {}),
            cleanedAt: entry.cleanedAt,
            cleanupReason: "retention_policy",
        };
    }
    if (entry.availability !== undefined &&
        entry.availability !== "available" &&
        entry.availability !== "deleting") {
        return null;
    }
    const storage = entry.storage === undefined ? undefined : parseStorage(entry.storage);
    if (entry.storage !== undefined && !storage)
        return null;
    return {
        ...base,
        availability: entry.availability ?? "available",
        ...(storage ? { storage } : {}),
    };
}
function parseArchives(raw) {
    const archives = {};
    try {
        const parsed = JSON.parse(raw);
        for (const [platform, value] of Object.entries(parsed)) {
            if (platform !== "win-x64" && platform !== "linux-x64")
                continue;
            const archive = parseArchive(value);
            if (archive)
                archives[platform] = archive;
        }
    }
    catch {
        return {};
    }
    return archives;
}
/** 去除 Server 内部 Provider key，生成可安全返回 API 的 archive。 */
function toPublicArchive(archive) {
    if (archive.storage) {
        const { key: _key, ...storage } = archive.storage;
        return { ...archive, storage };
    }
    return archive;
}
/** 将 Server 内部 Release 投影为不含 Provider key 的公开对象。 */
function toPublicReleaseInfo(info) {
    return {
        ...info,
        archives: Object.fromEntries(Object.entries(info.archives).map(([platform, archive]) => [
            platform,
            toPublicArchive(archive),
        ])),
    };
}
/** DB 行 → API 形态（archives/clientStates 解析为对象，日期转 ISO 字符串）。 */
function toReleaseInfo(row) {
    const fallbackAt = row.updatedAt.toISOString();
    let clientStates = {};
    try {
        const parsed = JSON.parse(row.clientStates);
        for (const [clientId, value] of Object.entries(parsed)) {
            const entry = normalizeEntry(value, fallbackAt);
            if (entry)
                clientStates[clientId] = entry;
        }
    }
    catch {
        clientStates = {};
    }
    const archives = parseArchives(row.archives);
    return toPublicReleaseInfo({
        version: row.version,
        archives,
        status: row.status,
        errorMessage: row.errorMessage,
        createdByName: row.createdByName,
        createdVia: row.createdVia,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        clientStates,
    });
}
let ReleaseService = class ReleaseService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    /** 上传后登记 release（版本重复抛 RELEASE_DUPLICATE_VERSION） */
    async create(input) {
        const existing = await this.prisma.release.findUnique({
            where: { version: input.version },
        });
        if (existing) {
            throw new ReleaseError("RELEASE_DUPLICATE_VERSION", `版本 ${input.version} 已存在`);
        }
        const row = await this.prisma.release.create({
            data: {
                id: (0, node_crypto_1.randomUUID)(),
                version: input.version,
                archives: JSON.stringify(Object.fromEntries(Object.entries(input.archives).map(([platform, archive]) => [
                    platform,
                    { ...archive, availability: archive.availability ?? "available" },
                ]))),
                status: "uploaded",
                clientStates: "{}",
                createdByName: input.createdByName ?? null,
                createdVia: input.createdVia ?? null,
            },
        });
        return toReleaseInfo(row);
    }
    /**
     * 补充单个平台的构件（第二次上传）。已存在同平台构件或 release 不存在时抛错。
     * 返回更新后的 release。
     */
    async addArchive(version, platform, archive) {
        const row = await this.prisma.release.findUnique({ where: { version } });
        if (!row) {
            throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
        }
        const archives = parseArchives(row.archives);
        if (archives[platform]) {
            throw new ReleaseError("RELEASE_ARCHIVE_EXISTS", `release ${version} 已存在 ${platform} 构件`);
        }
        const updatedArchives = {
            ...archives,
            [platform]: { ...archive, availability: archive.availability ?? "available" },
        };
        const updated = await this.prisma.release.update({
            where: { version },
            data: { archives: JSON.stringify(updatedArchives) },
        });
        return toReleaseInfo(updated);
    }
    /** release 是否已包含全部支持平台的构件（补齐后才允许触发更新） */
    hasAllArchives(release) {
        return ((0, shared_1.isReleaseArchiveAvailable)(release.archives["win-x64"]) &&
            (0, shared_1.isReleaseArchiveAvailable)(release.archives["linux-x64"]));
    }
    /** 分页列表（遵循 AGENTS.md 分页规范） */
    async list(page = 1, pageSize = 20) {
        const [rows, total] = await Promise.all([
            this.prisma.release.findMany({
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.release.count(),
        ]);
        return {
            data: rows.map(toReleaseInfo),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    async findByVersion(version) {
        const row = await this.prisma.release.findUnique({ where: { version } });
        return row ? toReleaseInfo(row) : null;
    }
    /** Server 内部读取 Release；仅供下载/清理/直传登记使用，不可直接返回 API。 */
    async findByVersionWithStorage(version) {
        const row = await this.prisma.release.findUnique({ where: { version } });
        if (!row)
            return null;
        const publicInfo = toReleaseInfo(row);
        return {
            ...publicInfo,
            archives: parseArchives(row.archives),
        };
    }
    /** 返回清理策略使用的全部公开 Release；具体删除时再通过 CAS 读取内部 key。 */
    async listForCleanup() {
        const rows = await this.prisma.release.findMany({
            orderBy: { createdAt: "desc" },
        });
        return rows.map(toReleaseInfo);
    }
    /** 以 archive JSON 做条件更新，声明一个 archive 进入 deleting。 */
    async claimArchiveForCleanup(version, platform) {
        const row = await this.prisma.release.findUnique({ where: { version } });
        if (!row)
            return null;
        const archives = parseArchives(row.archives);
        const archive = archives[platform];
        if (!archive ||
            archive.availability === "deleting" ||
            archive.availability === "cleaned") {
            return null;
        }
        const deleting = {
            sha256: archive.sha256,
            size: archive.size,
            fileName: archive.fileName,
            availability: "deleting",
            ...(archive.storage ? { storage: archive.storage } : {}),
        };
        const updatedArchives = { ...archives, [platform]: deleting };
        const result = await this.prisma.release.updateMany({
            where: { version, archives: row.archives },
            data: { archives: JSON.stringify(updatedArchives) },
        });
        return result.count === 1 ? deleting : null;
    }
    /** 以 archive JSON 做条件更新，完成正文删除并保留审计摘要。 */
    async finishArchiveCleanup(version, platform, cleanedAt) {
        if (Number.isNaN(Date.parse(cleanedAt)))
            return false;
        const row = await this.prisma.release.findUnique({ where: { version } });
        if (!row)
            return false;
        const archives = parseArchives(row.archives);
        const archive = archives[platform];
        if (!archive || archive.availability !== "deleting")
            return false;
        const cleaned = {
            sha256: archive.sha256,
            size: archive.size,
            fileName: archive.fileName,
            availability: "cleaned",
            ...(archive.storage
                ? {
                    storageSummary: {
                        provider: archive.storage.provider,
                        mode: archive.storage.mode,
                    },
                }
                : {}),
            cleanedAt,
            cleanupReason: "retention_policy",
        };
        const result = await this.prisma.release.updateMany({
            where: { version, archives: row.archives },
            data: { archives: JSON.stringify({ ...archives, [platform]: cleaned }) },
        });
        return result.count === 1;
    }
    /** 清理失败时将当前 archive 恢复为可重试的 available。 */
    async restoreArchiveAfterCleanup(version, platform) {
        const row = await this.prisma.release.findUnique({ where: { version } });
        if (!row)
            return false;
        const archives = parseArchives(row.archives);
        const archive = archives[platform];
        if (!archive || archive.availability !== "deleting")
            return false;
        const available = { ...archive, availability: "available" };
        const result = await this.prisma.release.updateMany({
            where: { version, archives: row.archives },
            data: { archives: JSON.stringify({ ...archives, [platform]: available }) },
        });
        return result.count === 1;
    }
    /**
     * 状态流转（原子）：先校验当前状态允许流转，再按 version+status 条件更新，
     * 条件更新条数为 0 视为并发修改/非法流转。
     */
    async transitionStatus(version, to, errorMessage) {
        const current = await this.prisma.release.findUnique({
            where: { version },
        });
        if (!current) {
            throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
        }
        const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
        if (!allowed.includes(to)) {
            throw new ReleaseError("RELEASE_INVALID_TRANSITION", `不允许从 ${current.status} 流转到 ${to}`);
        }
        const result = await this.prisma.release.updateMany({
            where: { version, status: current.status },
            data: { status: to, errorMessage: errorMessage ?? null },
        });
        if (result.count === 0) {
            throw new ReleaseError("RELEASE_INVALID_TRANSITION", `状态已被并发修改，无法流转到 ${to}`);
        }
    }
    /**
     * 记录单个客户端在 release 中的更新状态（含失败原因与时间戳，审计用）。
     * 返回合并后的完整状态表。
     */
    async markClientState(version, clientId, state, reason) {
        const row = await this.prisma.release.findUnique({ where: { version } });
        if (!row) {
            throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
        }
        const fallbackAt = row.updatedAt.toISOString();
        let states = {};
        try {
            const parsed = JSON.parse(row.clientStates);
            for (const [id, value] of Object.entries(parsed)) {
                const entry = normalizeEntry(value, fallbackAt);
                if (entry)
                    states[id] = entry;
            }
        }
        catch {
            states = {};
        }
        states[clientId] = {
            state,
            ...(reason ? { reason } : {}),
            at: new Date().toISOString(),
        };
        await this.prisma.release.update({
            where: { version },
            data: { clientStates: JSON.stringify(states) },
        });
        return states;
    }
    /** 置为 failed（附安全错误摘要） */
    async markFailed(version, errorMessage) {
        await this.transitionStatus(version, shared_1.ReleaseStatus.FAILED, errorMessage);
    }
    /** 当前活动目标版本：最近一条具有双平台可用构件的 updating_clients/done release。 */
    async getLatestActiveTarget() {
        const rows = await this.prisma.release.findMany({
            where: {
                status: { in: [shared_1.ReleaseStatus.UPDATING_CLIENTS, shared_1.ReleaseStatus.DONE] },
            },
            orderBy: { createdAt: "desc" },
        });
        for (const row of rows) {
            const release = toReleaseInfo(row);
            if (this.hasAllArchives(release))
                return release;
        }
        return null;
    }
    /** 进行中的 release：updating_server / updating_clients（编排器忙检查与启动恢复用） */
    async getActiveRelease() {
        const row = await this.prisma.release.findFirst({
            where: {
                status: {
                    in: [shared_1.ReleaseStatus.UPDATING_SERVER, shared_1.ReleaseStatus.UPDATING_CLIENTS],
                },
            },
            orderBy: { createdAt: "desc" },
        });
        return row ? toReleaseInfo(row) : null;
    }
    /** 流式计算文件 sha256 并与期望值比对（文件不存在/读失败返回 false） */
    async verifyZipSha256(filePath, expected) {
        return new Promise((resolve) => {
            const hash = (0, node_crypto_1.createHash)("sha256");
            const stream = (0, node_fs_1.createReadStream)(filePath);
            stream.on("error", () => resolve(false));
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex") === expected));
        });
    }
};
exports.ReleaseService = ReleaseService;
exports.ReleaseService = ReleaseService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], ReleaseService);
