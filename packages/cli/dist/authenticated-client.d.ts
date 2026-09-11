import { VcpDeckClient } from "@vcpdeck/sdk";
import type { ResolvedEnvironment } from "./environment.js";
/** 按已解析环境创建 SDK 客户端；Bearer 直接代表身份，密码仅保留兼容登录。 */
export declare function createAuthenticatedClient(environment: ResolvedEnvironment): Promise<VcpDeckClient>;
