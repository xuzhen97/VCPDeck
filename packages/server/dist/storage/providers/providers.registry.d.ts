import type { StorageProvider } from "./storage-provider.interface.js";
/** kind → Provider class 注册表。新增后端在此加一行即可。 */
export declare const STORAGE_PROVIDERS: Record<string, new (config: Record<string, unknown>) => StorageProvider>;
