"use strict";
/** @file frpc 守护进程 — 单例适配器：把 FrpRuntimeManager 结果映射为 JOB_DONE，管理真实 frpc spawn 与原子 TOML 替换 */
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
exports.isFrpAvailable = isFrpAvailable;
exports.getFrpRuntimeManager = getFrpRuntimeManager;
exports.getFrpRuntimeState = getFrpRuntimeState;
exports.setFrpConnectionGeneration = setFrpConnectionGeneration;
exports.subscribeFrpRuntimeState = subscribeFrpRuntimeState;
exports.shutdownFrpRuntime = shutdownFrpRuntime;
exports.handleFrpCreate = handleFrpCreate;
exports.handleFrpDelete = handleFrpDelete;
exports.handleFrpReconcile = handleFrpReconcile;
exports.handleFrpList = handleFrpList;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const shared_1 = require("@vcpdeck/shared");
const frp_runtime_manager_js_1 = require("./frp-runtime-manager.js");
// 调用期访问 CLIENT_ID（模块求值期避免与 register 的循环依赖）。
const register_js_1 = require("./register.js");
/** 默认 frpc 路径候选（按序尝试，支持 .bin 副本：防 Windows 开发机杀毒删除无扩展名 ELF） */
function defaultFrpcPath() {
    const platform = os.platform();
    const arch = os.arch();
    const map = {
        "win32-x64": ["frp/win-x64/frpc.exe"],
        "linux-x64": ["frp/linux-x64/frpc", "frp/linux-x64/frpc.bin"],
        "linux-arm64": ["frp/linux-arm64/frpc", "frp/linux-arm64/frpc.bin"],
    };
    const rels = map[`${platform}-${arch}`];
    if (!rels)
        return null;
    for (const rel of rels) {
        const candidate = path.join(__dirname, rel);
        if (fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
function resolveFrpcPath() {
    const envPath = process.env.VCPDECK_FRPC_PATH;
    if (envPath && fs.existsSync(envPath))
        return envPath;
    const def = defaultFrpcPath();
    if (def && fs.existsSync(def))
        return def;
    return null;
}
function isFrpAvailable() {
    return resolveFrpcPath() !== null;
}
function getWorkDir() {
    return (process.env.VCPDECK_FRPC_WORK_DIR ||
        path.join(os.homedir(), ".vcpdeck", "frp"));
}
/** 原子写合并 TOML：tmp-<generation> 写入后 rename 到正式文件；权限沿用运行账户，内容不落日志。 */
function writeCombinedConfigAtomically(content) {
    const workDir = getWorkDir();
    fs.mkdirSync(workDir, { recursive: true });
    const configPath = path.join(workDir, "frpc-combined.toml");
    const tmpPath = path.join(workDir, `frpc-combined.toml.tmp-${Date.now().toString(36)}`);
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, configPath);
    return configPath;
}
let manager = null;
/** 懒加载单例 manager（真实 spawn/FS；clientId 取本机持久化 ID）。 */
function getManager() {
    if (!manager) {
        manager = (0, frp_runtime_manager_js_1.createFrpRuntimeManager)({
            resolveExecutable: () => resolveFrpcPath(),
            workDir: getWorkDir(),
            spawn: (cmd, args, opts) => {
                const child = (0, node_child_process_1.spawn)(cmd, args, opts);
                return child;
            },
            writeConfigAtomically: (content) => {
                writeCombinedConfigAtomically(content);
            },
            // 在线崩溃有限重启：立即 / 5s / 30s，共三次。
            delays: [0, 5_000, 30_000],
            clientId: register_js_1.CLIENT_ID,
            onState: () => {
                // 上报由 socket 桥订阅（subscribeFrpRuntimeState）驱动，这里无需副作用。
            },
            log: (msg) => console.log(msg),
        });
    }
    return manager;
}
/** 获取 FRP 运行时单例（socket 桥接线用）。 */
function getFrpRuntimeManager() {
    return getManager();
}
/** 当前 FRP 运行时安全状态快照（不含 Token/TOML/stderr）。 */
function getFrpRuntimeState(clientId) {
    return getManager().getStateReport(clientId);
}
/** 设置当前 socket 连接代次（每次 REGISTER 生成新 UUID 后调用）。 */
function setFrpConnectionGeneration(value) {
    getManager().setConnectionGeneration(value);
}
/** 订阅 FRP 运行时状态变化；返回退订函数。 */
function subscribeFrpRuntimeState(listener) {
    return getManager().subscribe(listener);
}
/** 计划内停机：取消有限重启 timer 并停止 frpc（更新/退出前调用，防误判 crash）。 */
async function shutdownFrpRuntime() {
    await getManager().shutdown();
}
function reconcileErrorCode(err) {
    const code = err?.code;
    if (code === "FRP_RUNTIME_GENERATION_STALE")
        return code;
    if (code === "FRP_RUNTIME_STATE_INVALID")
        return code;
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("frpc 二进制不存在"))
        return "FRPC_NOT_FOUND";
    if (msg.includes("frpc 启动失败"))
        return "FRPC_START_FAILED";
    return "FRP_RECONCILE_FAILED";
}
/** 收到 frp.create Job */
async function handleFrpCreate(payload, socket) {
    if (!isFrpAvailable()) {
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId: payload._jobId,
            type: "frp.create",
            error: {
                code: "FRPC_NOT_FOUND",
                message: "frpc 二进制不存在",
            },
        });
        return;
    }
    try {
        const result = await getManager().create(payload);
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId: payload._jobId,
            type: "frp.create",
            result,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "";
        const code = message.includes("MAPPING_EXISTS") ? "MAPPING_EXISTS" : "FRPC_START_FAILED";
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId: payload._jobId,
            type: "frp.create",
            error: {
                code,
                message: code === "MAPPING_EXISTS"
                    ? `映射 ${payload.mappingId} 已存在`
                    : "frpc 启动失败",
            },
        });
    }
}
/** 收到 frp.delete Job */
async function handleFrpDelete(payload, socket) {
    try {
        const result = await getManager().delete(payload);
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId: payload._jobId,
            type: "frp.delete",
            result,
        });
    }
    catch {
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId: payload._jobId,
            type: "frp.delete",
            error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
        });
    }
}
/** 收到 frp.reconcile Job（严格解析 payload；Client 不在 Job 内重试） */
async function handleFrpReconcile(payload, socket) {
    const jobId = payload._jobId;
    let parsed;
    try {
        // 去掉 _jobId 后严格解析（未知字段拒绝）。
        const { _jobId: _omitted, ...rest } = payload;
        parsed = (0, shared_1.parseFrpReconcilePayload)(rest);
    }
    catch {
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId,
            type: "frp.reconcile",
            error: {
                code: "FRP_RUNTIME_STATE_INVALID",
                message: "frp reconcile 协议无效",
            },
        });
        return;
    }
    try {
        const result = await getManager().reconcile(parsed);
        socket.emit(shared_1.Events.JOB_DONE, { jobId, type: "frp.reconcile", result });
    }
    catch (err) {
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId,
            type: "frp.reconcile",
            error: {
                code: reconcileErrorCode(err),
                message: "frp reconcile 失败",
            },
        });
    }
}
/** 收到 frp.list Job */
function handleFrpList(payload, socket) {
    const result = getManager().list();
    socket.emit(shared_1.Events.JOB_DONE, {
        jobId: payload._jobId,
        type: "frp.list",
        result,
    });
}
