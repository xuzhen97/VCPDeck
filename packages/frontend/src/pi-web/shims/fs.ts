/** 浏览器端 fs 桩：本地文件功能不接线（ADR-0032 决策 3），调用即抛错并由降级护栏兜底。 */
const fail = (name: string) => () => {
	throw new Error(`fs.${name} 不可用于浏览器渲染层（本地文件功能未接线）`);
};
export const readdirSync = fail("readdirSync");
export const renameSync = fail("renameSync");
export const unlinkSync = fail("unlinkSync");
export const writeFileSync = fail("writeFileSync");
export const readFileSync = fail("readFileSync");
export const realpathSync = fail("realpathSync");
export const statSync = fail("statSync");
