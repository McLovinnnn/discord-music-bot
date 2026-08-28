# discord-music-bot

A Discord slash-command music bot with a queue, built to reliably stream live
HLS radio (BBC Radio 2 by default) as well as any direct audio/stream URL,
with live-stream-aware reconnect, pause/resume, an alone-in-channel
auto-disconnect, and a boot-time GitHub auto-updater — designed to be deployed
on a [Pterodactyl](https://pterodactyl.io/) panel.

## Features

- `/play <url>` — play any direct audio or HLS (`.m3u8`) stream URL.
- `/radio [station]` — play a preset station (BBC Radio 2 by default).
- `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/nowplaying`, `/volume`.
- Automatically reconnects a live stream if the upstream connection drops.
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

## 3. Deploying to Pterodactyl

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

- **ffmpeg not found / no audio at all**: run `npm run check-stream` (add
  `-- <url>` to test a different stream) — it isolates the ffmpeg/network
  path from the rest of the bot. If it fails on the Pterodactyl host but
  works locally, see the geo-blocking note below.
- **Bot joins the channel but immediately says "Lost connection... attempting
  to reconnect", with `[ffmpeg:...] process exited after N ms (signal=SIGSEGV`
  or similar in the console**: this means the ffmpeg *binary itself* is
  crashing on startup, near-instantly, every time — not a network/stream
  issue. It almost always means the downloaded `ffmpeg-static` binary is bad
  (corrupted/incomplete download, or the wrong CPU architecture for the
  host). `npm install` now runs `scripts/ensure-ffmpeg.js` as its postinstall
  step, which verifies the binary actually runs (not just that a file
  exists) and re-downloads it if not — so a fresh `npm install` should
  self-heal this. If it's still broken after that, the host's architecture
  may not have a published `ffmpeg-static` release at all (see the ARM note
  below). (If `signal=SIGKILL` instead, that's different — see the memory
  note below.)
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

## Project layout

```
discord-music-bot/
├── boot.js                    # entry point: GitHub update check, then starts src/index.js
├── scripts/check-stream.js    # standalone ffmpeg smoke test
└── src/
    ├── index.js                # Discord client, command dispatch, alone-disconnect wiring
    ├── deploy-commands.js      # manual/standalone command registration (optional - see below)
    ├── commands/                # one file per slash command
    └── lib/
        ├── queueManager.js      # per-guild queue registry
        ├── player.js             # GuildQueue - voice connection + playback state machine
        ├── streams.js            # ffmpeg/HLS -> AudioResource pipeline
        ├── track.js               # track factory
        ├── presets.js             # named stream presets (BBC Radio 2, etc.)
        ├── enqueue.js             # shared /play + /radio voice-join/enqueue logic
        ├── aloneWatcher.js        # alone-in-channel auto-disconnect timer
        └── commandRegistry.js     # shared slash-command registration logic (used by index.js and deploy-commands.js)
```
