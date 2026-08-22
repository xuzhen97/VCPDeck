interface TableRow extends Record<string, string> {}

/** 无依赖的简易对齐表格；首行为表头。 */
export function formatTable(rows: TableRow[], columns: string[]): string {
	const widths = columns.map((column) =>
		Math.max(column.length, ...rows.map((row) => row[column].length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, index) => cell.padEnd(widths[index]))
			.join("  ")
			.trimEnd();
	return [
		line(columns.map((column) => column.toUpperCase())),
		...rows.map((row) => line(columns.map((column) => row[column]))),
	].join("\n");
}
