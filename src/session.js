const TOKEN = 'token';
const USER = 'user';

export function getToken() {
  return localStorage.getItem(TOKEN);
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER) || 'null');
  } catch {
    return null;
  }
}

export function persistSession(token, user) {
  localStorage.setItem(TOKEN, token);
  localStorage.setItem(USER, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN);
  localStorage.removeItem(USER);
}
