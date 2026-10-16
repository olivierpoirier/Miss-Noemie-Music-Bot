# Project Notes

Last updated: 2026-08-20

These are historical notes from a Windows setup and tests performed on 2026-08-20.
Windows paths, audio device IDs, Cloudflare credentials and measured timings below
describe that machine; do not apply them as defaults on Linux. Use the README and
`docs/DIAGNOSTICS.md` for current setup and checks. Later changes make Operator ID
optional, so the earlier named-input test is a historical observation too.

## Local Audio Setup

- MPV is installed via Scoop.
- MPV executable path: `C:\Users\poiri\scoop\apps\mpv\current\mpv.exe`
- `backend/.env` has been updated with:
  - `MPV_BIN=C:\Users\poiri\scoop\apps\mpv\current\mpv.exe`
- VoiceMeeter exists at the default backend path:
  - `C:\Program Files (x86)\VB\Voicemeeter\voicemeeterpro.exe`
- VoiceMeeter routing test passed:
  - virtual sink: `VoiceMeeter`
  - virtual monitor/source: `B2`
  - MPV audio device: `wasapi/{422c5f03-d063-4b65-b529-c54272b9bac9}`
- A short generated WAV playback test through backend MPV + VoiceMeeter passed in about 10 seconds.

## Backend Decisions

- Do not require a password/token for guests. The app is intended to be shared with a trusted group through Cloudflare Tunnel.
- Keep invisible safety protections:
  - Socket.IO payload size limit
  - light per-socket rate limit
  - payload validation
  - optional CORS allowlist through `BACKEND_ALLOWED_ORIGINS`
- YouTube should prioritize audio-only streams for Discord/audio use.
- MP4/HLS YouTube formats should remain as fallback only, because they can be more robust when audio-only URLs fail in MPV.
- Spotify links should not require guests to log in.
- Spotify flow should remain:
  - Spotify metadata from server credentials
  - search a playable source from metadata
  - play through MPV + VoiceMeeter
- SoundCloud metadata should use oEmbed first to avoid long yt-dlp waits.
- SoundCloud direct playback should fail quickly, then fallback toward YouTube search when possible.
- Repeated provider matches should be cached in memory:
  - Spotify query/duration -> YouTube result
  - repeated YouTube searches -> cached result
  - SoundCloud URL -> learned YouTube fallback after direct SoundCloud fails
- Provider matches are persisted locally in:
  - `backend/.data/provider-match-cache.json`
  - This file is ignored by Git through `.data`.
  - Cache stores stable provider matches, not temporary YouTube direct audio URLs.
- Cookies should use one canonical path:
  - `backend/cookies.txt`
  - optional override: `YTDLP_COOKIES_PATH`
  - old tracked duplicates under `backend/src/cookies.txt` and `backend/www.youtube.com_cookies.txt` were removed.

## Measured Backend Timings

- VoiceMeeter readiness: about 14.9 s
- Backend idle memory during local server test:
  - RSS: about 86 MB
  - heap used: about 15 MB
- Spotify track metadata: about 0.2-0.4 s
- Spotify link to YouTube search to playable audio URL: about 5.0-5.3 s
- Web UI Spotify submit test:
  - Spotify URL accepted from the UI once `Operator ID` is filled
  - queue UI update: about 0.9 s
  - playback UI update after queue entry: about 0.6 s
  - final playable match for `Never Gonna Give You Up`: `https://www.youtube.com/watch?v=dQw4w9WgXcQ`
- YouTube playable audio extraction: about 3.9-5.8 s
- SoundCloud metadata through oEmbed: about 0.3-0.5 s
- SoundCloud direct stream timeout after optimization: about 5.1 s
- SoundCloud with fallback toward YouTube: about 9.1 s
- YouTube search cache test:
  - first `Rick Astley - Never Gonna Give You Up official audio` lookup used `play-dl`
  - second identical lookup returned from cache
- SoundCloud fallback query cleanup test:
  - `Stream My Track by My Artist | Listen online for free on SoundCloud`
  - becomes `My Artist - My Track`
- Batch link resolver test:
  - YouTube video metadata: OK
  - Spotify track metadata through `backend/.env`: OK
  - SoundCloud single metadata through oEmbed: OK
  - text search to YouTube: OK

## Current Verification Status

- Backend TypeScript type-check: OK
- Backend production audit: 0 vulnerabilities
- Backend build: OK when run outside the sandbox, because `backend/dist` denies writes inside the sandbox.
- Web UI Spotify playback path: OK in local browser test.
- Backend provider/search cache targeted runtime test: OK.
- Frontend TypeScript/build/lint: OK.
- Frontend browser UI test: OK for source input, optional operator input, paste buttons, submit, section collapse/open, queue controls, player controls, seek slider, theme header controls, and desktop theme dock.
- Frontend CSS build warning about `align-items: end` was fixed by using `flex-end`.
- Cloudflare quick tunnel smoke test on 2026-08-20:
  - public URL used: `https://live-lot-motivation-atmosphere.trycloudflare.com`
  - frontend loaded through Cloudflare
  - Socket.IO connected through Cloudflare
  - YouTube submit from the public URL started backend playback
  - Cloudflare quick tunnels are temporary; the URL changes when the tunnel is restarted.
