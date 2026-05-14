import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { axios, unwrap, setAuthToken } from '../api.js';
import { persistSession } from '../session.js';

export default function LoginPage({ onLoggedIn }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!identifier.trim() || !password) {
      setError('Email/username and password are required.');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post(
        '/api/auth/login',
        { identifier, password },
        { params: { populate: 'customRole.permissions' } }
      );
      const payload = unwrap(res);
      const token = payload?.token;
      const user = payload?.user;
      if (!token || !user) throw new Error('Invalid login response');
      persistSession(token, user);
      setAuthToken(token);
      onLoggedIn();
      navigate('/', { replace: true });
    } catch (err) {
      let msg =
        err.response?.data?.message ||
        err.response?.data?.msg ||
        err.message ||
        'Login failed';
      if (err.code === 'ERR_NETWORK' || err.message === 'Network Error') {
        msg = import.meta.env.DEV
          ? 'Cannot reach the API. Start the Coolgix backend (default port 5000). In dev, /api is proxied — set VITE_DEV_PROXY_TARGET in coolgix-pwa-dashboard/.env if your API uses another host/port. For a remote API in dev, set VITE_DEV_USE_REMOTE_API.'
          : 'Cannot reach the API. Rebuild with the correct VITE_API_URL, or check that the server is up.';
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">Coolgix</div>
        <p className="login-sub">Warehouse monitor (PWA)</p>
        {error ? <div className="login-error">{error}</div> : null}
        <label className="field">
          <span>Email or username</span>
          <input
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="login-hint">
          Point <code>VITE_API_URL</code> at your Coolgix API (same as the web app).
        </p>
      </form>
      <style>{`
        .login-wrap {
          min-height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1.25rem;
          background: radial-gradient(120% 80% at 50% 0%, rgba(117, 81, 255, 0.35), transparent),
            var(--cg-bg);
        }
        .login-card {
          width: 100%;
          max-width: 380px;
          background: var(--cg-surface);
          border-radius: var(--cg-radius);
          padding: 1.75rem;
          box-shadow: var(--cg-shadow);
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .login-brand {
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--cg-primary);
          letter-spacing: -0.02em;
        }
        .login-sub {
          margin: 0.35rem 0 1.25rem;
          color: var(--cg-muted);
          font-size: 0.9rem;
        }
        .login-error {
          background: rgba(239, 68, 68, 0.12);
          color: #fecaca;
          padding: 0.65rem 0.75rem;
          border-radius: 10px;
          font-size: 0.875rem;
          margin-bottom: 1rem;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          margin-bottom: 1rem;
          font-size: 0.8rem;
          color: var(--cg-muted);
        }
        .field input {
          padding: 0.7rem 0.85rem;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: var(--cg-surface-2);
          color: var(--cg-text);
        }
        .field input:focus {
          outline: 2px solid rgba(57, 184, 255, 0.45);
          border-color: transparent;
        }
        .btn-primary {
          width: 100%;
          margin-top: 0.25rem;
          padding: 0.85rem;
          border: none;
          border-radius: 12px;
          font-weight: 600;
          cursor: pointer;
          background: linear-gradient(135deg, var(--cg-primary), #5b3fd9);
          color: #fff;
        }
        .btn-primary:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }
        .login-hint {
          margin-top: 1.25rem;
          font-size: 0.75rem;
          color: var(--cg-muted);
          line-height: 1.4;
        }
        .login-hint code {
          font-size: 0.7rem;
          color: var(--cg-secondary);
        }
      `}</style>
    </div>
  );
}
