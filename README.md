# Lizzen Web

A full‑stack experimental music discovery and playback web application that combines:

- Music metadata from MusicBrainz (artists, releases, recordings)
- Torrent search aggregation via Prowlarr (multiple indexers)
- Server‑side torrent resolution & streaming using WebTorrent
- Smart multi‑stage torrent scoring & filtering (seeders, title similarity, quality hints)
- Background async job system for non‑blocking UX (torrent search & stream prep)
- Album‑level torrent pre‑loading with magnet resolution & early seeding
- React + Vite frontend with progressive polling states & track playback UI

> Goal: Fast artist/release exploration with immediate UI response while heavyweight torrent discovery/stream preparation runs asynchronously.

---
## Architecture Overview

Component | Tech | Purpose
---------|------|--------
Backend API | Node.js + Express | Exposes search, artist/release metadata, torrent search, streaming & job status endpoints.
Torrent Engine | WebTorrent (Node) | Adds, seeds, and streams magnet links; resolves file lists & serves ranged audio streams.
Metadata Layer | MusicBrainz API + Cover Art Archive | Artist, release, recording metadata & artwork.
Torrent Discovery | Prowlarr API | Multi-indexer torrent search; results scored & filtered per need (track vs album).
Async Orchestration | In‑memory Job Map | Non-blocking torrent discovery & stream prep; polled by frontend.
Frontend | React 19 + Vite | Search UI, artist/release browsers, track playback & async state indicators.
Audio Service | Custom (TorrentAudioService) | Requests stream URLs (sync or async), caches, manages album track playback.
Caching | In‑memory Maps | Preloaded album torrents, async jobs, active WebTorrent instances.

---
## Key Backend Behaviors

1. Artist Details (`POST /api/artist-details`)
   - Immediate response with categorized releases (albums, EPs, singles, other)
   - Background task pre-loads album torrents: searches via Prowlarr, scores, resolves magnet links, adds to WebTorrent, caches result.

2. Retrieve Pre‑Loaded Album Torrents (`GET /api/artist-torrents/:artistId`)
   - Returns cached album torrent lists (with resolved magnet links, readiness flags).

3. Smart Track Torrent Search (`POST /api/find-best-torrent`)
   - Async by default (jobId) or synchronous fallback.
   - Enhances queries using MusicBrainz verified metadata (artist/track/album/ISRC) before scoring.

4. Stream Torrent (`POST /api/stream-torrent`)
   - Adds/uses torrent; selects best audio file using multi-stage strategy (exact, partial, numeric track inference, fuzzy, fallback).
   - Async option returns jobId for large/slow torrents.

5. Album Track Playback (`POST /api/play-album-track`)
   - Selects specific track within an already added (or just added) album torrent.

6. Track Listing (`POST /api/torrent-tracks`)
   - Returns audio file listing without starting playback.

7. Job Status (`GET /api/job-status/:jobId`)
   - Poll for progress/results of async torrent searches or stream prep tasks.

8. Health & Utilities
   - `/api/health`, `/api/indexers`, `/api/cleanup-torrents`, `/api/resolve-magnet`, `/api/test-magnet`.

---
## Frontend Highlights

- React + Vite fast dev environment.
- Polling for: artist album torrent preloading, async torrent search, async stream prep.
- Visual states: searching, preloading in‑progress / completed / timeout.
- Audio player with progress, volume, repeat/shuffle placeholders.
- Service layer (`src/services/TorrentAudioService.js`) abstracts async vs sync streaming.

---
## Repository Layout

```
backend/            Express API + WebTorrent integration
  index.js         Single service entrypoint (all routes & logic)
  package.json
frontend/           React + Vite app
  src/             Components, contexts, services
  package.json
setup-ssl.sh        Helper script for DNS check + certbot issuance
README.md           (This file)
```

---
## Prerequisites

- Node.js 18+ (recommended LTS) for both backend & frontend
- Prowlarr running locally: `http://localhost:9696` with API key configured in backend (currently hardcoded in `index.js` -> PROWLARR_CONFIG)
- Internet access to MusicBrainz & Cover Art Archive
- (Optional) Nginx + certbot if deploying with real domain (`setup-ssl.sh` script)

---
## Quick Start (Development)

Open two terminals:

Backend:
```
cd backend
npm install
npm start
```
(Default port: 3001)

