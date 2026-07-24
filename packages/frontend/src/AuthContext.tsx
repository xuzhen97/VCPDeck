import {
	createContext,
	useContext,
	useState,
	useEffect,
	type ReactNode,
} from "react";
import { api } from "./api";

interface Identity {
	id: string;
	username: string;
	displayName: string;
	isAdmin: boolean;
}

interface AuthState {
	identity: Identity | null;
	loading: boolean;
	login: (username: string, password: string) => Promise<void>;
	logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
	identity: null,
	loading: true,
	login: async () => {},
	logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
	const [identity, setIdentity] = useState<Identity | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		api
			.getMe()
			.then((me) => setIdentity(me))
			.catch(() => setIdentity(null))
			.finally(() => setLoading(false));
	}, []);

	const login = async (username: string, password: string) => {
		const res = await api.login({ username, password });
		setIdentity(res.identity);
	};

	const logout = async () => {
		await api.logout();
		setIdentity(null);
	};

	return (
		<AuthContext.Provider value={{ identity, loading, login, logout }}>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth() {
	return useContext(AuthContext);
}
