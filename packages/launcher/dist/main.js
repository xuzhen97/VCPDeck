"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * launcher 入口：加载配置并启动守护进程。
 * 部署后冻结，不参与业务构件自动更新。详见 docs/design/release-and-update.md。
 */
const daemon_js_1 = require("./daemon.js");
async function main() {
    let config;
    try {
        config = (0, daemon_js_1.loadConfigFromEnv)();
    }
    catch (e) {
        console.error(`[launcher] 配置错误: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
    const daemon = new daemon_js_1.Daemon(config);
    try {
        await daemon.start();
    }
    catch (e) {
        console.error(`[launcher] 启动失败: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
void main();
