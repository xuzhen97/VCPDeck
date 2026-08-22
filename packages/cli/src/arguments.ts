/** CLI 长选项解析结果。 */
export interface ParsedCommandArgs {
	positionals: string[];
	options: Record<string, string | true>;
}

/**
 * 解析 `--name=value`、`--name value` 与布尔长选项。
 * 未声明、重复或缺值选项会明确失败，避免静默拼写错误。
 * 裸 `--` 为分隔符：其后所有参数原样作为位置参数，不再解析选项。
 */
export function parseCommandArgs(
	argv: string[],
	schema: {
		value?: readonly string[];
		boolean?: readonly string[];
	} = {},
): ParsedCommandArgs {
	const valueOptions = new Set(schema.value ?? []);
	const booleanOptions = new Set(schema.boolean ?? []);
	const options: Record<string, string | true> = {};
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
		assertKnownOption(parsed.name, valueOptions, booleanOptions);
		if (Object.hasOwn(options, parsed.name)) {
			throw new Error(`选项不能重复: --${parsed.name}`);
		}
		if (booleanOptions.has(parsed.name)) {
			if (parsed.inlineValue !== undefined) {
				throw new Error(`布尔选项不接受值: --${parsed.name}`);
			}
			options[parsed.name] = true;
			continue;
		}
		const value = parsed.inlineValue ?? argv[++index];
		options[parsed.name] = requireOptionValue(parsed.name, value);
	}

	return { positionals, options };
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
): void {
	if (!name || (!valueOptions.has(name) && !booleanOptions.has(name))) {
		throw new Error(`未知选项: --${name}`);
	}
}

function requireOptionValue(name: string, value: string | undefined): string {
	if (value === undefined || value.startsWith("--") || value.length === 0) {
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
