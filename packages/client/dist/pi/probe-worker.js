"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
async function runProbe() {
    try {
        const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
        const runtime = await ModelRuntime.create();
        const models = await runtime.getAvailable();
        return {
            sdkVersion: "0.84.0",
            modelCount: models.length,
            error: null,
        };
    }
    catch (error) {
        return {
            sdkVersion: "",
            modelCount: 0,
            error: {
                code: "PI_RUNTIME_UNAVAILABLE",
                message: error instanceof Error ? error.message : "Pi SDK load failed",
            },
        };
    }
}
process.on("message", (msg) => {
    if (typeof msg !== "object" || msg === null || msg.type !== "probe") {
        return;
    }
    void runProbe().then((result) => {
        if (process.send)
            process.send(result);
        setTimeout(() => process.exit(0), 50);
    });
});
