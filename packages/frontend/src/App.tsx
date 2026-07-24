import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { LoginPage } from "./LoginPage";
import { DashboardPage } from "./DashboardPage";
import { TokensPage } from "./TokensPage";
import { IdentitiesPage } from "./IdentitiesPage";

function AppRoutes() {
  const { identity, loading } = useAuth();

  if (loading) return <p>Loading...</p>;

  if (!identity) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/tokens" element={<TokensPage />} />
      {identity.isAdmin && <Route path="/identities" element={<IdentitiesPage />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
