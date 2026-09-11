"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSnapshotter = createSnapshotter;
const shared_1 = require("@vcpdeck/shared");
/**
 * 每会话 headless 终端快照器。
 * - 所有 write/resize/snapshot 经单一串行队列处理，保证 snapshotSeq 与画面内容原子一致；
 * - snapshot 编码超过上限时回退为有界原始输出并标记 historyTruncated；
 * - 不持久化快照内容。
 */
function createSnapshotter(env, opts) {
    let seq = 0;
    let cols = opts.cols;
    let rows = opts.rows;
    let raw = "";
    let terminal = env.createTerminal({
        cols,
        rows,
        scrollback: env.scrollback,
    });
    let disposed = false;
    let queue = Promise.resolve();
    function enqueue(task) {
        const run = queue.then(task);
        queue = run.then(() => undefined, () => undefined);
        return run;
    }
    function snapshotError(message) {
        return Object.assign(new Error(message), { code: "TERMINAL_SNAPSHOT_FAILED" });
    }
    function assertAlive() {
        if (disposed || !terminal)
            throw snapshotError("Snapshotter is disposed");
    }
    return {
        /** 写入输出（headless 处理完成后推进 seq）。 */
        write(data, cb) {
            void enqueue(async () => {
                assertAlive();
                await new Promise((resolve) => {
                    terminal.write(data, () => resolve());
                });
                raw += data;
                if ((0, shared_1.utf8ByteLength)(raw) > env.maxSnapshotBytes) {
                    raw = raw.slice(raw.length - env.maxSnapshotBytes);
                }
                seq += 1;
                cb?.();
            });
        },
        /** 同步调整 headless 终端尺寸。 */
        resize(newCols, newRows) {
            void enqueue(async () => {
                assertAlive();
                terminal.resize(newCols, newRows);
                cols = newCols;
                rows = newRows;
            });
        },
        /** 生成快照（串行队列内执行，保证与 seq 一致）。 */
        async snapshot() {
            return enqueue(async () => {
                assertAlive();
                let serialized;
                try {
                    serialized = terminal.serialize();
                }
                catch {
                    throw snapshotError("Terminal snapshot serialization failed");
                }
                if ((0, shared_1.utf8ByteLength)(serialized) <= env.maxSnapshotBytes) {
                    return { snapshot: serialized, snapshotSeq: seq, cols, rows, historyTruncated: false };
                }
                return {
                    snapshot: raw.slice(-env.maxSnapshotBytes),
                    snapshotSeq: seq,
                    cols,
                    rows,
                    historyTruncated: true,
                };
            });
        },
        /** 释放资源（串行队列内执行）。 */
        dispose() {
            void enqueue(async () => {
                terminal?.dispose();
                terminal = null;
                disposed = true;
            });
        },
    };
}
