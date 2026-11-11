# Wedding Photo Drop

A Node/Express server serves the uploader, live album, and original media together. The browser uses relative URLs, so localhost, a home-network address, and the eventual public hostname all use the same server.

## Run locally

Use Node 26 or newer. The exact project runtime is pinned in `.node-version`. This working copy has Node 26.13.0 installed in the ignored `.runtime/node` directory; `npm start`, `npm test`, and the other application scripts use that runtime automatically without changing system Node. If it is absent, the scripts use a suitable system Node.

On Linux or macOS, the optional installer downloads the official Node archive and verifies its SHA-256 checksum. It requires Python 3.12 or newer. Install the project runtime before installing packages when the system Node is older:

```sh
npm run setup:node
PATH="$PWD/.runtime/node/bin:$PATH" npm ci
cp .env.example .env
npm start
```

Open http://127.0.0.1:4000. No router forwarding, DuckDNS, or internet access is needed for the app itself. Google Fonts is optional; system fonts work offline. `npm run dev` restarts the server when source files change.

If Node 26 or newer is already installed system-wide, skip `setup:node` and run `npm ci` normally. Package updates can be checked with `PATH="$PWD/.runtime/node/bin:$PATH" npm outdated` and `PATH="$PWD/.runtime/node/bin:$PATH" npm audit` when using the project runtime. The load-test script and server tests use Node's built-in `fetch`, `FormData`, and `Blob` APIs.

Settings are read from `.env`; existing shell environment variables take precedence. An existing `.env` has been prepared in this working copy to keep using `/home/nick/Pictures/Wedding_Photos`. A fresh clone defaults to `server/uploads`.

To test from a phone on the same Wi-Fi, set `HOST=0.0.0.0` in `.env`, restart, and open `http://<server-LAN-IP>:4000`. Allow TCP 4000 through the server's local firewall if needed. Router port forwarding is unnecessary for devices on the same LAN. Guests can open the link directly; access-code protection is optional.

This working copy is configured for `http://192.168.1.32:4000`, with `ACCESS_CODE` empty so wedding guests can open the link directly. The listener uses `0.0.0.0` so both that LAN address and the existing localhost Caddy upstream work. The router's TCP 4000 rule should target `192.168.1.32:4000`. Outside the home network, use `http://nickserverphotodump.duckdns.org:4000` only if DuckDNS points at the current public IP and the router forwards public port 4000. This direct connection uses HTTP: photos are not encrypted in transit. `SECURE_COOKIES=false` allows the browser session to work over this HTTP endpoint; HTTPS should be used for guest sharing when the existing Caddy certificate/proxy is working.

## Photos and identity

New originals are stored at `PHOTO_STORAGE_ROOT/originals/main-event/YYYY-MM-DD/`, using UTC dates and server-generated filenames. Each original has an adjacent `.meta.json` file. Metadata is never served, filesystem paths and device identifiers are omitted from API responses, and only explicitly listed frontend assets are public.

The old `server/uploads` and literal `<<SET_ABSOLUTE_PHOTO_STORAGE_PATH>>` storage roots are also read automatically, including filenames such as `photo.png_91dcec99ab9d`. Originals are not renamed, copied, or deleted. `LEGACY_STORAGE_ROOTS` can override these read-only sources with a comma-separated list of storage roots. Keep their order stable because media URLs include a source index.

A signed device cookie identifies uploads from this browser. The server persists its signing secret in `PHOTO_STORAGE_ROOT/.session-secret`, unless `SESSION_SECRET` supplies one. Back up that secret with the photos. Old unsigned cookies are intentionally replaced: old photos still appear under All Photos, but cannot safely be claimed by the new browser filter. Names label photos and do not establish ownership. Clearing cookies or changing browsers creates a new identity.

The album and background slideshow refresh every 10 seconds while visible; the disk index is cached for up to 5 seconds. The album supports loading additional pages. Photos are sorted by saved upload time, falling back to filesystem modification time for older files.

