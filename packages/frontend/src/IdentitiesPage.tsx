import { useState, useEffect } from "react";
import { api } from "./api";
import { Link } from "react-router-dom";

interface Identity {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
}

export function IdentitiesPage() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const load = async () => {
    setIdentities(await api.listIdentities());
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!username.trim() || !password.trim()) return;
    await api.createIdentity({ username, password, displayName: displayName || username });
    setUsername("");
    setPassword("");
    setDisplayName("");
    load();
  };

  return (
    <div>
      <h1>Manage Identities</h1>
      <Link to="/">Back</Link>

      <h2>Create Identity</h2>
      <div>
        <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display Name" />
        <button onClick={handleCreate}>Create</button>
      </div>

      <h2>All Identities</h2>
      <table border={1} cellPadding={6}>
        <thead>
          <tr>
            <th>Username</th>
            <th>DisplayName</th>
            <th>Admin</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {identities.map((i) => (
            <tr key={i.id}>
              <td>{i.username}</td>
              <td>{i.displayName}</td>
              <td>{i.isAdmin ? "Yes" : "No"}</td>
              <td>{i.disabledAt ? "Disabled" : "Active"}</td>
              <td>
                {i.disabledAt ? (
                  <button onClick={() => api.enableIdentity(i.id).then(load)}>Enable</button>
                ) : (
                  <button onClick={() => api.disableIdentity(i.id).then(load)}>Disable</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