- Stable Cloudflare tunnel setup:
  - `cloudflared` is installed locally.
  - Local Cloudflare auth is configured through `C:\Users\poiri\.cloudflared\cert.pem`.
  - Named tunnel created: `music-bot`.
  - Tunnel ID: `61cece20-c61e-4f02-a696-5082ce92cee4`.
  - Credentials file exists under `C:\Users\poiri\.cloudflared\61cece20-c61e-4f02-a696-5082ce92cee4.json`; do not commit or share it.
  - DNS route added for `miss-noemie-music-bot.com`.
  - Added `npm run dev:stable-tunnel` for a named tunnel.
  - Added helper scripts: `tunnel:login`, `tunnel:create`, `tunnel:list`, `tunnel:route`.
  - Default named tunnel is `music-bot`; override with `CLOUDFLARE_TUNNEL_NAME`.
  - Browser smoke test on 2026-08-20 still returned `ERR_NAME_NOT_RESOLVED` for `https://miss-noemie-music-bot.com`, so verify registrar nameservers/Cloudflare zone activation or wait for DNS propagation.
  - Current sharing decision: stay on free random `trycloudflare.com` URLs with `npm run dev`; do not pursue the custom domain until the domain is owned/configured.
- Mobile visual pass at `390x844`:
  - no horizontal page overflow
  - source/operator inputs stack correctly
  - queue/history buttons stay inside the viewport
  - mini-player remains usable with a track active
  - only detected visual overflow was the non-interactive decorative theme sun.
- Full UI tour on 2026-08-20:
  - visible text/action buttons all have an icon or a clear visual affordance
  - YouTube link submit from the UI starts playback
  - second YouTube link and text search queue correctly
  - queue drag/reorder works from the drag handle
  - `Passer groupe` clears the active group in the tested playback path
  - `Vider` clears the queue
  - mini player pause/resume works
  - YouTube video preview opens and closes
  - help panel opens and displays clean French/provider text
  - collapsed `Lecture` section reopens correctly
- Full UI tour found and fixed a backend playback edge case:
  - a preloaded YouTube `bestaudio` URL can be refused by MPV with HTTP 403 after a skip
  - the player now invalidates the cached direct audio URL and retries with another extraction strategy
  - verified fallback source: `youtube-mpv-safe-android-cookies` format `18 mp4`
- YouTube 403 startup retry polish:
  - MPV can emit `end-file/error` during the first failed startup attempt before the alternate source succeeds.
  - The player now lets startup retry handling own that error instead of briefly clearing the UI state.

## Frontend Notes

- `Operator ID` is optional; empty names submit as `anon`.
- Reusable UI primitives now live in `frontend/src/components/ui/`:
  - `Button`
  - `TextInput`
  - `FieldLabel`
  - `ThemedPanel`
- Component library usage notes live in `docs/UI_COMPONENT_LIBRARY.md`.
- Border/radius polish pass:
  - shared UI tokens live in `frontend/src/styles/base.css`
  - controls use pill-shaped `--ui-control-radius`
  - cards/panels use larger smooth radii
  - bordered buttons now have thicker borders, clearer hover, pressed states, and pointer cursors
  - inputs should keep the liked shape: dark pill fill, smooth full-radius capsule, and a left-to-right border gradient from `--c1` to `--c2`.
  - input border is implemented with real layered `background ... padding-box / border-box`, not a pseudo-border, to avoid clipped/cut corners.
  - `Signal requis` uses the secondary button style while disabled, then switches to primary only when a source is ready to submit.
  - `Lecture en cours` uses the same themed surface border system as the other boxes.
- Source input now shows detected source state for Spotify, YouTube, SoundCloud, generic links, and text search.
- Submit button now explains the disabled state with `Signal requis`.
- Queue button `Skip` was renamed to `Passer groupe`; it skips the current group/playlist if present, otherwise it skips the current track.
- Queue drag/reorder bug was fixed by letting `@dnd-kit` receive the drag-handle pointer listeners.
- Player icon controls have accessible labels so browser tests can target them reliably.
- Queue actions `Passer groupe` and `Vider` have explicit action icons.
- The mini player details button has a subtle chevron affordance.
- Supported links help text encoding was corrected.
- If MPV rejects a preloaded YouTube audio stream with 403, playback retries with a fresh alternate yt-dlp source instead of dropping the next track.
- SoundCloud URLs now prefer the stable path:
  - SoundCloud URL metadata/fallback match
  - YouTube playable source
  - alternate yt-dlp source if MPV returns 403
  - verified with `https://soundcloud.com/forss/flickermood` through the Cloudflare URL.
- Frontend SoundCloud detection includes short/app links such as `snd.sc`, `on.soundcloud.com`, and `soundcloud.app.goo.gl`.

## Remaining Work

- Test Discord capture quality while in a real Discord voice channel.
- Confirm Discord input is listening to the intended VoiceMeeter virtual output/source.
- Optional later: buy/configure a domain, then confirm `miss-noemie-music-bot.com` resolves publicly and smoke test from the public URL again.
- Consider a faster official SoundCloud streaming path if an API token/client setup becomes available; otherwise keep the current stable YouTube fallback behavior.
