# Coolgix Monitor (PWA)

Lightweight **mobile-first** dashboard: login, warehouse / room / BLE health, and a temperature chart. Uses the **same Coolgix backend APIs** as the main web app (`/api/auth/login`, `/api/warehouses`, `/api/devices`, `/api/devices/:id/sensor-data`).

## Setup

```bash
cd coolgix-pwa-dashboard
npm install
```

Create `.env` in **this folder** (`coolgix-pwa-dashboard/`) only if you need non-default settings. Copy from `.env.example`.

### Local development

- **`npm run dev`**: requests go to `http://localhost:5180/api/...` and **Vite proxies** them to **`http://127.0.0.1:5000`** by default (same as `coolgix-backend`).
- You do **not** need `VITE_API_URL` for dev (it is ignored in dev so a wrong port in `.env` cannot break login).
- If the API is not on port **5000**, set e.g. `VITE_DEV_PROXY_TARGET=http://127.0.0.1:YOUR_PORT` in `.env`, then **restart** `npm run dev`.
- **Restart the Vite dev server** after any `.env` change.

### Production build

- **Default (Vercel, Netlify with `/api` rewrite, etc.):** the app calls **`/api/...` on the same origin**. This repo’s **`vercel.json`** forwards that to **`https://v2.coolgix.com`**, so the browser does **not** call v2 directly → **no CORS**. You can leave **`VITE_API_URL`** set in the dashboard if you want; it is **ignored** unless you also set **`VITE_USE_DIRECT_API=1`**.
- **Cross-origin API (only if the backend CORS allowlist includes your frontend origin):** set **`VITE_API_URL`** (no trailing slash) **and** **`VITE_USE_DIRECT_API=1`**, then rebuild.
- **Why calling v2 from `*.vercel.app` used to fail:** the API sends `Access-Control-Allow-Origin: https://v2.coolgix.com`. Your origin is different, so the browser blocks the response unless you use the same-origin `/api` proxy or the API adds your Vercel URL to CORS.

## Dev

```bash
npm run dev
```

Default Vite port: **5180** (see `vite.config.js`).

## Production build

```bash
npm run build
npm run preview
```

Install the app from the browser (“Add to Home screen”) after opening the built site over **HTTPS** (required for PWA on most devices).

## UI / behaviour

- **Colours** mirror the main app theme: primary `#7551FF`, accent `#39B8FF`, dark surfaces.
- **Live data**: last sample **≤ 5 minutes** → green.
- **Stale**: older than 5 minutes but **≤ 2 hours** → amber.
- **Offline / no data**: no points or older than 2 hours → red.
- Auto **refresh** every **45s**; manual **Refresh** button.
- Chart: last **24h** temperature for the selected BLE (downsampled for speed).

## Icons

`public/icons/pwa-192.png` and `pwa-512.png` must match the **`sizes`** in `vite.config.js` (192×192 and 512×512). The manifest is rejected if the files are the wrong dimensions. Replace these files with full-brand artwork when ready.
