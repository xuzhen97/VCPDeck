import { JobStatus, } from "@vcpdeck/shared";
/** FRP 完整操作失败。 */
export class FrpOperationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "FrpOperationError";
    }
}
/** 创建 FRP REST API。 */
export function createFrpApi(client, jobs) {
    return {
        list: (options, signal) => {
            const params = new URLSearchParams();
            if (options?.clientId)
                params.set("clientId", options.clientId);
            if (options?.page)
                params.set("page", String(options.page));
            if (options?.pageSize)
                params.set("pageSize", String(options.pageSize));
            const qs = params.toString();
            return client.request("GET", `/api/frp/mappings${qs ? `?${qs}` : ""}`, undefined, signal);
        },
        get: (id, signal) => client.request("GET", `/api/frp/mappings/${encodeURIComponent(id)}`, undefined, signal),
        create: (input, signal) => client.request("POST", "/api/frp/mappings", input, signal),
        async createAndWait(input, options = {}) {
            if (!jobs)
                throw new Error("FRP wait requires Jobs API");
            const mapping = await client.request("POST", "/api/frp/mappings", input, options.signal);
            if (!mapping.operationJobId)
                throw new Error("Server 未返回 FRP operationJobId");
            const job = await jobs.wait(mapping.operationJobId, options);
            if (job.status !== JobStatus.DONE) {
                throw new FrpOperationError(job.errorCode ?? "FRP_OPERATION_FAILED", job.errorMessage ?? "FRP 映射创建失败");
            }
            return client.request("GET", `/api/frp/mappings/${encodeURIComponent(mapping.id)}`, undefined, options.signal);
        },
        delete: (id, optionsOrSignal = {}) => {
            const options = optionsOrSignal instanceof AbortSignal
                ? { signal: optionsOrSignal }
                : optionsOrSignal;
            const params = new URLSearchParams();
            if (options.timeoutSeconds) {
                params.set("timeoutSeconds", String(options.timeoutSeconds));
            }
            const query = params.toString();
            return client.request("DELETE", `/api/frp/mappings/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, undefined, options.signal);
        },
        async deleteAndWait(id, options = {}) {
            if (!jobs)
                throw new Error("FRP wait requires Jobs API");
            const params = new URLSearchParams();
            if (options.timeoutSeconds) {
                params.set("timeoutSeconds", String(options.timeoutSeconds));
            }
            const query = params.toString();
            const mapping = await client.request("DELETE", `/api/frp/mappings/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, undefined, options.signal);
            if (!mapping.operationJobId)
                throw new Error("Server 未返回 FRP operationJobId");
            const job = await jobs.wait(mapping.operationJobId, options);
            if (job.status !== JobStatus.DONE) {
                throw new FrpOperationError(job.errorCode ?? "FRP_OPERATION_FAILED", job.errorMessage ?? "FRP 映射删除失败");
            }
            return { id, deleted: true };
        },
        instances: {
            list: (options, signal) => {
                const params = new URLSearchParams();
                if (options?.page)
                    params.set("page", String(options.page));
                if (options?.pageSize)
                    params.set("pageSize", String(options.pageSize));
                const qs = params.toString();
                return client.request("GET", `/api/frp/instances${qs ? `?${qs}` : ""}`, undefined, signal);
            },
            get: (id, signal) => client.request("GET", `/api/frp/instances/${encodeURIComponent(id)}`, undefined, signal),
            create: (input, signal) => client.request("POST", "/api/frp/instances", input, signal),
            update: (id, input, signal) => client.request("PUT", `/api/frp/instances/${encodeURIComponent(id)}`, input, signal),
            delete: (id, signal) => client.request("DELETE", `/api/frp/instances/${encodeURIComponent(id)}`, undefined, signal),
            probe: (id, signal) => client.request("POST", `/api/frp/instances/${encodeURIComponent(id)}/probe`, undefined, signal),
            setDefault: (id, signal) => client.request("POST", `/api/frp/instances/${encodeURIComponent(id)}/set-default`, undefined, signal),
        },
    };
}
