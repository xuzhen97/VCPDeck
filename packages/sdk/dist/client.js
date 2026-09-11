import { createAliyunDriveApi } from "./aliyundrive.js";
import { createAuthApi, createIdentitiesApi } from "./auth.js";
import { createClientsApi } from "./clients.js";
import { createClientInstallerApi } from "./client-installer.js";
import { createFilesApi } from "./files.js";
import { createFrpApi } from "./frp.js";
import { createJobsApi } from "./jobs.js";
import { createPiApi } from "./pi.js";
import { createReleasesApi } from "./releases.js";
import { createStorageApi } from "./storage.js";
import { createStorageSharesApi } from "./storage-shares.js";
import { createTerminalsApi } from "./terminal.js";
/** VCPDeck REST API 归一化错误。 */
export class VcpDeckApiError extends Error {
    status;
    code;
    details;
    constructor(message, status, code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = "VcpDeckApiError";
    }
}
/** VCPDeck 框架无关 REST 客户端。 */
export class VcpDeckClient {
    options;
    fetcher;
    baseUrl;
    jobs;
    files;
    auth;
    identities;
    clients;
    clientInstaller;
    storage;
    storageShares;
    aliyundrive;
    frp;
    pi;
    releases;
    terminals;
    health = {
        get: (signal) => this.request("GET", "/api/health", undefined, signal),
    };
    constructor(options) {
        this.options = options;
        this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.jobs = createJobsApi(this);
        this.files = createFilesApi(this, this.jobs);
        this.auth = createAuthApi(this);
        this.identities = createIdentitiesApi(this);
        this.clients = createClientsApi(this);
        this.clientInstaller = createClientInstallerApi(this);
        this.storage = createStorageApi(this);
        this.storageShares = createStorageSharesApi(this);
        this.aliyundrive = createAliyunDriveApi(this);
        this.frp = createFrpApi(this, this.jobs);
        this.pi = createPiApi(this);
        this.releases = createReleasesApi(this);
        this.terminals = createTerminalsApi(this);
    }
    /** 发起 JSON REST 请求并归一化失败响应。 */
    async request(method, path, body, signal) {
        const result = await this.requestRaw(method, path, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: body === undefined ? undefined : { "Content-Type": "application/json" },
            signal,
        });
        return result.data;
    }
    /** 发起原始 body 请求，同时返回响应头供 Node.js 会话等协议使用。 */
    async requestRaw(method, path, options = {}) {
        const headers = { ...options.headers };
        if (this.options.auth.type === "bearer") {
            headers.Authorization = `Bearer ${this.options.auth.token}`;
        }
        else if (this.options.auth.cookie) {
            headers.Cookie = this.options.auth.cookie;
        }
        let response;
        try {
            response = await this.fetcher(`${this.baseUrl}${path}`, {
                method,
                signal: options.signal,
                credentials: this.options.auth.type === "cookie" ? "include" : undefined,
                headers,
                body: options.body,
                ...(options.duplex ? { duplex: options.duplex } : {}),
            });
        }
        catch (error) {
            if (options.signal?.aborted)
                throw error;
            throw new VcpDeckApiError("Network request failed", 0);
        }
        const text = await response.text();
        const parsed = text ? parseJson(text) : undefined;
        if (!response.ok) {
            const details = isRecord(parsed) ? parsed : undefined;
            const code = typeof details?.code === "string" ? details.code : undefined;
            const message = typeof details?.message === "string"
                ? details.message
                : response.statusText || `HTTP ${response.status}`;
            throw new VcpDeckApiError(message, response.status, code, parsed);
        }
        return { data: parsed, response };
    }
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
