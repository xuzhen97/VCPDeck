import type { TerminalShellInfo } from "@vcpdeck/shared";
/** Shell 注册项：内部含 executable/args，公开 DTO 不含路径。 */
export interface ShellRegistryEntry {
    id: string;
    label: string;
    kind: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "sh" | "other";
    executable: string;
    args: string[];
    isDefault: boolean;
}
/** Shell 探测环境抽象（测试注入）。 */
export interface ShellDiscoveryEnv {
    platform: NodeJS.Platform;
    home: string;
    /** $SHELL 环境变量值（可能不存在） */
    shellEnv: string | undefined;
    path: string;
    pathExt: string;
    /** 在 PATH 中解析可执行文件（返回绝对路径或 null）。 */
    resolveExecutable: (name: string) => Promise<string | null>;
    /** 检查文件是否存在且可执行。 */
    isExecutable: (path: string) => Promise<boolean>;
}
/**
 * 探测可用 Shell（Windows：pwsh → powershell → cmd；POSIX：$SHELL → bash → zsh → sh）。
 * 只返回实际可用项；第一个可用项为默认。按解析后的可执行路径去重。
 */
export declare function discoverShells(env: ShellDiscoveryEnv): Promise<ShellRegistryEntry[]>;
/** 映射为公开 Shell DTO（不含可执行文件路径与启动参数）。 */
export declare function toTerminalShellInfo(entry: ShellRegistryEntry): TerminalShellInfo;
