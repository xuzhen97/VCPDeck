/** 通过临时 anchor 触发浏览器下载。 */
export function startBrowserDownload(url: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.referrerPolicy = "no-referrer";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
}
