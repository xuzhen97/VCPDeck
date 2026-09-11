import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { formatEnvironmentSummary, resolveEnvironment, } from "./environment.js";
import { formatPrivilegeSummary } from "./privileged-capability.js";
/** 执行 Clients 命令组（当前只读）。 */
export async function runClientsCommand(subcommand, argv, context = {}) {
    const helpRequested = subcommand === "--help" ||
        subcommand === "-h" ||
        ((subcommand === "list" || subcommand === undefined) && hasHelp(argv));
    if (helpRequested) {
        (context.log ?? console.log)(clientsUsage());
        return;
    }
    if (subcommand === "list") {
        await runListClients(argv, context);
        return;
    }
    throw new Error(clientsUsage());
}
function hasHelp(argv) {
    return argv.includes("--help") || argv.includes("-h");
}
function clientsUsage() {
    return [
        "Clients 命令:",
        "  vcpdeck clients list [--env=<name>] [--json]",
    ].join("\n");
}
async function runListClients(argv, context) {
    const { options } = parseCommandArgs(argv, {
        value: ["env", "environment"],
        boolean: ["json"],
    });
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const log = context.log ?? console.log;
    if (options.json === true) {
        const client = await createAuthenticatedClient(environment);
        const clients = await client.clients.list();
        log(JSON.stringify(clients, null, 2));
        return;
    }
    log(formatEnvironmentSummary(environment));
    const client = await createAuthenticatedClient(environment);
    const clients = await client.clients.list();
    log(formatClientsSummary(clients));
}
/** 生成人类可读的机器列表；在线优先，其余按名称稳定排序。 */
function formatClientsSummary(clients) {
    if (clients.length === 0)
        return "没有已注册的 Client。";
    const sorted = [...clients].sort((a, b) => {
        if (a.online !== b.online)
            return a.online ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    const rows = sorted.map((client) => ({
        name: client.name,
        hostname: client.hostname,
        os: client.os,
        state: client.online ? "online" : "offline",
        cpu: formatPercent(client.cpuPercent),
        mem: formatPercent(client.memPercent),
        version: client.clientVersion,
        privilege: formatPrivilegeSummary(client),
    }));
    const onlineCount = clients.filter((client) => client.online).length;
    return [
        `共 ${clients.length} 台 · 在线 ${onlineCount} · 离线 ${clients.length - onlineCount}`,
        formatTable(rows, [
            "name",
            "hostname",
            "os",
            "state",
            "cpu",
            "mem",
            "version",
            "privilege",
        ]),
    ].join("\n");
}
function exclusiveAlias(options, first, second) {
    const firstValue = stringOption(options, first);
    const secondValue = stringOption(options, second);
    if (firstValue && secondValue) {
        throw new Error(`--${first} 与 --${second} 不能同时使用`);
    }
    return firstValue ?? secondValue;
}
function formatPercent(value) {
    return value === null ? "-" : `${value.toFixed(0)}%`;
}
/** 无依赖的简易对齐表格；首行为表头。 */
function formatTable(rows, columns) {
    const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
    const line = (cells) => cells
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
        .trimEnd();
    return [
        line(columns.map((column) => column.toUpperCase())),
        ...rows.map((row) => line(columns.map((column) => row[column]))),
    ].join("\n");
}
