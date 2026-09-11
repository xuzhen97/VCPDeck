import { VcpDeckApiError } from "@vcpdeck/sdk";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";
import { formatTable } from "./table.js";
/** 映射状态显示文案（reconciling → 恢复中）。 */
function mappingStatusLabel(status) {
    return ({
        active: "运行中",
        inactive: "未确认",
        provisioning: "创建中",
        deleting: "删除中",
        reconciling: "恢复中",
        error: "异常",
    }[status] ?? status);
}
/**
 * 实例信息的安全投影：authToken/dashboardPassword 等凭据绝不进入输出。
 */
function safeInstance(instance) {
    return {
        name: instance.name,
        server: `${instance.serverAddr}:${instance.serverPort}`,
        dashboard: instance.dashboardHost !== null
            ? `${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}`
            : "-",
        default: instance.isDefault ? "yes" : "-",
    };
}
/** 执行 FRP 命令组（当前只读）。 */
export async function runFrpCommand(subcommand, argv, context = {}) {
    const helpRequested = subcommand === "--help" ||
        subcommand === "-h" ||
        ((subcommand === "instances" ||
            subcommand === "mappings" ||
            subcommand === "mapping" ||
            subcommand === undefined) &&
            hasHelp(argv));
    if (helpRequested) {
        (context.log ?? console.log)(frpUsage());
        return;
    }
    if (subcommand === "instances") {
        await runInstances(argv, context);
        return;
    }
    if (subcommand === "mappings") {
        await runMappings(argv, context);
        return;
    }
    if (subcommand === "mapping") {
        await runMapping(argv, context);
        return;
    }
    throw new Error(frpUsage());
}
function hasHelp(argv) {
    return argv.includes("--help") || argv.includes("-h");
}
function frpUsage() {
    return [
        "FRP 命令:",
        "  vcpdeck frp instances [--page=<n>] [--env=<name>] [--json]",
        "  vcpdeck frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]",
        "  vcpdeck frp mapping create <client> --local-port=<port> [--type=tcp|http|https] [--local-ip=<host>] [--remote-port=<port>] [--domain=<domain>] [--name=<name>] [--instance=<id>] [--timeout=<seconds>] [--env=<name>] [--json]",
        "  vcpdeck frp mapping delete <mappingId> [--timeout=<seconds>] [--env=<name>] [--json]",
    ].join("\n");
}
async function runInstances(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "page"],
        boolean: ["json"],
    });
    if (positionals.length > 0)
        throw new Error(frpUsage());
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    const result = await client.frp.instances.list({
        page: parsePage(stringOption(options, "page")),
    });
    if (options.json === true) {
        const safe = result.data.map(safeInstance);
        (context.log ?? console.log)(JSON.stringify({ ...result, data: safe }, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    log(`FRP 服务实例（${result.total}）：`);
    log(formatTable(result.data.map(safeInstance), ["name", "server", "dashboard", "default"]));
}
async function runMapping(argv, context) {
    const [action, ...rest] = argv;
    if (action === "create") {
        await runCreateMapping(rest, context);
        return;
    }
    if (action === "delete") {
        await runDeleteMapping(rest, context);
        return;
    }
    throw new Error(frpUsage());
}
async function runCreateMapping(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: [
            "env", "environment", "type", "local-ip", "local-port",
            "remote-port", "domain", "name", "instance", "timeout",
        ],
        boolean: ["json"],
    });
    if (positionals.length !== 1)
        throw new Error(frpUsage());
    const localPort = parsePort(stringOption(options, "local-port"), "--local-port");
    const proxyType = stringOption(options, "type") ?? "tcp";
    if (!new Set(["tcp", "http", "https"]).has(proxyType)) {
        throw new Error("--type 必须是 tcp、http 或 https");
    }
    const remotePort = parseOptionalPort(stringOption(options, "remote-port"), "--remote-port");
    const customDomain = stringOption(options, "domain");
    if (proxyType === "tcp" && customDomain) {
        throw new Error("TCP 映射不接受 --domain");
    }
    if (proxyType !== "tcp" && !customDomain) {
        throw new Error("HTTP/HTTPS 映射必须提供 --domain");
    }
    if (proxyType !== "tcp" && remotePort !== undefined) {
        throw new Error("HTTP/HTTPS 映射不接受 --remote-port");
    }
    const timeoutSeconds = parseTimeout(stringOption(options, "timeout"));
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    const clientId = await resolveClientId(positionals[0], context.paths, context.processEnv, client);
    let mapping;
    try {
        mapping = await client.frp.createAndWait({
            clientId,
            proxyType: proxyType,
            localIp: stringOption(options, "local-ip") ?? "127.0.0.1",
            localPort,
            ...(remotePort === undefined ? {} : { remotePort }),
            ...(customDomain ? { customDomain } : {}),
            ...(stringOption(options, "name")
                ? { name: stringOption(options, "name") }
                : {}),
            ...(stringOption(options, "instance")
                ? { frpsInstanceId: stringOption(options, "instance") }
                : {}),
            timeoutSeconds,
        }, { delays: [context.pollIntervalMs ?? 1000] });
    }
    catch (error) {
        // 恢复周期 busy（409）：转安全指引，不自动重试，引导稍后查询。
        if (error instanceof VcpDeckApiError && error.code === "FRP_RECONCILE_BUSY") {
            throw new Error("映射正在自动恢复，请稍后运行 frp mappings 查看进度");
        }
        throw error;
    }
    const log = context.log ?? console.log;
    if (options.json === true) {
        log(JSON.stringify(mapping, null, 2));
        return;
    }
    log(formatEnvironmentSummary(environment));
    log(`FRP 映射已建立：${mapping.name} (${mapping.publicUrl ?? mapping.id})`);
}
async function runDeleteMapping(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "timeout"],
        boolean: ["json"],
    });
    if (positionals.length !== 1)
        throw new Error(frpUsage());
    const timeoutSeconds = parseTimeout(stringOption(options, "timeout"));
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    let result;
    try {
        result = await client.frp.deleteAndWait(positionals[0], {
            timeoutSeconds,
            delays: [context.pollIntervalMs ?? 1000],
        });
    }
    catch (error) {
        // 恢复周期 busy（409）：转安全指引，不自动重试，引导稍后查询。
        if (error instanceof VcpDeckApiError && error.code === "FRP_RECONCILE_BUSY") {
            throw new Error("映射正在自动恢复，请稍后运行 frp mappings 查看进度");
        }
        throw error;
    }
    const log = context.log ?? console.log;
    if (options.json === true) {
        log(JSON.stringify(result, null, 2));
        return;
    }
    log(formatEnvironmentSummary(environment));
    log(`FRP 映射已删除：${result.id}`);
}
async function runMappings(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "client", "page"],
        boolean: ["json"],
    });
    if (positionals.length > 0)
        throw new Error(frpUsage());
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    const clientFilter = stringOption(options, "client");
    const clientId = clientFilter
        ? await resolveClientId(clientFilter, context.paths, context.processEnv, client)
        : undefined;
    const result = await client.frp.list({
        clientId,
        page: parsePage(stringOption(options, "page")),
    });
    if (options.json === true) {
        (context.log ?? console.log)(JSON.stringify(result, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    if (result.data.length === 0) {
        log("当前过滤条件下没有映射。");
        return;
    }
    log(`FRP 映射（共 ${result.total} · 第 ${result.page}/${result.totalPages} 页）：`);
    log(formatTable(result.data.map((mapping) => ({
        name: mapping.name,
        client: mapping.clientId,
        type: mapping.proxyType,
        local: `${mapping.localIp}:${mapping.localPort}`,
        remote: mapping.remotePort === null ? "-" : String(mapping.remotePort),
        status: mappingStatusLabel(mapping.status),
        url: mapping.publicUrl ?? "-",
    })), ["name", "client", "type", "local", "remote", "status", "url"]));
}
function exclusiveAlias(options, first, second) {
    const firstValue = stringOption(options, first);
    const secondValue = stringOption(options, second);
    if (firstValue && secondValue) {
        throw new Error(`--${first} 与 --${second} 不能同时使用`);
    }
    return firstValue ?? secondValue;
}
function parsePage(raw) {
    if (raw === undefined)
        return undefined;
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1) {
        throw new Error("--page 必须是不小于 1 的整数");
    }
    return page;
}
function parsePort(raw, option) {
    const port = Number(raw);
    if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${option} 必须是 1–65535 的整数`);
    }
    return port;
}
function parseOptionalPort(raw, option) {
    return raw === undefined ? undefined : parsePort(raw, option);
}
function parseTimeout(raw) {
    const timeout = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
        throw new Error("--timeout 必须是 1–300 的整数");
    }
    return timeout;
}
