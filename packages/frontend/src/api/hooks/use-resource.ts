import { VcpDeckApiError } from "@vcpdeck/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth-context";

/** 加载可刷新资源并在卸载时中止请求。 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
	const { handleUnauthorized } = useAuth();
	const [data, setData] = useState<T>();
	const [error, setError] = useState<unknown>();
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [revision, setRevision] = useState(0);
	const hasData = useRef(false);

	useEffect(() => {
		const controller = new AbortController();
		setError(undefined);
		if (hasData.current) setRefreshing(true);
		else setLoading(true);
		load(controller.signal).then((value) => {
			hasData.current = true;
			setData(value);
		}).catch((reason: unknown) => {
			if (controller.signal.aborted) return;
			if (reason instanceof VcpDeckApiError && reason.status === 401) handleUnauthorized();
			setError(reason);
		}).finally(() => {
			if (!controller.signal.aborted) {
				setLoading(false);
				setRefreshing(false);
			}
		});
		return () => controller.abort();
	}, [load, revision, handleUnauthorized]);

	const reload = useCallback(() => setRevision((value) => value + 1), []);
	return { data, error, loading, refreshing, reload };
}
