import type { PiExtensionUiSnapshot } from "@vcpdeck/shared";

/**
 * 终端控制字符常量。
 *
 * 用 fromCharCode 构造，避免在源码里出现字面控制字符。
 * 注意：模板字面量会消费反斜杠，因此 ST（ESC + 反斜杠）中的字面反斜杠
 * 需要在模板里写四个，才能让正则最终看到一个转义后的反斜杠。
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** 传给正则的字面反斜杠序列（两个字符：反斜杠 + 反斜杠）。 */
const LITERAL_BACKSLASH = ESC && `\\\\`;

/** OSC：标题设置序列，以 BEL 或 ST 结束。 */
const ANSI_OSC = new RegExp(
	`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}${LITERAL_BACKSLASH})`,
	"g",
);
/** CSI：ESC [ 参数 中间字节 最终字节（颜色、光标移动、清屏等）。 */
const ANSI_CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
/** 其余两字节 ESC 序列。 */
const ANSI_SIMPLE = new RegExp(`${ESC}[@-Z${LITERAL_BACKSLASH}-_]`, "g");
/** 剩余 C0 控制字符与 DEL；保留 \n（换行）与 \t（制表）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 此处匹配 C0 控制字符是有意为之——目的正是把它们从扩展文本中剔除。
const C0_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 扩展文本是**待安全展示的数据**，不是可执行内容。
 *
 * 剔除 ANSI/终端控制序列与 C0 控制字符，使网页展示不依赖终端语义。
 * 调用方必须以纯文本节点渲染，禁止 `dangerouslySetInnerHTML`
 * （ADR-0040 决策 3：文本不执行 HTML/脚本或终端控制序列）。
 */
export function stripExtensionText(text: string): string {
	return text
		.replace(ANSI_OSC, "")
		.replace(ANSI_CSI, "")
		.replace(ANSI_SIMPLE, "")
		.replace(C0_CONTROLS, "");
}

/** 扩展内容按 placement 分区，便于 Composer 在编辑区上下插入。 */
export type PiExtensionPlacement = "aboveEditor" | "belowEditor";

const PLACEMENT_LABEL: Record<PiExtensionPlacement, string> = {
	aboveEditor: "扩展内容（编辑区上方）",
	belowEditor: "扩展内容（编辑区下方）",
};

export function PiExtensionStatus({
	snapshot,
}: {
	snapshot: PiExtensionUiSnapshot | null;
}) {
	if (!snapshot) return null;
	const title = snapshot.title ? stripExtensionText(snapshot.title) : null;
	const statuses = snapshot.statuses
		.map((entry) => ({ key: entry.key, text: stripExtensionText(entry.text) }))
		.filter((entry) => entry.text !== "");
	const above = snapshot.widgets.filter((w) => w.placement === "aboveEditor");
	const below = snapshot.widgets.filter((w) => w.placement !== "aboveEditor");
	if (!title && statuses.length === 0 && snapshot.widgets.length === 0) return null;

	return (
		<div data-testid="pi-extension-status">
			{title ? (
				// 扩展标题只是本页小标题：不得改写浏览器全局标题或持久 Session 名称。
				<h4 className="pi-extension-status__title">{title}</h4>
			) : null}

			{statuses.length > 0 ? (
				<section aria-label="扩展状态" className="pi-extension-status__statuses">
					{statuses.map((entry) => (
						<p key={entry.key} className="pi-extension-status__status">
							<span className="pi-extension-status__key">{entry.key}</span>
							<span className="pi-extension-status__text">{entry.text}</span>
						</p>
					))}
				</section>
			) : null}

			{above.length > 0 ? (
				<section aria-label={PLACEMENT_LABEL.aboveEditor}>
					{above.map((widget) => (
						<pre key={widget.key} className="pi-extension-status__widget">
							{widget.lines.map((line) => stripExtensionText(line)).join("\n")}
						</pre>
					))}
				</section>
			) : null}

			{below.length > 0 ? (
				<section aria-label={PLACEMENT_LABEL.belowEditor}>
					{below.map((widget) => (
						<pre key={widget.key} className="pi-extension-status__widget">
							{widget.lines.map((line) => stripExtensionText(line)).join("\n")}
						</pre>
					))}
				</section>
			) : null}
		</div>
	);
}