import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";
/** 执行 Storage 命令组（当前只读）。 */
export async function runStorageCommand(subcommand, argv, context = {}) {
    const helpRequested = subcommand === "--help" ||
        subcommand === "-h" ||
        ((subcommand === "status" || subcommand === undefined) && hasHelp(argv));
    if (helpRequested) {
        (context.log ?? console.log)(storageUsage());
        return;
    }
    if (subcommand === "status") {
        await runStatus(argv, context);
        return;
    }
    throw new Error(storageUsage());
}
function hasHelp(argv) {
    return argv.includes("--help") || argv.includes("-h");
}
function storageUsage() {
    return [
        "Storage 命令（只读）:",
        "  vcpdeck storage status [--env=<name>] [--json]  # 查看当前激活的存储后端",
    ].join("\n");
}
async function runStatus(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment"],
        boolean: ["json"],
    });
    if (positionals.length > 0)
        throw new Error(storageUsage());
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    const config = await client.storage.getBackendConfig();
    if (options.json === true) {
        (context.log ?? console.log)(JSON.stringify(config, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    log(`Storage 后端: ${config.kind}`);
    if (config.updatedAt)
        log(`配置更新时间: ${config.updatedAt}`);
}
function exclusiveAlias(options, first, second) {
    const firstValue = stringOption(options, first);
    const secondValue = stringOption(options, second);
    if (firstValue && secondValue) {
        throw new Error(`--${first} 与 --${second} 不能同时使用`);
    }
    return firstValue ?? secondValue;
}
