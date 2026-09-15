/** SDK 认证模式；显式 cookie 仅用于不会自动维护 Cookie 的 Node.js 调用方。 */
export type AuthMode = {
    type: "cookie";
    cookie?: string;
} | {
    type: "bearer";
    token: string;
};
/** VCPDeck 客户端配置。 */
export interface VcpDeckClientOptions {
    baseUrl: string;
    auth: AuthMode;
    fetch?: typeof globalThis.fetch;
}
/** 原始请求选项，用于 archive 等非 JSON 请求体。 */
export interface VcpDeckRawRequestOptions {
    body?: BodyInit;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Node.js 流式请求体必须声明为 half。 */
    duplex?: "half";
}
/** 带底层响应元数据的 SDK 返回值。 */
export interface VcpDeckResponse<T> {
    data: T;
    response: Response;
}
/** VCPDeck REST API 归一化错误。 */
export declare class VcpDeckApiError extends Error {
    readonly status: number;
    readonly code?: string | undefined;
    readonly details?: unknown;
    constructor(message: string, status: number, code?: string | undefined, details?: unknown);
}
/** VCPDeck 框架无关 REST 客户端。 */
export declare class VcpDeckClient {
    private readonly options;
    private readonly fetcher;
    private readonly baseUrl;
    readonly jobs: {
        list: (options?: {
            clientId?: string;
            status?: string;
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").JobInfo>>;
        get: (jobId: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").JobInfo>;
        output: (jobId: string, signal?: AbortSignal) => Promise<{
            jobId: string;
            output: string | null;
        }>;
        create: (input: import("@vcpdeck/shared").JobCreate, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").JobCreateResult>;
        cancel: (jobId: string, signal?: AbortSignal) => Promise<{
            jobId: string;
            status: string;
        }>;
        wait(jobId: string, options?: import("./jobs.js").WaitJobOptions): Promise<import("@vcpdeck/shared").JobInfo>;
    };
    readonly files: {
        createUploadSession: (input: import("@vcpdeck/shared").FileUploadSessionCreate, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileUploadSession>;
        completeUpload: (jobId: string, body: {
            uploadedBytes: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").JobCreateResult>;
        createExportSession: (jobId: string, size: number, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileExportSession>;
        completeExportUpload: (jobId: string, uploadedBytes: number, signal?: AbortSignal) => Promise<{
            key: string;
        }>;
        refreshUploadPartUrls: (jobId: string, partNumbers: number[], signal?: AbortSignal) => Promise<{
            partNumber: number;
            url: string;
        }[]>;
        updateUploadProgress: (jobId: string, loaded: number, signal?: AbortSignal) => Promise<void>;
        roots: (clientId: string, signal?: AbortSignal) => Promise<string[]>;
        list: (clientId: string, rootDir: string, path: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileListResult>;
        stat: (clientId: string, rootDir: string, path: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileStatResult>;
        readText: (clientId: string, rootDir: string, path: string, maxBytes?: number, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileReadTextResult>;
        writeText: (clientId: string, payload: {
            rootDir: string;
            path: string;
            content: string;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileChangeResult>;
        mkdir: (clientId: string, payload: {
            rootDir: string;
            path: string;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileChangeResult>;
        delete: (clientId: string, payload: {
            rootDir: string;
            path: string;
            recursive?: boolean;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileChangeResult>;
        move: (clientId: string, payload: {
            rootDir: string;
            source: string;
            destination: string;
            overwrite?: boolean;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileChangeResult>;
        export: (clientId: string, payload: {
            rootDir: string;
            path: string;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FileTransferResult>;
        import: (clientId: string, payload: {
            rootDir: string;
            targetPath: string;
            fileId: string;
            overwrite?: boolean;
        }, signal?: AbortSignal) => Promise<{
            path: string;
            size: number;
            sha256: string;
        }>;
    };
    readonly auth: {
        login: (input: import("@vcpdeck/shared").LoginRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").LoginResponse>;
        loginSession: (input: import("@vcpdeck/shared").LoginRequest, signal?: AbortSignal) => Promise<import("./auth.js").LoginSession>;
        logout: (signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
        me: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").IdentityInfo>;
        updateMe: (input: import("@vcpdeck/shared").UpdateMeRequest, signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
        tokens: {
            list: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TokenInfo[]>;
            create: (input: import("@vcpdeck/shared").CreateTokenRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").CreateTokenResponse>;
            revoke: (id: string, signal?: AbortSignal) => Promise<{
                ok: true;
            }>;
        };
    };
    readonly identities: {
        list: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").IdentityInfo[]>;
        create: (input: import("@vcpdeck/shared").CreateIdentityRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").IdentityInfo>;
        disable: (id: string, signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
        enable: (id: string, signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
    };
    readonly clients: {
        list: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInfo[]>;
        rename: (clientId: string, name: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInfo>;
    };
    readonly clientInstaller: {
        getConfig: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInstallerConfigInfo>;
        updateConfig: (enabled: boolean, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInstallerConfigInfo>;
        preflight: (platform: import("@vcpdeck/shared").ClientInstallerPlatform, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInstallerPreflight>;
        bootstrap: (platform: import("@vcpdeck/shared").ClientInstallerPlatform, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInstallerBootstrap>;
        getClientStatus: (clientId: string, psk: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ClientInstallerClientStatus>;
    };
    readonly storage: {
        getBackendConfig: (signal?: AbortSignal) => Promise<import("./storage.js").StorageBackendStatus>;
        createUploadToken: (input: import("./storage.js").StorageUploadTokenRequest, signal?: AbortSignal) => Promise<import("./storage.js").StorageToken>;
        downloadUrl: (key: string) => string;
        createDownloadToken: (input: {
            key: string;
            ttlSeconds?: number;
        }, signal?: AbortSignal) => Promise<import("./storage.js").StorageToken>;
        delete: (key: string, signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
        setBackend: (input: {
            kind: import("./storage.js").StorageBackendKind;
        }, signal?: AbortSignal) => Promise<import("./storage.js").StorageBackendStatus>;
    };
    readonly storageShares: {
        create: (input: import("@vcpdeck/shared").CreateStorageShareRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").CreateStorageShareResult>;
        list: (options?: {
            fileId?: string;
            status?: import("@vcpdeck/shared").StorageShareStatus;
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").StorageShareInfo>>;
        get: (id: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").StorageShareInfo>;
        revoke: (id: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").StorageShareInfo>;
    };
    readonly aliyundrive: {
        verify: (signal?: AbortSignal) => Promise<import("./aliyundrive.js").AliyunDriveVerification>;
        status: (signal?: AbortSignal) => Promise<import("./aliyundrive.js").AliyunDriveStatus>;
        configure: (input: import("./aliyundrive.js").AliyunDriveConfigInput, signal?: AbortSignal) => Promise<Omit<import("./aliyundrive.js").AliyunDriveConfigInput, "clientSecret">>;
        startOAuth: (signal?: AbortSignal) => Promise<{
            state: string;
            authorizationUrl: string;
            expiresAt: number;
        }>;
        completeOAuth: (input: {
            state: string;
            code: string;
        }, signal?: AbortSignal) => Promise<{
            authorized: true;
            expiresAt: number;
        }>;
        revoke: (signal?: AbortSignal) => Promise<{
            revoked: true;
        }>;
    };
    readonly frp: {
        list: (options?: {
            clientId?: string;
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").FrpMappingInfo>>;
        get: (id: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FrpMappingInfo>;
        create: (input: import("@vcpdeck/shared").FrpMappingCreateRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FrpMappingInfo>;
        createAndWait(input: import("@vcpdeck/shared").FrpMappingCreateRequest, options?: import("./frp.js").WaitFrpOptions): Promise<import("@vcpdeck/shared").FrpMappingInfo>;
        delete: (id: string, optionsOrSignal?: import("./frp.js").WaitFrpOptions | AbortSignal) => Promise<import("@vcpdeck/shared").FrpMappingInfo>;
        deleteAndWait(id: string, options?: import("./frp.js").WaitFrpOptions): Promise<{
            id: string;
            deleted: true;
        }>;
        instances: {
            list: (options?: {
                page?: number;
                pageSize?: number;
            }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").FrpsInstanceInfo>>;
            get: (id: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
            create: (input: import("@vcpdeck/shared").FrpsInstanceCreateRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
            update: (id: string, input: import("@vcpdeck/shared").FrpsInstanceUpdateRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
            delete: (id: string, signal?: AbortSignal) => Promise<{
                id: string;
                deleted: true;
            }>;
            probe: (id: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ProbeResult>;
            setDefault: (id: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
        };
    };
    readonly pi: import("./pi.js").PiApi;
    readonly releases: {
        list: (options?: {
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").ReleaseInfo>>;
        createUploadSession: (input: import("@vcpdeck/shared").ReleaseUploadCreateInput, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ReleaseUploadSession>;
        refreshUploadParts: (sessionId: string, partNumbers: number[], signal?: AbortSignal) => Promise<{
            parts: import("@vcpdeck/shared").ReleaseUploadPart[];
        }>;
        completeUploadSession: (sessionId: string, uploadedBytes: number, signal?: AbortSignal) => Promise<{
            release: import("@vcpdeck/shared").ReleaseInfo;
        }>;
        upload: (input: import("./releases.js").ReleaseUploadInput, signal?: AbortSignal) => Promise<{
            release: import("@vcpdeck/shared").ReleaseInfo;
        }>;
        cleanupPreview: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ReleaseCleanupPreview>;
        cleanupRun: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").ReleaseCleanupRunResult>;
        status: (signal?: AbortSignal) => Promise<import("./releases.js").ServerStatus>;
    };
    readonly terminals: {
        shells: (clientId: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TerminalShellInfo[]>;
        list: (clientId: string, options?: {
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").TerminalSessionInfo>>;
        create: (clientId: string, body: import("@vcpdeck/shared").TerminalSessionCreateRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TerminalSessionInfo>;
        get: (clientId: string, sessionId: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TerminalSessionInfo>;
        remove: (clientId: string, sessionId: string, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TerminalSessionInfo>;
        audit: (clientId: string, sessionId: string, options?: {
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").TerminalAuditInfo>>;
    };
    readonly tunnels: {
        config: {
            get: (signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TunnelConfigInfo>;
            update: (body: import("@vcpdeck/shared").TunnelConfigUpdate, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TunnelConfigInfo>;
        };
        create: (body: import("@vcpdeck/shared").TunnelSessionCreateRequest, signal?: AbortSignal) => Promise<import("@vcpdeck/shared").TunnelSessionCreated>;
        remove: (sessionId: string, signal?: AbortSignal) => Promise<{
            closed: true;
        }>;
    };
    readonly health: {
        get: (signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
    };
    constructor(options: VcpDeckClientOptions);
    /** 发起 JSON REST 请求并归一化失败响应。 */
    request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
    /** 发起原始 body 请求，同时返回响应头供 Node.js 会话等协议使用。 */
    requestRaw<T>(method: string, path: string, options?: VcpDeckRawRequestOptions): Promise<VcpDeckResponse<T>>;
}
