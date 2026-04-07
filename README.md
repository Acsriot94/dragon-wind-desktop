# Dragon Wind Desktop

Native Electron desktop uploader for [Dragon Wind](https://forge.wilddragon.net/zgaetano/VPM-Uploader) / Grass Valley AMPP.

High-speed parallel file transfers to S3 — same approach as MASV and Aspera. No browser, no extension, no UDP firewall headaches.

## How it works

Files are split into chunks and uploaded concurrently via presigned S3 PUT URLs. The Dragon Wind server orchestrates multipart uploads; the desktop app drives the data plane directly to S3.

```
User drops file
  → Dragon Wind server: POST /api/desktop/multipart/init
    ← uploadId + N presigned S3 PUT URLs
  → S3: PUT each chunk in parallel (N workers)
  → Dragon Wind server: POST /api/desktop/multipart/complete
    ← done ✅
```

## Requirements

- Node.js 18+
- A running Dragon Wind server (v0.x or later with desktop API endpoints)
- Electron 30+

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build:mac    # DMG for macOS (x64 + arm64)
npm run build:win    # NSIS installer for Windows
npm run build:linux  # AppImage for Linux
```

## Server-side additions needed

Add these endpoints to the Dragon Wind `server.js`:

- `POST /api/desktop/multipart/init` — creates S3 multipart upload, returns presigned part URLs
- `POST /api/desktop/multipart/complete` — completes the multipart upload
- `POST /api/desktop/multipart/abort` — aborts on cancel/error

See `docs/server-api.md` for full spec.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Workers | 6 | Concurrent chunk uploads |
| Chunk size | 16 MB | Per-part size (min 5 MB, S3 limit) |

Tune workers up on high-bandwidth links (50+ Mbps). Tune chunk size up for high-latency WAN to reduce round trips.
