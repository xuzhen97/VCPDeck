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
  const text = readFileSync(from, "utf8")
    .replaceAll('"@/', `"${prefix}/`)
    .replaceAll("'@/", `'${prefix}/`);
  writeFileSync(to, text);
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
