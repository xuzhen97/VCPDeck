import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";

export function LoginPage() {
	const { login } = useAuth();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError("");
		try {
			await login(username, password);
		} catch (err: any) {
			setError(err.message || "Login failed");
		}
	};

	return (
		<div>
			<h1>VCPDeck Login</h1>
			<form onSubmit={handleSubmit}>
				{error && <p style={{ color: "red" }}>{error}</p>}
				<div>
					<label>Username </label>
					<input
						type="text"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						required
					/>
				</div>
				<div>
					<label>Password </label>
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
				</div>
				<button type="submit">Login</button>
			</form>
		</div>
	);
}
