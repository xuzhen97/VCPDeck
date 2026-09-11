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
exports.getHeartbeat = getHeartbeat;
const os = __importStar(require("node:os"));
const disks_js_1 = require("./disks.js");
const register_js_1 = require("./register.js");
// ponytail: 模块级缓存前一次 CPU 累计时间，计算两次心跳间的 delta
let prevCpu = { idle: 0, total: 0 };
function calcCpuPercent() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
        idle += cpu.times.idle;
        total +=
            cpu.times.user +
                cpu.times.nice +
                cpu.times.sys +
                cpu.times.idle +
                cpu.times.irq;
    }
    // 首次调用，只缓存不返回值
    if (prevCpu.total === 0 && prevCpu.idle === 0) {
        prevCpu = { idle, total };
        return 0;
    }
    const deltaIdle = idle - prevCpu.idle;
    const deltaTotal = total - prevCpu.total;
    prevCpu = { idle, total };
    if (deltaTotal <= 0)
        return 0;
    return Math.round((1 - deltaIdle / deltaTotal) * 100);
}
function getHeartbeat(runningJobs) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
        clientId: register_js_1.CLIENT_ID,
        cpuPercent: Math.min(calcCpuPercent(), 100),
        memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        disks: (0, disks_js_1.collectDisks)(),
        runningJobs,
        uptime: Math.round(process.uptime()),
    };
}