Frontend:
```
cd frontend
npm install
npm run dev
```
(Visit: http://localhost:5173 )

---
## Environment / Configuration

Currently, most config is in code (backend `index.js`). For production harden by moving to environment variables:

Variable | Purpose | Current Hardcoded Source
---------|---------|-------------------------
PROWLARR_API_KEY | Auth for Prowlarr | PROWLARR_CONFIG.apiKey
PROWLARR_BASE_URL | Prowlarr API root | PROWLARR_CONFIG.baseUrl
MUSICBRAINZ_USER_AGENT | API etiquette | MUSICBRAINZ_CONFIG.userAgent
PORT | Backend port | process.env.PORT || 3001
APP_DOMAIN | External domain | MUSICBRAINZ_CONFIG.domain

Create a `.env` (backend) and load via a library like `dotenv` for production.

---
## Building for Production

Frontend build (outputs static assets in `dist/`):
```
cd frontend
npm install
npm run build
```
Deploy `frontend/dist` behind a web server or serve via a CDN / reverse proxy.

Backend (simple Node app):
```
cd backend
npm install
node index.js
```
Optionally create a systemd service, Docker image, or use PM2:
```
npm install -g pm2
pm2 start index.js --name lizzen-backend
pm2 save
```

---
## Suggested Production Reverse Proxy (Nginx)

- Terminate SSL at Nginx
- Serve frontend static bundle
- Proxy API `/api/*` to backend `http://localhost:3001`
- Increase proxy timeouts for long torrent preparations

Example (simplified):
```
server {
  server_name lizzen.org;
  root /var/www/lizzen/frontend/dist;
  location /api/ { proxy_pass http://localhost:3001; proxy_set_header Host $host; }
  location / { try_files $uri /index.html; }
}
```
Use `setup-ssl.sh` after DNS points to your server.

---
## Async Job Model

Flow:
1. Client requests operation with `{"async": true}`.
2. Backend returns `{ jobId }` immediately.
3. Client polls `/api/job-status/:jobId` until `status` is `completed` or `failed`.
4. Result includes final `bestTorrent` or streaming `streamUrl` metadata.
5. Job auto-cleans after 5 minutes.

Statuses: `pending` → `processing` (progress %) → `completed|failed`.

---
## Torrent Scoring (Simplified Summary)

Factor | Rationale
-------|----------
Seeders (weighted) | Availability / health
Title similarity (artist + track + album tokens) | Relevance
Format preference (FLAC > MP3) | Quality bias
Age (older stable vs very new) | Stability
File size sanity | Filter unlikely single vs multi‑disc cases
Seeder/leecher ratio | Health signal

Album pre-loading uses a lighter variant emphasizing seeders, query term presence, and reasonable size ranges.

---
## Track Selection Logic

Order of attempts when selecting a file inside a torrent:
1. Exact filename match
2. Partial substring match (either direction)
3. Extracted track number (e.g. "03" / "3 - title") by sorted ordering
4. Fuzzy match (strip numeric prefixes & punctuation)
5. Fallback to first sorted audio file

Supported extensions: mp3, flac, wav, m4a, aac, ogg, wma.

---
## Adding Persistence / Scaling (Future Ideas)

Area | Enhancement
-----|------------
Jobs | External store (Redis) + TTL eviction
Preloaded Torrents | TTL + size-based eviction
Push Updates | WebSockets or SSE instead of polling
Security | Input validation, rate limiting, API key externalization
Observability | Structured logs + metrics (Prometheus) + tracing
Resilience | Retry w/ backoff (partially implemented) & circuit breakers
Caching | Layered (Memory + Redis) for MusicBrainz & Prowlarr responses

---
## Operational Maintenance

Task | Endpoint / Action
-----|------------------
Health check | GET `/api/health`
Cleanup torrents | POST `/api/cleanup-torrents`
Test magnet validity | POST `/api/test-magnet` `{ magnetLink }`
Resolve magnet from URL | POST `/api/resolve-magnet` `{ downloadUrl }`
Fetch job status | GET `/api/job-status/:jobId`
Get preloaded album torrents | GET `/api/artist-torrents/:artistId`

---
## Development Tips

- If Prowlarr returns few/empty results, verify categories & API key.
- MusicBrainz rate limiting is respected with a 1s spacing; avoid manual rapid loops.
- Large/dead torrents may hit 45s timeouts; ensure indexers expose healthy peers.
- For production, externalize secrets & sanitize logs (current logs are verbose for dev).

---
## Security Notes (Current Gaps)

- API key hardcoded in repo (move to env var before publishing!)
- No auth layer or rate limiting
- No HTTPS enforcement in backend (rely on reverse proxy)
- In‑memory only (loss on restart)

---
## Contributing

1. Fork & branch: `feature/your-change`
2. Keep edits focused; add minimal inline logging if needed
3. Submit PR with concise description & before/after behavior

---
## License

Currently unspecified (private / internal). Add a LICENSE file before public release.

---
## Disclaimer

This project interfaces with torrent indexers. Ensure your usage complies with all applicable laws and indexer terms of service. The maintainers assume no liability for misuse.

---
## At A Glance (Cheat Sheet)

Action | Call
-------|-----
Search MusicBrainz | GET `/api/search?q=QUERY`
Artist details (+background preload) | POST `/api/artist-details` `{ artistId, artistName }`
Check preloaded torrents | GET `/api/artist-torrents/:artistId`
Find best torrent (track) | POST `/api/find-best-torrent` `{ trackTitle, artistName, albumTitle, async:true }`
Prepare stream | POST `/api/stream-torrent` `{ magnetLink, fileName?, expectedFileCount?, async:true }`
Play album track | POST `/api/play-album-track` `{ albumMagnetLink, trackTitle? | trackIndex? }`
Get track listing | POST `/api/torrent-tracks` `{ magnetLink }`
Job status | GET `/api/job-status/:jobId`

---
## Roadmap (Short List)

- WebSocket push for job + torrent readiness
- Configurable environment variables & secrets management
- Persistent job/torrent metadata store
- Audio metadata extraction (durations, tags)
- Progressive stream buffering indicators
- Automated test harness & lint/CI pipeline

---
Happy hacking! 🎧
