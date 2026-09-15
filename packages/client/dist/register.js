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
exports.CLIENT_ID = void 0;
exports.isMigrationVerifyOnly = isMigrationVerifyOnly;
exports.getRegisterInfo = getRegisterInfo;
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const frpc_daemon_js_1 = require("./frpc-daemon.js");
const CLIENT_ID_DIR = path.join(os.homedir(), ".vcpdeck");
const CLIENT_ID_FILE = path.join(CLIENT_ID_DIR, "client-id");
function loadOrCreateClientId() {
    try {
        return fs.readFileSync(CLIENT_ID_FILE, "utf-8").trim();
    }
    catch {
        const id = (0, node_crypto_1.randomUUID)();
        fs.mkdirSync(CLIENT_ID_DIR, { recursive: true });
        fs.writeFileSync(CLIENT_ID_FILE, id);
        return id;
    }
}
exports.CLIENT_ID = process.env.VCPDECK_CLIENT_ID || loadOrCreateClientId();
/**
 * 构造机器注册消息。
 * @param piStatus Pi 能力探测结果（可选）
 * @param terminalStatus 终端能力探测结果（可选）
 * @param runtimeSecurity 运行时安全摘要：非交互特权能力（capabilityDetails.privileged）
 *   与安装模式（顶层 installation）；缺省不上报，不新增可执行 capability 字符串。
 */
/**
 * M1 迁移验证专用模式（VCPDECK_MIGRATION_VERIFY_ONLY=1）：
 * 注册保留身份/版本/安装/特权摘要，但不发布任何 operational 能力，
 * 使 Server 能在不下发任何工作前验证身份与运行时安全。仅 Linux A2 迁移使用，
 * 全新安装与稳态永不进入该模式。
 */
function isMigrationVerifyOnly(env = process.env) {
    return env.VCPDECK_MIGRATION_VERIFY_ONLY === "1";
}
function getRegisterInfo(piStatus, terminalStatus, runtimeSecurity, env = process.env, p2pTunnelStatus) {
    const verifyOnly = isMigrationVerifyOnly(env);
    const cpus = os.cpus();
    const caps = [];
    if (!verifyOnly) {
        caps.push("exec", "file.read", "file.write");
        if ((0, frpc_daemon_js_1.isFrpAvailable)()) {
            caps.push("frp");
        }
        if (piStatus?.available) {
            caps.push("agent.pi");
        }
        if (terminalStatus?.available) {
            caps.push("terminal.pty");
        }
        // P2P 隧道：只有 native 后端成功加载才声明 operational 能力。
        if (p2pTunnelStatus?.available) {
            caps.push("tunnel.p2p");
        }
    }
    const capabilityDetails = {};
    if (!verifyOnly) {
        if (piStatus !== undefined)
            capabilityDetails.pi = piStatus;
        if (terminalStatus !== undefined)
            capabilityDetails.terminal = terminalStatus;
        // FRP 能力：按 frpc 可探测性声明；协商固定为 protocol v1（不按应用版本猜测）。
        const frpStatus = (0, frpc_daemon_js_1.isFrpAvailable)()
            ? { available: true, reconcileProtocolVersion: shared_1.FRP_RECONCILE_PROTOCOL_VERSION }
            : { available: false, code: "FRPC_NOT_FOUND" };
        capabilityDetails.frp = frpStatus;
        // P2P 隧道能力摘要：可用时携带 protocolVersion；不可用时上报稳定 code（不含 native 错误正文）。
        if (p2pTunnelStatus !== undefined) {
            capabilityDetails.p2pTunnel = p2pTunnelStatus;
        }
    }
    // 运行时安全摘要两种模式都上报（M1 验证依赖 privileged 与 installation）；不含本地路径或凭据。
    if (runtimeSecurity?.privileged !== undefined) {
        capabilityDetails.privileged = runtimeSecurity.privileged;
    }
    const register = {
        clientId: exports.CLIENT_ID,
        hostname: os.hostname(),
        os: `${os.platform()} ${os.release()}`,
        cpuModel: cpus[0]?.model || "unknown",
        totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
        clientVersion: shared_1.VERSION,
        capabilities: caps,
        capabilityDetails,
    };
    if (runtimeSecurity?.installation !== undefined) {
        register.installation = runtimeSecurity.installation;
    }
    return register;
}
