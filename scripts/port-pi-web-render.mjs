#!/usr/bin/env node
/**
 * 把 examples/pi-web 的渲染层闭包拷入 packages/frontend/src/pi-web/。
 * 唯一允许的源改动：把 "@/"、'@/' 说明符改写为相对路径（ADR-0032 路径解析例外）。
 * 上游更新后重跑本脚本即可重新对账同步（手动 cherry-pick 的执行面）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const src = join(repoRoot, "examples/pi-web");
const dst = join(repoRoot, "packages/frontend/src/pi-web");

/** 渲染层闭包（由 import 图枚举，含 type-only 依赖；新增传递依赖时扩充此数组） */
const files = [
  "components/AnsiText.tsx",
  "components/ExtensionWidgets.tsx",
  "components/FileIcons.tsx",
  "components/ImagePreview.tsx",
  "components/MarkdownBody.tsx",
  "components/MermaidBlock.tsx",
  "components/MessageView.tsx",
  "components/ThinkingIcon.tsx",
  "components/TurnWrittenFiles.tsx",
  "hooks/useI18n.tsx",
  "hooks/useTheme.ts",
  "lib/apply-patch.ts",
  "lib/atomic-file.ts",
  "lib/clipboard.ts",
  "lib/compaction-summary.ts",
  "lib/file-links.ts",
  "lib/file-paths.ts",
  "lib/frontmatter.ts",
  "lib/i18n/format.ts",
  "lib/i18n/messages/en.ts",
  "lib/i18n/messages/zh-CN.ts",
  "lib/i18n/messages/zh-TW.ts",
  "lib/i18n/registry.ts",
  "lib/i18n/types.ts",
  "lib/markdown.ts",
  "lib/message-display.ts",
  "lib/patch.ts",
  "lib/path-security.ts",
  "lib/subagent-profile-precedence.ts",
  "lib/paths.ts",
  "lib/slash-display.ts",
  "lib/subagent-extension.ts",
  "lib/subagent-input.ts",
  "lib/subagents.ts",
  "lib/theme.ts",
  "lib/thinking-expansion-preference.ts",
  "lib/tool-call-expansion.ts",
  "lib/tool-names.ts",
  "lib/tool-presets.ts",
  "lib/turn-written-files.ts",
  "lib/types.ts",
];

/** 目标文件所在目录 → 子树根的相对前缀（POSIX 分隔符） */
function relPrefix(targetAbs) {
  const rel = relative(dirname(targetAbs), dst).split(sep).join("/");
  return rel === "" ? "." : rel;
}

function portFile(relPath) {
  const from = join(src, relPath);
  const to = join(dst, relPath);
  mkdirSync(dirname(to), { recursive: true });
  const prefix = relPrefix(to);
  let text = readFileSync(from, "utf8")
    .replaceAll('"@/', `"${prefix}/`)
    .replaceAll("'@/", `'${prefix}/`);
  text = applyVcpPatches(relPath, text);
  writeFileSync(to, text);
}

/**
 * VCPDeck 补丁规则（ADR-0032：上游子树可重跑覆盖，因此补丁必须声明在这里，不能手改产物）。
 *
 * 每条规则必须命中，否则直接失败：上游改名/改结构时立刻暴露，而不是静默丢掉注入点。
 */
const VCP_PATCHES = {
  "components/MessageView.tsx": [
    {
      // thinking 惰性取数：宿主未注入时回退上游自己的本地接口
      insertBefore:
        "function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {",
      text: `/** VCPDeck 补丁（scripts/port-pi-web-render.mjs）：把 thinking 取数交给宿主注入点。 */
function vcpdeckThinkingRequest(sessionId: string, entryId: string, blockIndex: number): Promise<Response> {
  const injected = (globalThis as { __vcpdeckLoadThinking?: (s: string, e: string, b: number) => Promise<string> })
    .__vcpdeckLoadThinking;
  if (!injected) {
    return fetch(
      \`/api/sessions/\${encodeURIComponent(sessionId)}/entries/\${encodeURIComponent(entryId)}/thinking?blockIndex=\${blockIndex}\`,
    );
  }
  return injected(sessionId, entryId, blockIndex).then(
    (thinking) => new Response(JSON.stringify({ thinking }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

`,
    },
    {
      find: [
        "  const request = fetch(",
        "    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,",
        "  ).then(async (response) => {",
      ].join("\n"),
      replace:
        "  const request = vcpdeckThinkingRequest(sessionId, entryId, blockIndex).then(async (response) => {",
    },
  ],
};

function applyVcpPatches(relPath, text) {
  const rules = VCP_PATCHES[relPath];
  if (!rules) return text;
  let out = text;
  for (const rule of rules) {
    if (rule.insertBefore) {
      if (!out.includes(rule.insertBefore)) {
        throw new Error(`[port-pi-web-render] 补丁锚点缺失: ${relPath} :: ${rule.insertBefore}`);
      }
      out = out.replace(rule.insertBefore, `${rule.text}${rule.insertBefore}`);
      continue;
    }
    if (!out.includes(rule.find)) {
      throw new Error(`[port-pi-web-render] 补丁目标缺失: ${relPath} :: ${rule.find}`);
    }
    out = out.replaceAll(rule.find, rule.replace);
  }
  return out;
}

for (const file of files) {
  portFile(file);
  // 同名上游测试一并拷入（同样相对化）
  const testFile = file.replace(/\.tsx?$/, ".test.mjs");
  if (existsSync(join(src, testFile))) portFile(testFile);
}

/** 源文本夹具：ImagePreview.test 直接读其源码做断言；不接线、不拷其测试（Composer 属范围 A 之外） */
for (const file of ["components/ChatInput.tsx", "app/globals.css"]) {
  portFile(file);
}

// 样式：globals.css 原样拷入，仅去掉 xterm import（Terminal 不在渲染层）
const css = readFileSync(join(src, "app/globals.css"), "utf8")
  .replace('@import "@xterm/xterm/css/xterm.css";', "");
writeFileSync(join(dst, "styles.css"), css.trimStart());

// 许可合规（ADR-0032 决策 4）
cpSync(join(src, "LICENSE"), join(dst, "LICENSE"));
console.log(`ported ${files.length} closure files (+tests, styles, LICENSE) -> ${dst}`);
