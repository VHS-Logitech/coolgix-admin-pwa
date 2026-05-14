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

Set **`VITE_API_URL`** to your deployed API origin when you run `npm run build` (see `.env.example`).

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

`public/icons/pwa-192.png` and `pwa-512.png` are minimal placeholders; replace with branded assets for store-quality install banners.
