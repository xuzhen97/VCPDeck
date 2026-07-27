import type { FileListResult } from "@vcpdeck/shared";
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@/api/context";

type FileEntry = FileListResult["entries"][number];

/** 管理 `file.roots` 驱动的远程文件浏览状态。 */
export function useFileBrowser(clientId: string) {
	const sdk = useSdk();
	const [roots, setRoots] = useState<string[]>([]);
	const [selectedRoot, setSelectedRoot] = useState<string>();
	const [path, setPath] = useState(".");
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [selectedEntry, setSelectedEntry] = useState<FileEntry>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>();
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		sdk.files
			.roots(clientId, controller.signal)
			.then(setRoots)
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(reason);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [clientId, sdk]);

	useEffect(() => {
		if (!selectedRoot) return;
		const controller = new AbortController();
		setLoading(true);
		setError(undefined);
		sdk.files
			.list(clientId, selectedRoot, path, controller.signal)
			.then((result) => {
				setEntries(result.entries);
				setSelectedEntry(undefined);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(reason);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [clientId, path, revision, sdk, selectedRoot]);

	const selectRoot = useCallback((root: string) => {
		setSelectedRoot(root);
		setPath(".");
	}, []);
	const enter = useCallback(
		(name: string) =>
			setPath((current) => (current === "." ? name : `${current}/${name}`)),
		[],
	);
	const up = useCallback(
		() =>
			setPath((current) =>
				current === "." || !current.includes("/")
					? "."
					: current.slice(0, current.lastIndexOf("/")),
			),
		[],
	);
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	return {
		roots,
		selectedRoot,
		path,
		entries,
		selectedEntry,
		loading,
		error,
		selectRoot,
		enter,
		up,
		refresh,
		select: setSelectedEntry,
	};
}
