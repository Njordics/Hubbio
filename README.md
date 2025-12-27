# Hubbio Stremio Addon

Node-based Stremio addon server exposing streams, catalogs, meta, and subtitles on port 51300.

## Quick start
- Install deps: `npm install`
- Run dev: `npm run dev` (or `npm start`)
- Manifest: `http://localhost:51300/manifest.json`
- Web installer: `http://localhost:51300/`

## Auth
- First-time setup via `/login` with TOTP + password (stored in `Confidential/auth.json`).
- All pages except `/manifest.json` and `/auth/*` require an authenticated session.

## Config & storage
- Config at `Confidential/config.json`: TMDB, Trakt (client id/secret/access token), OpenSubtitles API key.
- Addons: `Confidential/addons.json` (ignored by git).
- Cache: `Confidential/streams-cache.json` with stats/errors in `Confidential/stats.json`.
- Templates under `Template/` document expected structures.

## UI pages
- Dashboard: manifest link + sample IDs.
- Addons: install/remove external addons; categories (streams, catalog, meta, subtitles, other).
- In-Built: toggle TMDB/Trakt-powered catalogs (trending/popular/recent/random movies/series).
- Timeline: request stats (requests, unique IPs, errors, avg response) + recent requests/errors.
- Cached: view/remove cached entries, drill into/remove individual cached streams.
- Logs: view/clear logs; live mode.
- Config: manage TMDB/Trakt/OpenSubtitles keys.

## Notes
- Streams handler aggregates from installed addons and falls back to a sample HLS stream.
- Catalogs pull from TMDB; Trakt catalogs require client id + access token to enable.
- Subtitles endpoint returns a placeholder when an OpenSubtitles key is set (replace with real lookup as needed).
