/**
 * 历史 thinking 正文的取数注入点（ADR-0032：渲染层复用，翻译点在我们这一侧）。
 *
 * 背景：vendored 的 pi-web `ThinkingBlock` 在展开 deferred 思考块时按需取正文，而它打的是
 * pi-web 自己的本地接口 `/api/sessions/<sessionId>/entries/<entryId>/thinking`——VCPDeck 里
 * 不存在该路径（`/api` 指向 VCPDeck Server）。按 ADR-0032，翻译只能发生在适配层，因此
 * `scripts/port-pi-web-render.mjs` 会把那次请求替换为「先问本注入点，未注入时回退原路径」。
 *
 * 为什么用 `globalThis`：vendored 子树不得 import 我们自己的模块（重跑 port 脚本会覆盖），
 * 只能通过一个约定名字的全局槽位通信。未注入时渲染层保持上游行为（不静默放行、不伪造正文）。
 */
export type PiThinkingLoader = (
	sessionId: string,
	entryId: string,
	blockIndex: number,
) => Promise<string>;

/** 全局槽位名；必须与 port 脚本注入的补丁一致。 */
export const PI_THINKING_LOADER_KEY = "__vcpdeckLoadThinking";

/** 安装/清除 thinking 取数实现；传 null 表示回到上游本地接口（VCPDeck 下会失败并显示不可用）。 */
export function setPiThinkingLoader(loader: PiThinkingLoader | null): void {
	const target = globalThis as Record<string, unknown>;
	if (loader) target[PI_THINKING_LOADER_KEY] = loader;
	else delete target[PI_THINKING_LOADER_KEY];
}
