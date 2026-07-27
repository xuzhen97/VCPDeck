import type { IdentityInfo, LoginRequest } from "@vcpdeck/shared";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { useSdk } from "@/api/context";

export interface AuthState {
	identity: IdentityInfo | null;
	phase: "checking" | "authenticated" | "unauthenticated";
	login(input: LoginRequest): Promise<void>;
	logout(): Promise<void>;
	handleUnauthorized(): void;
}

const AuthContext = createContext<AuthState | null>(null);

/** 管理 Cookie 身份状态。 */
export function AuthProvider({ children }: { children: ReactNode }) {
	const sdk = useSdk();
	const [identity, setIdentity] = useState<IdentityInfo | null>(null);
	const [phase, setPhase] = useState<AuthState["phase"]>("checking");

	useEffect(() => {
		const controller = new AbortController();
		sdk.auth
			.me(controller.signal)
			.then((value) => {
				setIdentity(value);
				setPhase("authenticated");
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					setIdentity(null);
					setPhase("unauthenticated");
				}
			});
		return () => controller.abort();
	}, [sdk]);

	const login = useCallback(
		async (input: LoginRequest) => {
			const response = await sdk.auth.login(input);
			setIdentity(response.identity as IdentityInfo);
			setPhase("authenticated");
		},
		[sdk],
	);
	const logout = useCallback(async () => {
		try {
			await sdk.auth.logout();
		} finally {
			setIdentity(null);
			setPhase("unauthenticated");
		}
	}, [sdk]);
	const handleUnauthorized = useCallback(() => {
		setIdentity(null);
		setPhase("unauthenticated");
	}, []);
	const value = useMemo<AuthState>(
		() => ({ identity, phase, login, logout, handleUnauthorized }),
		[handleUnauthorized, identity, login, logout, phase],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 读取当前认证状态。 */
export function useAuth(): AuthState {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth must be used within AuthProvider");
	return value;
}
