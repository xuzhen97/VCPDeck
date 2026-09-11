"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiAgentSessionWrapperImpl = void 0;
exports.startPiAgentSession = startPiAgentSession;
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const event_projector_js_1 = require("./event-projector.js");
let sdkPromise = null;
function getSdk() {
    if (!sdkPromise)
        sdkPromise = import("@earendil-works/pi-coding-agent");
    return sdkPromise;
}
/** 空闲 10 分钟后优雅关闭 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Extension dialog 缺省超时（显式 timeout 优先） */
const DEFAULT_UI_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_RESET_EVENT_TYPES = new Set([
    "agent_end",
    "agent_settled",
    "auto_compaction_end",
    "compaction_end",
]);
function startPiAgentSession(options) {
    return (async () => {
        const agentDir = (await getSdk()).getAgentDir();
        const sessionManager = options.sessionFile
            ? (await getSdk()).SessionManager.open(options.sessionFile, undefined)
            : (await getSdk()).SessionManager.create(options.cwd, undefined);
        const sdk = await getSdk();
        const trustStore = new sdk.ProjectTrustStore(agentDir);
        let wrapper = null;
        const services = await (await getSdk()).createAgentSessionServices({
            cwd: sessionManager.getCwd(),
            agentDir,
            resourceLoaderReloadOptions: {
                // 未决定信任时先创建不加载项目资源的受限 Session。
                resolveProjectTrust: async () => trustStore.get(sessionManager.getCwd()) === true,
            },
        });
        // 模型 scope：可用模型 ∩ enabledModels（委托 SDK resolver，不自行匹配）
        const available = await services.modelRuntime.getAvailable();
        const enabled = services.settingsManager.getEnabledModels();
        let scopedModels = [];
        if (enabled && enabled.length > 0) {
            const { scopedModels: resolved } = await (await getSdk()).resolveModelScopeWithDiagnostics(enabled, services.modelRuntime);
            scopedModels = resolved;
        }
        const branch = sessionManager.getBranch();
        const hasExistingMessages = branch.some((entry) => entry.type === "message");
        const persistedModel = [...branch]
            .reverse()
            .find((entry) => entry.type === "model_change");
        const persistedThinking = [...branch]
            .reverse()
            .find((entry) => entry.type === "thinking_level_change");
        const restoredModel = persistedModel
            ? available.find((model) => model.provider === persistedModel.provider &&
                model.id === persistedModel.modelId)
            : undefined;
        const restoredThinking = persistedThinking?.thinkingLevel;
        const initial = hasExistingMessages
            ? { scopedModels }
            : restoredModel || (0, shared_1.isPiThinkingLevel)(restoredThinking)
                ? {
                    ...(restoredModel ? { model: restoredModel } : {}),
                    ...((0, shared_1.isPiThinkingLevel)(restoredThinking)
                        ? { thinkingLevel: restoredThinking }
                        : {}),
                }
                : selectInitialModel(available, scopedModels, options);
        const { session: inner } = await (await getSdk()).createAgentSessionFromServices({
            services,
            sessionManager,
            ...(initial.model ? { model: initial.model } : {}),
            ...(initial.thinkingLevel
                ? { thinkingLevel: initial.thinkingLevel }
                : {}),
            ...(initial.scopedModels?.length
                ? { scopedModels: initial.scopedModels }
                : scopedModels.length > 0
                    ? { scopedModels: scopedModels }
                    : {}),
        });
        wrapper = new PiAgentSessionWrapperImpl(inner);
        wrapper.setProjectTrustResolver(async (ask) => {
            const projectCwd = sessionManager.getCwd();
            const existing = trustStore.get(projectCwd);
            if (existing !== null)
                return false;
            if (!sdk.hasTrustRequiringProjectResources(projectCwd))
                return false;
            const confirmed = options.trustResolver
                ? await options.trustResolver(projectCwd, ask)
                : await ask(`此项目包含本地扩展/Skills（.pi/extensions 或 .agents/skills），是否信任并加载？`);
            trustStore.set(projectCwd, confirmed);
            return confirmed;
        });
        wrapper.start();
        return wrapper;
    })();
}
function selectInitialModel(available, scopedModels, options) {
    if (options.initialModel) {
        const match = available.find((m) => m.provider === options.initialModel?.provider &&
            m.id === options.initialModel?.modelId);
        if (match)
            return { model: match };
    }
    const first = scopedModels[0];
    if (first?.model) {
        return {
            model: first.model,
            thinkingLevel: first.thinkingLevel ?? options.thinkingLevel,
        };
    }
    if (available[0])
        return { model: available[0] };
    return { thinkingLevel: options.thinkingLevel };
}
/** confirm 询问通过 Extension UI 事件流交给 Owner */
class PiAgentSessionWrapperImpl {
    inner;
    listeners = [];
    pendingUi = null;
    extensionUiQueue = [];
    promptRunning = false;
    extensionsBound = false;
    extensionBindingPromise = null;
    unsubscribe = null;
    idleTimer = null;
    onDestroyCallback = null;
    shutdownPromise = null;
    projectTrustResolver = null;
    projectTrustPromise = null;
    _alive = true;
    constructor(inner) {
        this.inner = inner;
    }
    get sessionId() {
        return this.inner.sessionId;
    }
    isAlive() {
        return this._alive;
    }
    isRunning() {
        return (this._alive &&
            (this.promptRunning ||
                this.inner.isStreaming ||
                this.inner.isCompacting ||
                this.pendingUi !== null ||
                this.extensionUiQueue.length > 0));
    }
    start() {
        this.unsubscribe = this.inner.subscribe((event) => {
            const projected = (0, event_projector_js_1.projectPiEvent)(event, this.sessionId);
            if (!projected)
                return;
            if (IDLE_RESET_EVENT_TYPES.has(event.type))
                this.resetIdleTimer();
            this.emit(projected);
        });
        this.resetIdleTimer();
        this.beginExtensionBinding();
    }
    onEvent(listener) {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i !== -1)
                this.listeners.splice(i, 1);
        };
    }
    emit(event) {
        const withSession = {
            ...event,
            sessionId: this.sessionId,
        };
        for (const l of this.listeners)
            l(withSession);
    }
    resetIdleTimer() {
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.isRunning()) {
                this.resetIdleTimer();
                return;
            }
            void this.shutdown().catch(() => { });
        }, IDLE_TIMEOUT_MS);
    }
    beginExtensionBinding() {
        void this.ensureExtensionsBound().catch(() => { });
    }
    ensureExtensionsBound() {
        if (this.extensionsBound)
            return Promise.resolve();
        if (this.extensionBindingPromise)
            return this.extensionBindingPromise;
        this.extensionBindingPromise = (async () => {
            if (!this._alive)
                return;
            const uiContext = this.createExtensionUiContext();
            if (typeof this.inner.bindExtensions === "function") {
                await this.inner.bindExtensions.call(this.inner, {
                    uiContext,
                    mode: "rpc",
                    onError: (error) => {
                        this.emit({
                            type: "status_update",
                            sessionId: this.sessionId,
                            status: `extension_error: ${error.extensionPath}`,
                        });
                    },
                });
            }
            else {
                this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
            }
            this.extensionsBound = true;
        })().catch((err) => {
            throw err;
        });
        return this.extensionBindingPromise;
    }
    async send(action, payload = {}) {
        if (!this._alive)
            throw new Error("Session is closed");
        this.resetIdleTimer();
        switch (action) {
            case "agent.prompt": {
                const message = payload.prompt;
                const images = Array.isArray(payload.images)
                    ? payload.images
                    : undefined;
                const streamingBehavior = payload.streamingBehavior;
                this.promptRunning = true;
                this.inner
                    .prompt(message, {
                    ...(images?.length ? { images } : {}),
                    ...(streamingBehavior ? { streamingBehavior } : {}),
                    source: "rpc",
                })
                    .then(() => {
                    this.promptRunning = false;
                    this.resetIdleTimer();
                    this.emit({ type: "prompt_done", sessionId: this.sessionId });
                })
                    .catch((error) => {
                    this.promptRunning = false;
                    this.resetIdleTimer();
                    this.emit({
                        type: "prompt_error",
                        sessionId: this.sessionId,
                        code: "PI_RUNTIME_UNAVAILABLE",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
                return null;
            }
            case "agent.steer":
                await this.inner.steer(payload.message);
                return null;
            case "agent.followUp":
                await this.inner.followUp(payload.message);
                return null;
            case "agent.abort": {
                const queued = this.extensionUiQueue.splice(0);
                for (const pending of queued) {
                    pending.resolve(pending.request.kind === "confirm" ? false : undefined);
                }
                if (this.pendingUi) {
                    this.finishExtensionUi(this.pendingUi.request.requestId, "cancelled", this.pendingUi.request.kind === "confirm" ? false : undefined);
                }
                await this.inner.abort();
                await this.waitForStopped(5_000);
                return null;
            }
            case "agent.compact":
                return this.inner.compact(typeof payload.customInstructions === "string"
                    ? payload.customInstructions
                    : undefined);
            case "agent.abortCompact":
                this.inner.abortCompaction();
                return null;
            case "agent.state":
                return this.getState();
            case "agent.stats":
                return this.inner.getSessionStats();
            case "agent.commands":
                return this.getCommands();
            case "models.list":
                return this.listModels();
            case "model.set": {
                const provider = payload.provider;
                const modelId = payload.modelId;
                const models = (await this.listModels());
                const allowed = models.some((m) => m.provider === provider && m.modelId === modelId);
                if (!allowed) {
                    return {
                        ok: false,
                        error: {
                            code: "PI_MODEL_NOT_FOUND",
                            message: `Model not found: ${provider}/${modelId}`,
                        },
                    };
                }
                const model = this.inner.modelRuntime.getModel(provider, modelId);
                if (!model) {
                    return {
                        ok: false,
                        error: {
                            code: "PI_MODEL_NOT_FOUND",
                            message: `Model not found: ${provider}/${modelId}`,
                        },
                    };
                }
                await this.inner.setModel(model);
                return { ok: true, data: { provider, modelId } };
            }
            case "thinking.set": {
                if (!(0, shared_1.isPiThinkingLevel)(payload.level)) {
                    return {
                        ok: false,
                        error: {
                            code: "PI_PROTOCOL_INVALID",
                            message: "Invalid thinking level",
                        },
                    };
                }
                this.inner.setThinkingLevel(payload.level);
                return null;
            }
            case "session.rename": {
                const name = payload.name?.trim();
                if (!name) {
                    return {
                        ok: false,
                        error: {
                            code: "PI_PROTOCOL_INVALID",
                            message: "Session name cannot be empty",
                        },
                    };
                }
                this.inner.setSessionName(name);
                return { ok: true };
            }
            case "session.fork":
                return this.fork(payload.entryId);
            case "session.clone":
                return this.clone();
            case "session.navigate": {
                const result = await this.inner.navigateTree(payload.targetId, {});
                return { cancelled: result.cancelled };
            }
            case "extension.respond": {
                this.resolveExtensionUiResponse(payload);
                return null;
            }
            default:
                return {
                    ok: false,
                    error: {
                        code: "PI_PROTOCOL_INVALID",
                        message: `Unsupported action: ${action}`,
                    },
                };
        }
    }
    async listModels() {
        const available = (await this.inner.modelRuntime.getAvailable());
        const enabled = this.inner.settingsManager.getEnabledModels();
        if (!enabled || enabled.length === 0) {
            return available.map((m) => ({ provider: m.provider, modelId: m.id }));
        }
        const { scopedModels } = await (await getSdk()).resolveModelScopeWithDiagnostics(enabled, this.inner.modelRuntime);
        const allowed = new Set(scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
        return available
            .filter((m) => allowed.has(`${m.provider}/${m.id}`))
            .map((m) => ({ provider: m.provider, modelId: m.id }));
    }
    async getCommands() {
        const commands = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
            commands.push({
                name: registered.invocationName,
                description: registered.description,
                source: "extension",
                sourceInfo: registered.sourceInfo,
            });
        }
        for (const template of this.inner.promptTemplates) {
            commands.push({
                name: template.name,
                description: template.description,
                source: "prompt",
                sourceInfo: template.sourceInfo,
            });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
            commands.push({
                name: `skill:${skill.name}`,
                description: skill.description,
                source: "skill",
                sourceInfo: skill.sourceInfo,
            });
        }
        return { commands };
    }
    getState() {
        const waiting = this.pendingUi !== null;
        let status;
        if (this.inner.isCompacting) {
            status = "compacting";
        }
        else if (waiting) {
            status = "waiting_for_extension_input";
        }
        else if (this.isRunning()) {
            status = "running";
        }
        else {
            status = "idle";
        }
        return {
            status,
            streaming: this.inner.isStreaming,
            prompting: this.promptRunning,
            compacting: this.inner.isCompacting,
            thinkingLevel: this.inner.thinkingLevel,
            queuedMessages: {
                steering: [...this.inner.getSteeringMessages()],
                followUp: [...this.inner.getFollowUpMessages()],
            },
            ...(this.inner.model
                ? {
                    model: {
                        provider: this.inner.model.provider,
                        modelId: this.inner.model.id,
                    },
                }
                : {}),
            waitingForExtensionInput: waiting,
            ...(this.pendingUi
                ? { pendingExtension: { ...this.pendingUi.request } }
                : {}),
        };
    }
    async fork(entryId) {
        if (this.inner.isCompacting)
            return { cancelled: true };
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted() || !currentSessionFile)
            return { cancelled: true };
        const entry = sessionManager.getEntry(entryId);
        if (!entry)
            return { cancelled: true };
        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile;
        if (entry.parentId) {
            // 历史中 fork：复制到 fork 点之前
            const sourceManager = (await getSdk()).SessionManager.open(currentSessionFile, sessionDir);
            const forkedPath = sourceManager.createBranchedSession(entry.parentId);
            if (!forkedPath)
                return { cancelled: true };
            newSessionFile = forkedPath;
        }
        else {
            // 首条消息前 fork：创建指向当前 Session 的空 Session
            const newManager = (await getSdk()).SessionManager.create(sessionManager.getCwd(), sessionDir);
            newManager.newSession({ parentSession: currentSessionFile });
            newSessionFile = newManager.getSessionFile();
        }
        const newSessionId = (await getSdk()).SessionManager.open(newSessionFile, sessionDir).getSessionId();
        await this.shutdown();
        return { cancelled: false, newSessionId };
    }
    async clone() {
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted() || !currentSessionFile)
            return { cancelled: true };
        const leafId = sessionManager.getLeafId();
        if (!leafId)
            return { cancelled: true };
        const newPath = sessionManager.createBranchedSession(leafId);
        if (!newPath)
            return { cancelled: true };
        const newSessionId = (await getSdk()).SessionManager.open(newPath, sessionManager.getSessionDir()).getSessionId();
        await this.shutdown();
        return { cancelled: false, newSessionId };
    }
    // ── Extension UI ──
    createExtensionUiContext() {
        const ctx = {
            select: (title, options, opts) => this.requestExtensionUi("select", title, { options }, opts?.timeout),
            confirm: (title, message, opts) => this.requestExtensionUi("confirm", title, { message }, opts?.timeout),
            input: (title, placeholder, opts) => this.requestExtensionUi("input", title, { placeholder }, opts?.timeout),
            editor: (title, prefill, opts) => this.requestExtensionUi("editor", title, { prefill }, opts?.timeout),
            notify: (message, type) => {
                this.emitUi({
                    kind: "notify",
                    title: undefined,
                    message,
                    ...(type ? { message: `${type}: ${message}` } : {}),
                });
            },
            setStatus: (key, text) => {
                this.emitUi({ kind: "setStatus", title: key, message: text });
            },
            setWidget: (key, content, options) => {
                if (content !== undefined && !Array.isArray(content))
                    return;
                this.emitUi({
                    kind: "setWidget",
                    title: key,
                    message: Array.isArray(content) ? content.join("\n") : undefined,
                    ...(options?.placement ? { options: [options.placement] } : {}),
                });
            },
            setTitle: (title) => {
                this.emitUi({ kind: "setTitle", title, message: undefined });
            },
            pasteToEditor: (text) => {
                this.emitUi({
                    kind: "set_editor_text",
                    title: undefined,
                    message: text,
                });
            },
            setEditorText: (text) => {
                this.emitUi({
                    kind: "set_editor_text",
                    title: undefined,
                    message: text,
                });
            },
            custom: () => {
                this.emitUi({
                    kind: "notify",
                    title: "Custom UI",
                    message: "custom UI 不支持",
                });
                return Promise.resolve(undefined);
            },
            getEditorText: () => "",
            getAllThemes: () => [],
            getTheme: () => undefined,
            setTheme: () => ({ success: false, error: "unsupported" }),
        };
        return ctx;
    }
    emitUi(req) {
        const ui = {
            requestId: (0, node_crypto_1.randomUUID)(),
            extensionId: "",
            kind: req.kind,
            ...(req.title ? { title: req.title } : {}),
            ...(req.message ? { message: req.message } : {}),
            ...(req.options?.length ? { options: req.options } : {}),
        };
        this.emit({ type: "extension_request", sessionId: this.sessionId, ui });
    }
    requestExtensionUi(kind, title, extra, explicitTimeout) {
        const requestId = (0, node_crypto_1.randomUUID)();
        const timeoutMs = explicitTimeout ?? DEFAULT_UI_TIMEOUT_MS;
        const ui = {
            requestId,
            extensionId: "",
            kind,
            title,
            ...(typeof extra.message === "string" ? { message: extra.message } : {}),
            ...(Array.isArray(extra.options)
                ? { options: extra.options }
                : {}),
            ...(typeof extra.placeholder === "string"
                ? { message: extra.placeholder }
                : {}),
            ...(typeof extra.prefill === "string" ? { message: extra.prefill } : {}),
            timeoutMs,
        };
        return new Promise((resolve) => {
            this.extensionUiQueue.push({
                request: ui,
                resolve,
                timeoutMs,
                timer: null,
            });
            this.activateNextExtensionUi();
        });
    }
    activateNextExtensionUi() {
        if (this.pendingUi || this.extensionUiQueue.length === 0)
            return;
        const pending = this.extensionUiQueue.shift();
        this.pendingUi = pending;
        pending.timer = setTimeout(() => {
            this.finishExtensionUi(pending.request.requestId, "timeout", pending.request.kind === "confirm" ? false : undefined);
        }, pending.timeoutMs);
        this.emit({
            type: "extension_request",
            sessionId: this.sessionId,
            ui: pending.request,
        });
    }
    finishExtensionUi(requestId, reason, value) {
        const pending = this.pendingUi;
        if (!pending || pending.request.requestId !== requestId)
            return;
        this.pendingUi = null;
        if (pending.timer)
            clearTimeout(pending.timer);
        pending.timer = null;
        pending.resolve(value);
        this.emit({
            type: "extension_resolved",
            sessionId: this.sessionId,
            requestId,
            reason,
            hasPending: this.extensionUiQueue.length > 0,
        });
        this.activateNextExtensionUi();
    }
    resolveExtensionUiResponse(payload) {
        const requestId = payload.requestId;
        const pending = this.pendingUi;
        if (!requestId || !pending || pending.request.requestId !== requestId)
            return;
        if (payload.cancelled === true) {
            this.finishExtensionUi(requestId, "cancelled", pending.request.kind === "confirm" ? false : undefined);
            return;
        }
        this.finishExtensionUi(requestId, "answered", pending.request.kind === "confirm"
            ? payload.confirmed === true
            : typeof payload.value === "string"
                ? payload.value
                : undefined);
    }
    setProjectTrustResolver(resolver) {
        this.projectTrustResolver = resolver;
    }
    async ensureProjectTrust() {
        if (!this.projectTrustResolver)
            return false;
        if (!this.projectTrustPromise) {
            this.projectTrustPromise = this.projectTrustResolver((message) => this.askConfirm(message));
        }
        return this.projectTrustPromise;
    }
    /** Project Trust confirm：通过 Extension UI 事件流交给 Owner */
    async askConfirm(message) {
        const value = await this.requestExtensionUi("confirm", "Project Trust", { message }, undefined);
        return value === true;
    }
    // ── 生命周期 ──
    async waitForStopped(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (this.promptRunning ||
            this.inner.isStreaming ||
            this.inner.isCompacting ||
            this.pendingUi ||
            this.extensionUiQueue.length > 0) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw Object.assign(new Error("Pi session did not stop in time"), {
                    code: "PI_REQUEST_TIMEOUT",
                });
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
        }
    }
    async shutdown() {
        if (this.shutdownPromise)
            return this.shutdownPromise;
        if (!this._alive)
            return;
        this.shutdownPromise = (async () => {
            try {
                try {
                    if (this.extensionBindingPromise)
                        await this.extensionBindingPromise;
                }
                catch {
                    // 忽略绑定失败，继续销毁
                }
                await this.inner.extensionRunner.emit?.({
                    type: "session_shutdown",
                    reason: "quit",
                });
            }
            finally {
                this.destroy();
            }
        })();
        return this.shutdownPromise;
    }
    destroy() {
        if (!this._alive)
            return;
        this._alive = false;
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.unsubscribe?.();
        const queued = this.extensionUiQueue.splice(0);
        for (const pending of queued) {
            pending.resolve(pending.request.kind === "confirm" ? false : undefined);
        }
        if (this.pendingUi) {
            this.finishExtensionUi(this.pendingUi.request.requestId, "cancelled", this.pendingUi.request.kind === "confirm" ? false : undefined);
        }
        try {
            this.inner.dispose();
        }
        finally {
            this.onDestroyCallback?.();
        }
    }
    onDestroy(cb) {
        this.onDestroyCallback = cb;
    }
}
exports.PiAgentSessionWrapperImpl = PiAgentSessionWrapperImpl;
