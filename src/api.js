import axios from 'axios';

/**
 * Dev: browser calls same origin (/api/...) and Vite proxies to the backend (see vite.config.js).
 *     Override proxy target with VITE_DEV_PROXY_TARGET=http://127.0.0.1:5000
 *     To talk to a remote API in dev instead: set VITE_DEV_USE_REMOTE_API=http://host:port
 * Production:
 *   - Leave VITE_API_URL unset/empty when the static host rewrites /api → real API (e.g. Vercel
 *     vercel.json). Browser stays same-origin → no CORS.
 *   - Set VITE_API_URL only if the app origin is already allowed by the API’s CORS rules.
 */
const devRemote = String(import.meta.env.VITE_DEV_USE_REMOTE_API || '').trim();
const prodBase = String(import.meta.env.VITE_API_URL || '').trim();

if (import.meta.env.DEV) {
  axios.defaults.baseURL = devRemote || '';
} else if (prodBase) {
  axios.defaults.baseURL = prodBase;
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