Photos and videos retain their original bytes. Only photos appear in the album. Supported types are JPEG, PNG, HEIC/HEIF, WebP, MP4, QuickTime, and 3GPP. The server checks binary file signatures and derives extensions from detected content. Signature detection is not full decoding or malware scanning. There is no image conversion or thumbnail pipeline; some HEIC/HEIF originals may not preview in a particular browser. Click an album image to open its original.

## Limits and recovery

Defaults: five files and 100 MiB per batch, 50 GiB of original media in writable storage, 300 upload requests per IP per 10 minutes, and 20 failed access-code attempts per IP per 15 minutes. The browser fetches actual limits from `/api/config`. Batch and storage byte limits include uploads currently in flight, and reject oversized streams while receiving them. The storage quota excludes metadata and read-only legacy roots; leave disk headroom for those. Run one server process per writable storage directory. If originals are added or removed outside the app, restart to recalculate quota usage.

Files are checked before publishing. A failed save removes that batch's new originals, metadata, and temporary files; metadata errors fail the upload. A network failure after a successful save can still leave the browser uncertain, so check the album before retrying. Selected files remain available for retry after an error. An abrupt process or power failure can leave `.uploading` files in `incoming`; after stopping the server, these incomplete files can be removed. Back up the complete storage directory regularly; there is no automatic backup service.

## Public access after the router is ready

1. Reserve a stable LAN address for this server in the new router.
2. Run an HTTPS reverse proxy on this server, pointing to `127.0.0.1:4000`. The included `Caddyfile.example` is a starting point for the current DuckDNS hostname; see the [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Keep the Node server bound to loopback for this setup.
3. In `.env`, set `NODE_ENV=production` and `TRUST_PROXY=loopback`. Leave `ACCESS_CODE` empty for the wedding so the invitation link opens directly. A code is optional for temporary protection; if set in production it must contain at least 12 characters. Production cookies require HTTPS. Restart after changing settings.
4. Update DuckDNS to the new public IP. Forward the public ports used by the HTTPS proxy (normally TCP 80 and 443) to this server's LAN address, and permit those ports in its firewall. Port 4000 does not need public forwarding. See [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https).
5. Verify access from outside your Wi-Fi once forwarding is configured. This has not been tested against the new router.

Only enable `TRUST_PROXY=loopback` when the proxy actually runs on this machine. It allows the server to use the proxy's client IP and HTTPS information. For local HTTP testing, keep production mode off, or explicitly set `SECURE_COOKIES=false` in a separate test configuration. CORS denies other origins by default; `CORS_ORIGINS` can list explicitly trusted origins if needed.

Without `ACCESS_CODE`, anyone who can reach the server can upload and view originals. With it, pages, media, and photo APIs require a signed, expiring access cookie. `/health`, upload-limit settings, and login assets remain public. The access code is shared guest access, not individual user accounts.

## Verification

```sh
npm test
```

The suite starts real HTTP servers on random loopback ports, creates temporary storage directories, and removes its fixtures afterward. It never uses the real photo directory or public hostname. It covers file serving, signatures, cookies, authentication, limits, rollback, ordering, legacy files, pagination, and browser behavior.

For a local load test, first start a separate instance with temporary storage:

```sh
PHOTO_STORAGE_ROOT=/tmp/wedding-load-test LEGACY_STORAGE_ROOTS= PORT=4100 npm start
```

Then, in another terminal:

```sh
BASE_URL=http://127.0.0.1:4100 STRESS_UPLOADS=20 STRESS_CONCURRENCY=5 npm run stress
```

This creates real test uploads in that temporary directory. The default is a valid tiny PNG; use `STRESS_IMAGE=/path/to/a/real/photo.png` for realistic payload sizes. Video tests require a real MP4: set `STRESS_VIDEO=/path/to/video.mp4` and `STRESS_VIDEO_RATIO=0.3`. Set `STRESS_ACCESS_CODE` if the target uses a different code. Remote targets require the explicit `STRESS_ALLOW_REMOTE=true` flag. Failures cause a nonzero exit status.

## Repository

Commit the source, scripts, tests, `.env.example`, `package.json`, and lockfile together. Dependencies, photos, cache, `.env`, and signing secrets are ignored. No deployment, router changes, or Git commit is performed automatically.
