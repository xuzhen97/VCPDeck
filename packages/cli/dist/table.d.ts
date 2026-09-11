interface TableRow extends Record<string, string> {
}
/** 无依赖的简易对齐表格；首行为表头。 */
export declare function formatTable(rows: TableRow[], columns: string[]): string;
export {};
