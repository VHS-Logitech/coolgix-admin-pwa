import axios from 'axios';

/**
 * Dev: same-origin /api/... → Vite proxy (vite.config.js). Remote in dev: VITE_DEV_USE_REMOTE_API.
 * Production: default is same-origin /api (host rewrites to real API, e.g. vercel.json) → no CORS.
 * Cross-origin API only if BOTH VITE_API_URL and VITE_USE_DIRECT_API=1 (API must allow your origin).
 */
const devRemote = String(import.meta.env.VITE_DEV_USE_REMOTE_API || '').trim();
const prodConfigured = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '');
const prodUseDirectApi = ['1', 'true', 'yes'].includes(
  String(import.meta.env.VITE_USE_DIRECT_API || '').trim().toLowerCase(),
);

if (import.meta.env.DEV) {
  axios.defaults.baseURL = devRemote || '';
} else if (prodConfigured && prodUseDirectApi) {
  axios.defaults.baseURL = prodConfigured;
} else {
  axios.defaults.baseURL = '';
}

axios.defaults.withCredentials = true;

export function setAuthToken(token) {
  if (token) axios.defaults.headers.common['x-auth-token'] = token;
  else delete axios.defaults.headers.common['x-auth-token'];
}

export function unwrap(res) {
  const body = res?.data;
  if (!body) return null;
  if (Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
  return body;
}

export { axios };
