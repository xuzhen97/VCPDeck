import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Cordis 插件标识。 */
export const name = "vcpdeck-skill";

/** 依赖宿主技能注册表。 */
export const inject = ["skills"];

/** 本插件暴露给宿主的技能名，与共用 SKILL.md 中的 name 保持一致。 */
const SKILL_NAME = "vcpdeck";

/** 技能注册表内的 provider 标识，用于同名技能的优先级与来源判定。 */
const PROVIDER_NAME = "vcpdeck-dsh";

/** 与宿主内置技能同档的 rank，避免压过项目级与用户级技能。 */
const SKILL_RANK = 600;

/** 安装实例内的技能目录；同时作为 resourceBase 暴露给模型。 */
const SKILL_DIR = fileURLToPath(new URL("../skills/vcpdeck", import.meta.url));

/** 共用技能正文，Pi 与 DSH 共用同一份文件。 */
const SKILL_PATH = fileURLToPath(
	new URL("../skills/vcpdeck/SKILL.md", import.meta.url),
);

/** 随包预构建 CLI 的绝对路径，由安装位置计算得出，不接受调用方指定。 */
const CLI_PATH = fileURLToPath(
	new URL("../skills/vcpdeck/vcpdeck.cjs", import.meta.url),
);

/**
 * 解析本仓库受控格式的 frontmatter，只接受顶层 name 与 description。
 * 不引入宽松 YAML 猜测；格式偏离时明确失败，避免把错误元数据带入技能目录。
 * @param {string} raw 技能文件全文
 * @returns {{ name: string, description: string, body: string }}
 */
function parseSkill(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
	if (!match) {
		throw new Error(`vcpdeck-dsh: ${SKILL_PATH} 缺少 YAML frontmatter`);
	}
	const fields = new Map();
	for (const line of match[1].split(/\r?\n/u)) {
		if (line.trim() === "") continue;
		if (/^\s/u.test(line)) {
			throw new Error(
				`vcpdeck-dsh: ${SKILL_PATH} 的 frontmatter 不支持缩进块或折行标量`,
			);
		}
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (/^[>|&*!%@`[\]{}'",]/u.test(value)) {
			throw new Error(
				`vcpdeck-dsh: ${SKILL_PATH} 的 ${key} 使用了不支持的 YAML 指示符`,
			);
		}
		fields.set(key, value);
	}
	if (fields.get("name") !== SKILL_NAME) {
		throw new Error(`vcpdeck-dsh: ${SKILL_PATH} 的 name 必须是 ${SKILL_NAME}`);
	}
	const description = fields.get("description");
	if (typeof description !== "string" || description === "") {
		throw new Error(`vcpdeck-dsh: ${SKILL_PATH} 的 description 不能为空`);
	}
	return {
		name: SKILL_NAME,
		description,
		body: raw.slice(match[0].length).trim(),
	};
}

/**
 * 校验安装构件完整。缺失或不是文件时立即失败，不静默下载、换版本或改用其他 CLI。
 */
function assertResources() {
	for (const path of [SKILL_PATH, CLI_PATH]) {
		let info;
		try {
			info = statSync(path);
		} catch (cause) {
			throw new Error(`vcpdeck-dsh: 安装构件缺失：${path}`, { cause });
		}
		if (!info.isFile()) {
			throw new Error(`vcpdeck-dsh: 安装构件不是文件：${path}`);
		}
	}
}

/**
 * 构造技能 definition，附带随包 CLI 的绝对路径与工作目录约束。
 * 每次加载都重新读取文件，使技能正文改动无需重启即可生效。
 * @param {string} path 技能文件路径
 * @param {AbortSignal} [signal] 宿主取消信号
 * @returns {Promise<object>} 技能 definition
 */
async function buildDefinition(path, signal) {
	const skill = parseSkill(
		await readFile(path, { encoding: "utf8", signal }),
	);
	const { rank: _rank, locator: _locator, ...summary } = buildCandidate(skill);
	return { ...summary, content: `${skill.body}${renderRuntimeBlock()}` };
}

/**
 * 由技能元数据构造 candidate 摘要。definition 与 candidate 必须同源，
 * 否则宿主在用户显式调用路径上会读到缺失的 invocation 并抛错。
 * @param {{ name: string, description: string }} skill 解析后的技能元数据
 * @returns {object} candidate 摘要
 */
function buildCandidate(skill) {
	return {
		name: skill.name,
		description: skill.description,
		invocation: { modelInvocable: true, userInvocable: true },
		source: "bundled",
		provider: PROVIDER_NAME,
		resourceBase: { kind: "directory", path: SKILL_DIR },
		path: SKILL_PATH,
		rank: SKILL_RANK,
		locator: SKILL_PATH,
	};
}

/**
 * 构造附加到技能正文末尾的运行时说明。
 * @returns {string} Markdown 片段
 */
function renderRuntimeBlock() {
	return [
		"",
		"",
		"## 已安装的 VCPDeck CLI",
		"",
		"在宿主当前任务/项目的工作目录下执行以下绝对路径，不要切换到技能目录、插件目录或 VCPDeck 仓库根目录，否则项目级 `.vcpdeck.json` 不再生效。命令执行环境需提供 Node.js 24+。",
		"",
		"```json",
		JSON.stringify({ vcpdeckCli: { node: "node", cli: CLI_PATH } }, null, 2),
		"```",
		"",
	].join("\n");
}

/**
 * 注册 VCPDeck 技能。只提供入口，不保存业务状态、Token 或远程机器信息。
 * @param {{ skills: { registerProvider: Function }, effect: Function }} ctx 宿主上下文
 * @returns {Function} 释放注册的 disposer
 */
export function apply(ctx) {
	assertResources();
	const provider = {
		name: PROVIDER_NAME,
		async list(options = {}) {
			const skill = parseSkill(
				await readFile(SKILL_PATH, { encoding: "utf8", signal: options.signal }),
			);
			return [buildCandidate(skill)];
		},
		async get(candidate, options = {}) {
			const locator = candidate?.locator ?? SKILL_PATH;
			if (locator !== SKILL_PATH) {
				throw new Error(
					"vcpdeck-dsh: 只允许读取本插件安装实例内的技能文件",
				);
			}
			return buildDefinition(locator, options.signal);
		},
	};
	return ctx.effect(() => ctx.skills.registerProvider(() => provider));
}
