import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import { getToken } from './session.js';
import { setAuthToken } from './api.js';

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const t = getToken();
    setAuthToken(t || null);
    setAuthed(Boolean(t));
    setReady(true);
  }, []);

  if (!ready) return null;

  return (
    <Routes>
      <Route path="/login" element={<LoginPage onLoggedIn={() => setAuthed(true)} />} />
      <Route
        path="/"
        element={authed ? <DashboardPage onLogout={() => setAuthed(false)} /> : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to={authed ? '/' : '/login'} replace />} />
    </Routes>
  );
}
