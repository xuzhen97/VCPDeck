"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientPsk = clientPsk;
/** 返回 Server 与 Client 安装入口共同使用的共享 PSK。 */
function clientPsk() {
    return process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
}
