/** 浏览器端 crypto 桩（仅 atomic-file 使用，不接线）。 */
export const randomUUID = (): string => {
	throw new Error("crypto.randomUUID 不可用于浏览器渲染层（本地文件功能未接线）");
};
