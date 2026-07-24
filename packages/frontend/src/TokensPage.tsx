import { useState, useEffect } from "react";
import { api } from "./api";
import { Link } from "react-router-dom";

interface Token {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);

  const load = async () => {
    const list = await api.listTokens();
    setTokens(list);
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!label.trim()) return;
    const result = await api.createToken(label.trim());
    setNewToken(result.token);
    setLabel("");
    load();
  };

  const handleRevoke = async (id: string) => {
    await api.revokeToken(id);
    load();
  };

  return (
    <div>
      <h1>CLI Tokens</h1>
      <Link to="/">Back</Link>

      {newToken && (
        <div style={{ border: "2px solid orange", padding: "1rem", margin: "1rem 0" }}>
          <p>
            <strong>New token (shown only once):</strong>
          </p>
          <code>{newToken}</code>
          <br />
          <button onClick={() => setNewToken(null)}>I've saved it</button>
        </div>
      )}

      <div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. office PC)"
        />
        <button onClick={handleCreate}>Generate Token</button>
      </div>

      <ul>
        {tokens.map((t) => (
          <li key={t.id}>
            {t.label} — {t.createdAt.slice(0, 10)}
            {t.revokedAt ? (
              " [revoked]"
            ) : (
              <button onClick={() => handleRevoke(t.id)}>Revoke</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
