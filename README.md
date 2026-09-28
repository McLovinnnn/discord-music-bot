# discord-music-bot

A Discord slash-command music bot with a queue, built to reliably stream live
HLS radio (BBC Radio 2 by default), direct audio/stream URLs, and
Spotify/YouTube links, with live-stream-aware reconnect, pause/resume, an
alone-in-channel auto-disconnect, and a boot-time GitHub auto-updater —
designed to be deployed on a [Pterodactyl](https://pterodactyl.io/) panel.

**Note on Spotify/YouTube playback**: Spotify never exposes playable track
audio to third parties (it's DRM-protected) — only metadata (title/artist)
and an unreliable, increasingly-absent 30-second preview clip. So, like every
other bot that claims "Spotify support," this one uses Spotify's API purely
for the tracklist and resolves actual audio from YouTube via `yt-dlp`. See
[Spotify + YouTube setup](#3-spotify--youtube-setup) for the trade-offs
involved (a real, if unlikely, ToS consideration, and a dependency that can
occasionally need updating as YouTube changes things).

## Features

- `/play <url>` — play a direct audio/HLS (`.m3u8`) stream URL, a Spotify
  track/playlist link, or a YouTube link.
- `/radio [station]` — play a preset station (BBC Radio 2 by default).
- `/jamiematt` — play today's tracks from a configured daily-rotating
  Spotify playlist (see [Spotify + YouTube setup](#3-spotify--youtube-setup)).
- `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/nowplaying`, `/volume`.
- `/status` — deployed commit, uptime, memory, ffmpeg health, and recent
  reconnect/crash events, for diagnosing issues without needing to dig
  through raw console output.
- Automatically reconnects a live stream if the upstream connection drops,
  and retries a finite track (direct URL/YouTube) a couple of times if its
  process crashes instead of silently treating that like the track ending.
- Automatically leaves the voice channel after being alone in it for
  `AUTO_DISCONNECT_MINUTES` (default 5).
- Automatically (re-)registers its slash commands with Discord on every
  boot — no separate manual step, no shell access needed on the host.
- On every boot, checks GitHub for a newer commit and pulls it in before
  starting (see [Auto-update](#auto-update)).

## Prerequisites

- Node.js **≥ 22.12.0** (required by `@discordjs/voice`).
- A Discord account and a server (guild) you can test in.

## 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it as `DISCORD_TOKEN`. No privileged
   gateway intents are needed (this bot is slash-command only).
3. **General Information** tab → copy **Application ID** as `CLIENT_ID`.
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`.
   - Bot permissions: `View Channel`, `Connect`, `Speak` (add `Send Messages`
     and `Embed Links` too if you want the bot's status notifications, like
     reconnect/auto-disconnect messages, to actually be postable).
   - Open the generated URL and invite the bot to your server.

## 2. Local setup

```bash
npm install
cp .env.example .env
# fill in DISCORD_TOKEN, CLIENT_ID, and GUILD_ID (a dev/test guild ID -
# guild-scoped command registration is instant, global can take up to an hour)
npm run check-stream        # confirms ffmpeg can pull audio from the BBC URL
npm start                   # also registers slash commands automatically
```

Then, in your test guild: join a voice channel and run `/radio`.

## 3. Spotify + YouTube setup

Optional — `/radio` and direct-URL `/play` work without this. Needed for
`/jamiematt` and Spotify/YouTube links via `/play`.

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → copy its **Client ID** and **Client Secret** as `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`. This uses the Client Credentials flow (no user login, no redirect URI needed) — it only ever reads public playlist/track metadata.
2. `SPOTIFY_PLAYLIST_URL` — the playlist `/jamiematt` plays, refreshed on every boot plus every `PLAYLIST_REFRESH_HOURS` (default 12). Defaults to a daily-rotating Spotify editorial playlist; swap in any playlist link.
3. YouTube audio resolution needs the `yt-dlp` binary, handled the same way as ffmpeg: `scripts/ensure-ytdlp.js` downloads and self-heals it automatically as part of `npm install`, no separate setup needed. Three other approaches were tried and abandoned during development — see [Troubleshooting](#troubleshooting) if YouTube playback stops working, since it's worth understanding why this specific approach was chosen.

**Worth understanding**: Spotify's API never exposes playable track audio to any third party — only metadata and an unreliable preview clip. Every bot that claims "Spotify support," this one included, actually resolves real audio from YouTube behind the scenes. YouTube has no official audio API either, so this uses `yt-dlp` (the same tool nearly the entire self-hosted-media ecosystem relies on) rather than a lighter JS library — three JS extractor libraries (`youtubei.js`, `@distube/ytdl-core`, `play-dl`) were tried first and all hit YouTube's current anti-bot PoToken requirement; `yt-dlp`'s own actively-maintained client-selection logic resolves working audio URLs without it. This is a genuine, if small, ToS consideration (the same category that got the bots Groovy/Rythm shut down by YouTube in 2021, though enforcement against a small personal bot is very unlikely) and `yt-dlp` is a moving target that occasionally needs a newer release to keep working as YouTube changes things — `ensure-ytdlp.js` always fetches latest on install for exactly that reason.

## 4. Deploying to Pterodactyl

### Quick start: import the ready-made egg

[`pterodactyl/egg-discord-music-bot.json`](pterodactyl/egg-discord-music-bot.json) is a ready-to-import Pterodactyl egg for this bot. In the admin panel: **Nests → Import Egg**, upload that file. It's pre-configured with:

- Docker images: `ghcr.io/pelican-eggs/yolks:nodejs_22` and `nodejs_24` (both satisfy the Node ≥22.12 requirement — **the older/more commonly-linked `ghcr.io/pterodactyl/yolks` images only go up to Node 20 and will not work** for this bot).
- An install script that clones (or resets, on reinstall) the GitHub repo into `/mnt/server`.
- Startup command `npm install && node boot.js`, a "ready" detection string, and `^C` (SIGINT) as the graceful stop signal, which `src/index.js` already handles.
- All the config variables below, pre-declared with descriptions and defaults, ready to fill in per-server.

After importing, create a new server using this egg, fill in `Discord Bot Token` / `Discord Application (Client) ID` / `Guild ID` in the server's Startup tab, and install. Slash commands register themselves automatically on the first boot — see [Registering commands](#registering-commands) below.

If you'd rather configure a generic Node.js egg by hand instead, the manual details are below.

### Egg / Docker image

Use a generic Node.js egg running a **Node ≥ 22.12** image tag —
`@discordjs/voice` hard-requires it. Concretely: `ghcr.io/pelican-eggs/yolks:nodejs_22`
or `nodejs_24` (these are what the ready-made egg above uses). Watch out for
the older, more commonly-linked `ghcr.io/pterodactyl/yolks` image set — as of
writing it only publishes up through `nodejs_20`, which is **not** new enough.

ffmpeg does not need to be installed separately: the `ffmpeg-static` npm
dependency bundles a working ffmpeg binary, pulled in automatically by
`npm install`, so no Docker image customization is required. (Exception: if
your host's CPU architecture doesn't have a published `ffmpeg-static`
release — rare, mostly certain ARM hosts — you'd need to `apt-get install
ffmpeg` via the egg's install script instead.)

Same story for `yt-dlp` (used for YouTube-sourced audio, see
[Spotify + YouTube setup](#3-spotify--youtube-setup)): no separate install —
`scripts/ensure-ytdlp.js` downloads its standalone binary during
`npm install`. It's fetched for `linux`/`x64` or `linux`/`arm64` (both
confirmed glibc, not musl, for the recommended `pelican-eggs/yolks` images);
if your host is musl-based (e.g. an Alpine-based image) this won't resolve a
working binary and YouTube-sourced playback won't work until that's
addressed.

### Deploy via git clone (required for auto-update)

Deploy the code with the egg's **git repository** install option (pointed at
your GitHub repo, see [Auto-update](#auto-update) below), not a zip/SFTP
upload — the boot-time update check needs a real `.git` working copy with an
`origin` remote. If you do deploy via SFTP instead, the update check simply
detects there's no `.git` directory and skips itself; the bot still runs
fine, it just won't self-update.

### Startup variables

Set these as the egg's **Startup Variables** (environment variables) —
never commit a `.env` file:

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes | |
| `CLIENT_ID` | yes | |
| `GUILD_ID` | recommended | For a bot that lives in one server, just leave this set permanently — guild-scoped registration is instant and sufficient. |
| `AUTO_DISCONNECT_MINUTES` | no | Default `5`. |
| `AUTO_UPDATE` | no | Default `true`. Set `false` to disable the boot-time GitHub check. |
| `UPDATE_BRANCH` | no | Default `main`. |
| `REGISTER_COMMANDS_ON_BOOT` | no | Default `true`. Set `false` to disable automatic slash command registration on boot. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | for `/jamiematt`/Spotify links | From a [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) app. |
| `SPOTIFY_PLAYLIST_URL` | for `/jamiematt` | The playlist `/jamiematt` plays. |
| `PLAYLIST_REFRESH_HOURS` | no | Default `12`. |

### Startup command

```
npm install && node boot.js
```

(`boot.js` itself handles `git pull` + `npm install` on *subsequent* boots —
the `npm install` in the startup command just covers the very first deploy.)

### Networking

Everything is outbound-only (Discord gateway/voice, the HLS stream, and
GitHub for the update check) — no inbound ports are needed. Some egg
templates still force a port allocation; that's harmless and can be ignored.

### Registering commands

This happens automatically on every boot (`REGISTER_COMMANDS_ON_BOOT`,
default `true`) — there's no manual step. This matters specifically on
Pterodactyl: the panel's server console is stdin piped directly to the
running bot process, not a shell, so there's no way to separately run
`npm run register-commands` there while the bot is up. If you ever do want
to run it manually (e.g. locally against a different token/guild), that
script is still available: `npm run register-commands`.

## Auto-update

`boot.js` is the actual process entry point. On every boot, before starting
the bot, it:

1. Skips entirely if `AUTO_UPDATE=false` or the deployment isn't a git
   checkout.
2. `git fetch`es the configured branch and compares local vs. remote HEAD.
3. If there's a newer commit, `git pull --ff-only`s it (refuses to
   merge/rebase — if this fails, e.g. because of local changes made directly
   on the server, it logs a warning and boots on the existing code rather
   than crashing).
4. Runs `npm install` if `package.json`/`package-lock.json` changed.
5. Starts the bot.

This only runs at boot, not while the bot is live — pushing to GitHub takes
effect the next time the Pterodactyl server is (re)started, not instantly.

**To publish an update:** commit and push to the `main` branch (or whichever
branch `UPDATE_BRANCH` points at) of the GitHub repo, then restart the server
from the Pterodactyl panel.

## Troubleshooting

Run `/status` in Discord first — it shows the deployed commit, uptime,
memory, whether ffmpeg is healthy, and the last few reconnect/crash events,
which often narrows things down before you need to open the Pterodactyl
console at all.

- **ffmpeg not found / no audio at all**: run `npm run check-stream` (add
  `-- <url>` to test a different stream) — it isolates the ffmpeg/network
  path from the rest of the bot. If it fails on the Pterodactyl host but
  works locally, see the geo-blocking note below.
- **Bot joins the channel but immediately says "Lost connection... attempting
  to reconnect", with `[ffmpeg:...] process exited after N ms (signal=SIGSEGV`
  or similar in the console**: this means the ffmpeg *binary itself* is
  crashing, near-instantly, every time — not a network/stream issue. Two
  possible causes, in the order to check them:
  1. A bad binary (corrupted/incomplete download, or the wrong CPU
     architecture for the host). `npm install` runs `scripts/ensure-ffmpeg.js`
     as its postinstall step specifically to catch and self-heal this — it
     verifies the binary actually runs (`ffmpeg -version`), not just that a
     file exists, and re-downloads it if not. Run `npm run check-stream` to
     confirm the binary itself is fine; if it reports success, this isn't it.
  2. **A known bug in fully-static ffmpeg builds crashing on DNS lookups**
     (`ffmpeg-static`'s Linux binary is exactly this kind of build). glibc's
     NSS mechanism needs to `dlopen()` resolver modules at runtime, which a
     fully-static binary can't do reliably, especially in a minimal
     container. This is what actually caused the SIGSEGV during development
     of this project — see `resolveForFfmpeg()` in `src/lib/streams.js`,
     which works around it by resolving the hostname in Node (unaffected,
     since it's dynamically linked) and handing ffmpeg a raw IP with an
     explicit `Host` header instead, for plain `http://` URLs. If you're
     still hitting this on an `https://` stream, that workaround doesn't
     apply (swapping the hostname for an IP would break TLS SNI/certificate
     validation) — that's a harder, unresolved case.
- **`signal=SIGKILL`, process dies almost instantly, memory limit seems
  tight**: this is the OOM killer, not a bad binary — increase the server's
  memory limit in Pterodactyl's Build Configuration.
- **BBC Radio 2 stream fails only on the server, not locally**: BBC streams
  can be **geo-restricted to the UK**. If your Pterodactyl host's network is
  outside the UK, Akamai may reject the request regardless of correct bot
  code — this isn't something the bot can work around.
- **`@discordjs/opus` fails to build during `npm install`**: this is a
  native addon and can fail on some hosts/containers (missing compiler
  toolchain, unusual CPU arch). It's listed as an `optionalDependency`, so a
  failed build doesn't fail the whole `npm install` — `opusscript` (a pure-JS
  fallback, a regular dependency) is installed alongside it and picked up
  automatically at runtime if the native one isn't available.
- **Auto-update isn't doing anything**: confirm the deployment is a real
  `git clone` (check for a `.git` folder) with an `origin` remote pointing at
  your GitHub repo, and that `AUTO_UPDATE` isn't set to `false`.
- **Bot leaves the channel unexpectedly**: check `AUTO_DISCONNECT_MINUTES` —
  it leaves automatically once every human has left its channel for that
  long.
- **YouTube-sourced playback (`/jamiematt`, Spotify/YouTube links via
  `/play`) fails or was working and stopped**: most likely `yt-dlp` itself
  needs an update to keep up with a YouTube change — it's fetched fresh on
  every `npm install`, so a plain restart (which triggers `boot.js`'s update
  check) often fixes this on its own if a newer release has since shipped.
  If it's still broken, `/status`'s recent-events list and the console's
  `youtubeResolver:`-prefixed warnings are the first things to check.
- **`/jamiematt`/Spotify links via `/play` say they can't reach Spotify**:
  double check `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` are set correctly
  from your Spotify Developer Dashboard app — no other Spotify-side setup
  (redirect URIs, user login) is needed for this bot.
- **A crash/reconnect loop on a YouTube-sourced track specifically, not on
  direct HTTP URLs**: the DNS-resolution SIGSEGV workaround described above
  only covers plain `http://` URLs (YouTube's are `https://`, which can't
  use the same IP-substitution trick without breaking TLS). If this shows up,
  it's a real, currently-unresolved edge case — the finite-track retry logic
  (see Features) will retry a couple of times and post in the channel if it
  gives up, rather than failing silently, but the underlying cause isn't
  fixed by that alone.

## Project layout

```
discord-music-bot/
├── boot.js                    # entry point: GitHub update check, then starts src/index.js
├── bin/                        # downloaded ffmpeg/yt-dlp binaries (gitignored, see scripts/ensure-*.js)
├── scripts/
│   ├── check-stream.js         # standalone ffmpeg smoke test
│   ├── ensure-ffmpeg.js         # postinstall: downloads/self-heals the ffmpeg-static binary
│   └── ensure-ytdlp.js          # postinstall: downloads/self-heals the yt-dlp binary
└── src/
    ├── index.js                # Discord client, command dispatch, alone-disconnect wiring
    ├── deploy-commands.js      # manual/standalone command registration (optional - see below)
    ├── commands/                # one file per slash command (play, radio, jamiematt, status, ...)
    └── lib/
        ├── queueManager.js      # per-guild queue registry
        ├── player.js             # GuildQueue - voice connection + playback state machine
        ├── streams.js            # ffmpeg/HLS -> AudioResource pipeline
        ├── track.js               # track factory (fixed URL, or a lazy resolveUrl for YouTube)
        ├── presets.js             # named stream presets (BBC Radio 2, etc.)
        ├── spotify.js              # Spotify Web API: playlist/track fetch + link-type detection
        ├── youtubeResolver.js      # shells out to yt-dlp: search, URL parsing, stream resolution
        ├── ytdlp.js                # yt-dlp binary path/download-URL resolution
        ├── dailyPlaylist.js        # cached + periodically-refreshed track list for /jamiematt
        ├── enqueue.js             # shared voice-join/enqueue logic for every play-ish command
        ├── aloneWatcher.js        # alone-in-channel auto-disconnect timer
        ├── commandRegistry.js     # shared slash-command registration logic (used by index.js and deploy-commands.js)
        ├── eventLog.js             # in-memory ring buffer of notable events, read by /status
        └── version.js              # cached deployed commit hash, read by /status
```
