# Storage 存储系统 — 代码设计模型

> 日期：2025-07-25
>
> 本文档描述 VCPDeck storage 模块的内部设计，用 Mermaid 图表展示架构、交互和扩展机制。

## 1. 系统上下文

Storage 模块在 VCPDeck 整体架构中的位置：Server 内部的独立模块，通过 HTTP 端点对外提供服务，内部通过 Provider 接口委托给具体存储后端。

```mermaid
graph TB
    subgraph client["Client (远程机器)"]
        ws_client["WebSocket 信令"]
        http_client["HTTP 文件传输"]
    end

    subgraph server["VCPDeck Server"]
        job["Job 调度"]
        auth["认证模块"]
        subgraph storage["Storage 模块"]
            controller["StorageController<br/>HTTP 端点"]
            service["StorageService<br/>配置读取 & 委托"]
            provider["StorageProvider<br/>接口抽象"]
            local["LocalStorageProvider<br/>本地磁盘"]
        end
    end

    subgraph external["外部后端（未来）"]
        alibaba["阿里云盘"]
        s3["S3"]
    end

    ws_client <-->|"信令: job:dispatch / job:done"| job
    job -->|"签发上传/下载令牌"| service
    http_client -->|"PUT / GET 文件"| controller
    controller --> service
    service --> provider
    provider --> local
    provider -.->|"未来扩展"| alibaba
    provider -.->|"未来扩展"| s3
    auth --> controller
```

## 2. 模块结构

```
packages/server/src/storage/
├── storage.module.ts              ← NestJS 模块入口
├── storage.service.ts             ← 核心服务（读 DB 配置、委托 provider）
├── storage.controller.ts          ← HTTP 端点
└── providers/
    ├── storage-provider.interface.ts  ← 接口定义
    ├── local-storage.provider.ts      ← 本地磁盘实现
    └── providers.registry.ts          ← kind → Provider 注册表
```

## 3. 类关系图

```mermaid
classDiagram
    class StorageProvider {
        <<interface>>
        upload(stream, meta) FileEntry
        uploadToKey(stream, meta, key) FileEntry
        download(key) {stream, meta}
        delete(key) void
        signUploadUrl(key, ttl) string
        signDownloadUrl(key, ttl) string
        verifyUploadSignature(key, exp, sig) boolean
        verifyDownloadSignature(key, exp, sig) boolean
    }

    class FileMeta {
        +string jobId
        +string clientId
        +string filename
        +string? mimeType
        +number size
    }

    class FileEntry {
        +string key
        +string storageKind
        +Date createdAt
    }

    class LocalStorageProvider {
        -string baseDir
        -string signSecret
        +upload(stream, meta) FileEntry
        +uploadToKey(stream, meta, key) FileEntry
        +download(key) {stream, meta}
        +delete(key) void
        +signUploadUrl(key, ttl) string
        +signDownloadUrl(key, ttl) string
        +verifyUploadSignature() boolean
        +verifyDownloadSignature() boolean
        -makeKey(meta) string
        -sign(payload) string
    }

    class StorageService {
        -Logger logger
        -StorageProvider provider
        -Map~string,PendingUpload~ pendingUploads
        +onModuleInit() void
        +loadProvider() void
        +reload() void
        +createUploadToken(meta, ttl) {url, expiresAt}
        +createDownloadToken(key, ttl) {url, expiresAt}
        +receiveUpload(key, stream, exp, sig) FileEntry
        +downloadVerified(key, exp, sig) {stream, meta}
        +delete(key) void
    }

    class StorageController {
        -StorageService storageService
        +POST upload-token
        +POST download-token
        +PUT upload/:key(*)
        +GET download/:key(*)
        +DELETE :key(*)
    }

    class StorageBackendConfig {
        +int id
        +string kind
        +string config
        +DateTime updatedAt
    }

    FileMeta <|-- FileEntry : extends
    StorageProvider <|.. LocalStorageProvider : implements
    StorageService --> StorageProvider : delegates to
    StorageService --> StorageBackendConfig : reads
    StorageController --> StorageService : calls
    LocalStorageProvider ..> FileMeta : creates
    LocalStorageProvider ..> FileEntry : returns
```

## 4. 上传完整流程

```mermaid
sequenceDiagram
    actor Client as Client (远程)
    participant Controller as StorageController
    participant Service as StorageService
    participant Provider as StorageProvider
    participant Disk as 磁盘

    Note over Client,Service: ① 签发上传令牌
    Client->>Controller: POST /api/storage/upload-token<br/>{jobId, clientId, filename, size}
    Controller->>Service: createUploadToken(meta, ttl)
    Service->>Provider: signUploadUrl(key, ttl)
    Provider-->>Service: queryString (expires=&sig=)
    Service->>Service: pendingUploads.set(key, meta)
    Service-->>Controller: {url, expiresAt}
    Controller-->>Client: 200 {url, expiresAt}

    Note over Client,Disk: ② HTTP 上传文件
    Client->>Controller: PUT /api/storage/upload/:key?expires=&sig=<br/>Raw binary body
    Controller->>Service: receiveUpload(key, req, exp, sig)
    Service->>Provider: verifyUploadSignature(key, exp, sig)
    Provider-->>Service: true
    Service->>Service: pendingUploads.get(key) → meta
    Service->>Provider: uploadToKey(stream, meta, key)
    Provider->>Disk: mkdir + pipeline → createWriteStream(filePath)
    Disk-->>Provider: done
    Provider-->>Service: FileEntry {key, size, ...}
    Service->>Service: pendingUploads.delete(key)
    Service-->>Controller: FileEntry
    Controller-->>Client: 200 {key, size}

    Note over Client,Service: ③ 确认 Job 完成
    Client->>Service: WS: job:done (含 file key)
    Service->>Service: 标记 Job 状态 → done
```

