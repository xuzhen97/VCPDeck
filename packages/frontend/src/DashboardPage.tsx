import { useAuth } from "./AuthContext";
import { Link } from "react-router-dom";

export function DashboardPage() {
	const { identity, logout } = useAuth();

	return (
		<div>
			<h1>VCPDeck</h1>
			<p>
				Logged in as: {identity?.displayName} ({identity?.username}){" "}
				{identity?.isAdmin ? "[admin]" : ""}
			</p>
			<nav>
				<Link to="/tokens">CLI Tokens</Link>
				{identity?.isAdmin && <Link to="/identities">Manage Identities</Link>}
			</nav>
			<button onClick={logout}>Logout</button>
		</div>
	);
}
