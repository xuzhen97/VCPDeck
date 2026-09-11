"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const job_service_js_1 = require("./job.service.js");
const events_controller_js_1 = require("../events/events.controller.js");
const tempDirectories = [];
function makePrisma(job) {
    return {
        job: {
            findUnique: vitest_1.vi.fn().mockResolvedValue(job),
        },
    };
}
function makeService(job, outputDir) {
    return new job_service_js_1.JobService(makePrisma(job), {}, {}, {}, outputDir);
}
(0, vitest_1.afterEach)(async () => {
    await Promise.all(tempDirectories
        .splice(0)
        .map((directory) => (0, promises_1.rm)(directory, { recursive: true, force: true })));
});
(0, vitest_1.describe)("resolveJobOutputDir", () => {
    (0, vitest_1.it)("相对路径锚定 appDir，绝对路径原样返回", () => {
        (0, vitest_1.expect)((0, job_service_js_1.resolveJobOutputDir)("/srv/deck")).toBe((0, node_path_1.resolve)("/srv/deck", "data/job-outputs"));
        (0, vitest_1.expect)((0, job_service_js_1.resolveJobOutputDir)(undefined)).toBe((0, node_path_1.resolve)(process.cwd(), "data/job-outputs"));
    });
});
(0, vitest_1.describe)("JobService output spool", () => {
    const job = { id: "job-1", clientId: "client-1", status: "running" };
    (0, vitest_1.it)("appendOutputRaw 流式追加同一文件，未知 Job 静默忽略", async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-job-output-"));
        tempDirectories.push(root);
        const service = makeService(job, root);
        await service.appendOutputRaw("job-1", "step 1 ok\n");
        await service.appendOutputRaw("job-1", "step 2 failed\n");
        await service.appendOutputRaw("missing-job", "不应写入\n");
        await service.appendOutputRaw("job-1", "");
        const content = await (0, promises_1.readFile)((0, node_path_1.join)(root, "job-1.log"), "utf8");
        (0, vitest_1.expect)(content).toBe("step 1 ok\nstep 2 failed\n");
    });
    (0, vitest_1.it)("readJobOutput 返回全文，无文件或未知 Job 返回 null", async () => {
        const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-job-output-"));
        tempDirectories.push(root);
        await (0, promises_1.writeFile)((0, node_path_1.join)(root, "job-2.log"), "line-A\nline-B", "utf8");
        const service = makeService({ id: "job-2" }, root);
        await (0, vitest_1.expect)(service.readJobOutput("job-2")).resolves.toBe("line-A\nline-B");
        const noFile = makeService({ id: "job-3" }, root);
        await (0, vitest_1.expect)(noFile.readJobOutput("job-3")).resolves.toBeNull();
        const unknown = makeService(null, root);
        await (0, vitest_1.expect)(unknown.readJobOutput("job-2")).resolves.toBeNull();
    });
});
(0, vitest_1.describe)("EventsController GET jobs/:jobId/output", () => {
    function makeController(job) {
        const jobService = {
            findById: vitest_1.vi.fn().mockResolvedValue(job),
            readJobOutput: vitest_1.vi.fn(),
        };
        return {
            controller: new events_controller_js_1.EventsController(jobService, { rename: vitest_1.vi.fn() }, {}, {}),
            jobService: jobService,
        };
    }
    (0, vitest_1.it)("有输出时返回 jobId 与全文", async () => {
        const { controller, jobService } = makeController({ id: "job-9" });
        jobService.readJobOutput.mockResolvedValue("boom: ENOENT /data/x");
        const result = await controller.getJobOutput("job-9");
        (0, vitest_1.expect)(result).toEqual({ jobId: "job-9", output: "boom: ENOENT /data/x" });
        (0, vitest_1.expect)(jobService.findById).toHaveBeenCalledWith("job-9");
    });
    (0, vitest_1.it)("Job 不存在时抛出 NotFound", async () => {
        const { controller } = makeController(null);
        await (0, vitest_1.expect)(controller.getJobOutput("nope")).rejects.toThrow('Job "nope" not found');
    });
    (0, vitest_1.it)("无 spool 文件时 output 为 null 而不是报错", async () => {
        const { controller, jobService } = makeController({ id: "job-10" });
        jobService.readJobOutput.mockResolvedValue(null);
        await (0, vitest_1.expect)(controller.getJobOutput("job-10")).resolves.toEqual({
            jobId: "job-10",
            output: null,
        });
    });
});