## 5. 下载完整流程

```mermaid
sequenceDiagram
    actor Client as Client (远程)
    participant Server as Server (Job 调度)
    participant Controller as StorageController
    participant Service as StorageService
    participant Provider as StorageProvider
    participant Disk as 磁盘

    Note over Server,Service: ① Server 签发下载令牌
    Server->>Controller: POST /api/storage/download-token<br/>{key, ttlSeconds?}
    Controller->>Service: createDownloadToken(key, ttl)
    Service->>Provider: signDownloadUrl(key, ttl)
    Provider-->>Service: queryString (expires=&sig=)
    Service-->>Server: {url, expiresAt}

    Note over Server,Client: ② 通过 WebSocket 下发下载 URL
    Server->>Client: WS: job:dispatch<br/>{type:"file.download", payload:{downloadUrl}}

    Note over Client,Disk: ③ HTTP 下载文件
    Client->>Controller: GET /api/storage/download/:key?expires=&sig=
    Controller->>Service: downloadVerified(key, exp, sig)
    Service->>Provider: verifyDownloadSignature(key, exp, sig)
    Provider-->>Service: true
    Service->>Provider: download(key)
    Provider->>Disk: createReadStream(filePath)
    Disk-->>Provider: stream
    Provider-->>Service: {stream, meta}
    Service-->>Controller: {stream, meta}
    Controller->>Client: 200 stream<br/>Content-Disposition: attachment
    Client-->>Client: 文件保存完成
```

## 6. 后端扩展机制

新增存储后端只需两步：实现接口 + 注册。

```mermaid
graph TB
    subgraph step1["Step ① 实现接口"]
        iface["StorageProvider<br/>接口定义"]
        new_impl["AlibabaStorageProvider<br/>implements StorageProvider"]
        methods["实现 8 个方法:<br/>upload / uploadToKey<br/>download / delete<br/>signUploadUrl / signDownloadUrl<br/>verifyUpload / verifyDownload"]
    end

    subgraph step2["Step ② 注册"]
        registry["providers.registry.ts<br/>STORAGE_PROVIDERS 映射表"]
        add_line["添加一行:<br/>alibaba: AlibabaStorageProvider"]
    end

    subgraph step3["Step ③ 切换"]
        db["DB: StorageBackendConfig"]
        update_db["UPDATE kind='alibaba'<br/>config='{...阿里云配置...}'"]
        reload["StorageService.reload()<br/>或重启 Server"]
    end

    iface --> new_impl
    new_impl --> methods
    methods --> registry
    registry --> add_line
    add_line --> db
    db --> update_db
    update_db --> reload

    style step1 fill:#e1f5fe,stroke:#0277bd
    style step2 fill:#fff3e0,stroke:#e65100
    style step3 fill:#e8f5e9,stroke:#2e7d32
```

## 7. 预签名 URL 鉴权模型

```mermaid
sequenceDiagram
    participant Provider as Provider<br/>(持有 secret)
    participant Service as StorageService
    participant Client as 请求方

    Note over Provider: signSecret = randomUUID()<br/>（provider 初始化时生成）

    Note over Provider,Client: ── 签名生成 ──
    Service->>Provider: signUploadUrl(key, ttl)
    Provider->>Provider: payload = "upload:" + key + ":" + expiresAt
    Provider->>Provider: sig = HMAC-SHA256(secret, payload)
    Provider-->>Service: expires=&sig=

    Note over Provider,Client: ── 签名验证 ──
    Client->>Service: PUT + key + expires + sig
    Service->>Provider: verifyUploadSignature(key, exp, sig)
    Provider->>Provider: expected = HMAC-SHA256(secret, "upload:"+key+":"+exp)
    Provider->>Provider: 检查 Date.now() <= exp<br/>检查 expected === sig
    Provider-->>Service: true / false
    Service-->>Client: 200 / 403

    Note over Client: 特性：无需数据库查 token<br/>无需共享状态 · 天然过期
```

## 8. 配置热切换流程

```mermaid
stateDiagram-v2
    [*] --> Loading: Server 启动 / reload()
    Loading --> ReadingDB: onModuleInit()
    ReadingDB --> Validating: StorageBackendConfig.findFirst()
    Validating --> FallingBack: kind 未知
    Validating --> Instantiating: kind 在注册表中
    FallingBack --> Instantiating: 使用 "local" 兜底
    Instantiating --> Ready: new ProviderClass(config)
    Ready --> Running: provider 就绪

    Running --> Running: 处理请求
    Running --> Reloading: 管理面板调用 reload()
    Reloading --> ReadingDB: 重新读取 DB 配置
    ReadingDB --> Validating: ......

    Running --> [*]: Server 停止
```

## 9. 数据模型

```mermaid
erDiagram
    StorageBackendConfig {
        int id PK "自增主键"
        string kind "后端类型: local | alibaba | ..."
        string config "JSON 配置: {baseDir, ...}"
        datetime updatedAt "最后更新时间"
    }

    Job {
        string id PK
        string clientId FK
        string type
        string status
        string payload "可能包含关联的 storage key"
        string result "可能包含关联的 storage key"
    }

    StorageBackendConfig ||--|| StorageService : "单行配置，驱动 provider 选择"
    Job ||--o| StorageProvider : "Job 完成后通过 key 清理文件"
```
