/** CLI 长选项解析结果。 */
export interface ParsedCommandArgs {
	positionals: string[];
	/** 单值/布尔选项；multiValue 选项不出现在这里。 */
	options: Record<string, string | true>;
	/** multiValue 选项按出现顺序收集；未出现的键不存在。 */
	multi: Record<string, string[]>;
}

/**
 * 解析 `--name=value`、`--name value`、布尔长选项与可重复的 multiValue 选项。
 * 未声明、重复（multiValue 除外）或缺值选项会明确失败，避免静默拼写错误。
 * 裸 `--` 为分隔符：其后所有参数原样作为位置参数，不再解析选项。
 */
export function parseCommandArgs(
	argv: string[],
	schema: {
		value?: readonly string[];
		boolean?: readonly string[];
		/** 可重复出现的选项；与 value/boolean 同名视为声明冲突。 */
		multiValue?: readonly string[];
	} = {},
): ParsedCommandArgs {
	const valueOptions = new Set(schema.value ?? []);
	const booleanOptions = new Set(schema.boolean ?? []);
	const multiOptions = new Set(schema.multiValue ?? []);
	for (const name of multiOptions) {
		if (valueOptions.has(name) || booleanOptions.has(name)) {
			throw new Error(`选项声明冲突: --${name}`);
		}
	}
	const options: Record<string, string | true> = {};
	const multi: Record<string, string[]> = {};
	const positionals: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const parsed = parseLongOption(arg);
		assertKnownOption(parsed.name, valueOptions, booleanOptions, multiOptions);
		const inline = parsed.inlineValue !== undefined;
		if (multiOptions.has(parsed.name)) {
			const value = requireOptionValue(
				parsed.name,
				inline ? parsed.inlineValue : argv[++index],
				inline,
			);
			let list = multi[parsed.name];
			if (!list) {
				list = [];
				multi[parsed.name] = list;
			}
			list.push(value);
			continue;
		}
		if (Object.hasOwn(options, parsed.name)) {
			throw new Error(`选项不能重复: --${parsed.name}`);
		}
		if (booleanOptions.has(parsed.name)) {
			if (inline) {
				throw new Error(`布尔选项不接受值: --${parsed.name}`);
			}
			options[parsed.name] = true;
			continue;
		}
		options[parsed.name] = requireOptionValue(
			parsed.name,
			inline ? parsed.inlineValue : argv[++index],
			inline,
		);
	}

	return { positionals, options, multi };
}

function parseLongOption(arg: string): {
	name: string;
	inlineValue?: string;
} {
	const raw = arg.slice(2);
	const separator = raw.indexOf("=");
	return separator >= 0
		? { name: raw.slice(0, separator), inlineValue: raw.slice(separator + 1) }
		: { name: raw };
}

function assertKnownOption(
	name: string,
	valueOptions: ReadonlySet<string>,
	booleanOptions: ReadonlySet<string>,
	multiOptions: ReadonlySet<string>,
): void {
	if (
		!name ||
		(!valueOptions.has(name) &&
			!booleanOptions.has(name) &&
			!multiOptions.has(name))
	) {
		throw new Error(`未知选项: --${name}`);
	}
}

function requireOptionValue(
	name: string,
	value: string | undefined,
	inline: boolean,
): string {
	if (
		value === undefined ||
		value.length === 0 ||
		(!inline && value.startsWith("--"))
	) {
		throw new Error(`选项缺少值: --${name}`);
	}
	return value;
}

/** 读取字符串选项。 */
export function stringOption(
	options: Record<string, string | true>,
	name: string,
): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}
