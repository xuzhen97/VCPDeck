"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORAGE_PROVIDERS = void 0;
const local_storage_provider_js_1 = require("./local-storage.provider.js");
const alibaba_storage_provider_js_1 = require("./alibaba-storage.provider.js");
/** kind → Provider class 注册表。新增后端在此加一行即可。 */
exports.STORAGE_PROVIDERS = {
    local: local_storage_provider_js_1.LocalStorageProvider,
    alibaba: alibaba_storage_provider_js_1.AlibabaStorageProvider,
};
