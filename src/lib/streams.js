'use strict';

const fs = require('node:fs');
const dns = require('node:dns').promises;
const { spawnSync } = require('node:child_process');
const prism = require('prism-media');
const { createAudioResource, StreamType } = require('@discordjs/voice');

// Defensive fallback: prism-media auto-detects ffmpeg-static when it's installed,
// but if that detection ever fails to trigger, pointing FFMPEG_PATH at the bundled
// binary directly guarantees a working ffmpeg without relying on one being present
// on the host/container's PATH.
if (!process.env.FFMPEG_PATH) {
  try {
    process.env.FFMPEG_PATH = require('ffmpeg-static');
  } catch {
    // ffmpeg-static not resolvable for some reason - fall through and let
    // prism-media try its own detection / a system "ffmpeg" on PATH.
  }
}

// ffmpeg-static's own installer only checks whether a file exists at the
// expected path, not whether it's actually a runnable binary - a corrupted
// or wrong-architecture download looks "installed" forever after (see
// scripts/ensure-ffmpeg.js, which self-heals this during npm install). This
// is a last-resort check: if a bad binary somehow still made it here, fail
// loudly and clearly at startup - crashing with SIGSEGV/SIGILL a fraction of
// a second into every playback attempt is otherwise a very confusing way to
// find out - instead of only failing the first time someone runs /play. The
// result is cached and exposed via getFfmpegHealth() for /status.
let ffmpegHealth = { ok: false, path: process.env.FFMPEG_PATH || null, detail: 'not checked' };
if (process.env.FFMPEG_PATH) {
  if (!fs.existsSync(process.env.FFMPEG_PATH)) {
    ffmpegHealth.detail = 'binary not found on disk';
    console.error(
      `FFmpeg binary not found at "${process.env.FFMPEG_PATH}". ffmpeg-static's install script may have been skipped ` +
      `(check for "install scripts blocked"/"allowScripts" warnings during npm install). Try: ` +
      `node scripts/ensure-ffmpeg.js`
    );
  } else {
    const check = spawnSync(process.env.FFMPEG_PATH, ['-version'], { stdio: 'ignore', timeout: 10_000 });
    if (check.error || check.signal || check.status !== 0) {
      ffmpegHealth.detail = `does not run (signal=${check.signal}, status=${check.status})`;
      console.error(
        `FFmpeg binary at "${process.env.FFMPEG_PATH}" does not run (signal=${check.signal}, status=${check.status}). ` +
        `This usually means a corrupted/incomplete download or a wrong-architecture binary for this host. Try: ` +
        `node scripts/ensure-ffmpeg.js`
      );
    } else {
      ffmpegHealth = { ok: true, path: process.env.FFMPEG_PATH, detail: null };
    }
  }
} else {
  ffmpegHealth.detail = 'FFMPEG_PATH not set and ffmpeg-static not resolvable';
}

/** @returns {{ok: boolean, path: string|null, detail: string|null}} the startup ffmpeg binary check result. */
function getFfmpegHealth() {
  return ffmpegHealth;
}

/**
 * ffmpeg-static's Linux binary is a fully-static build (from
 * johnvansickle.com). Fully-static glibc binaries are well known to be able
 * to segfault doing DNS lookups, because glibc's NSS mechanism needs to
 * dlopen() resolver modules at runtime, which a static binary can't do
 * reliably - especially in a minimal container image (missing/nonstandard
 * /etc/nsswitch.conf, etc.). That's the exact crash this project hit: ffmpeg
 * dying with SIGSEGV within milliseconds, right as it starts resolving the
 * stream host, with literally nothing logged.
 *
 * The fix: resolve the hostname ourselves in Node (which is dynamically
 * linked and unaffected - this process already does plenty of its own DNS
 * resolution just to reach Discord's gateway) and hand ffmpeg a raw IP
 * address instead, with an explicit "Host" header so name-based virtual
 * hosting/CDN routing (e.g. Akamai) still works correctly. Re-resolving on
 * every call (i.e. every play and every reconnect attempt) also means this
 * naturally tracks a CDN's rotating/load-balanced IPs instead of pinning one.
 *
 * Only applies to plain http:// URLs. For https://, swapping the hostname
 * for an IP would break TLS SNI/certificate validation (the certificate
 * won't match a bare IP), so those are left to ffmpeg's own resolver - which
 * means an https:// stream could still hit this same bug on an affected
 * host. In practice this bot's primary use case (BBC Radio 2, and HLS radio
 * streams generally) tends to be plain HTTP.
 *
 * @param {string} url
 * @returns {Promise<{url: string, headers: string|null}>}
 */
async function resolveForFfmpeg(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:') {
    return { url, headers: null };
  }

  const hostname = parsed.hostname;
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    parsed.hostname = address;
    return { url: parsed.toString(), headers: `Host: ${hostname}\r\n` };
  } catch (err) {
    console.warn(`Failed to pre-resolve "${hostname}" in Node (falling back to ffmpeg's own DNS resolution, which may be unreliable): ${err.message}`);
    return { url, headers: null };
  }
}

/**
 * Build the ffmpeg argument list that turns a direct audio/HLS URL into raw
 * PCM suitable for createAudioResource. Used identically for live and finite
 * tracks - there is no live/non-live branching at this layer, only in
 * GuildQueue's handling of what happens once the resulting resource goes idle.
 *
 * -reconnect / -reconnect_streamed / -reconnect_delay_max: ffmpeg's own
 *   HTTP-level reconnect for dropped HLS segment fetches - the first line of
 *   defense against an Akamai connection blip, before GuildQueue's own
 *   process-level respawn logic (the second line of defense) ever needs to
 *   trigger.
 * -headers: only set when resolveForFfmpeg() rewrote the URL to a raw IP -
 *   restores the original hostname as the Host header (see above).
 * -analyzeduration 0 / -loglevel warning: start playback faster and keep
 *   ffmpeg's stderr limited to things actually worth logging.
 * -f s16le -ar 48000 -ac 2: raw 16-bit PCM, stereo, 48kHz - required (rather
 *   than having ffmpeg output Opus directly) because createAudioResource's
 *   inlineVolume transformer needs raw samples to apply /volume; it can't run
 *   on already-Opus-encoded frames.
 *
 * Deliberately does NOT include an output target (e.g. "pipe:1") - callers
 * that spawn ffmpeg directly (scripts/check-stream.js) need to append one
 * themselves, but createResource() below goes through prism-media's
 * FFmpeg class, which always appends "pipe:1" to whatever args it's given.
 * Adding it here too would specify the output twice and break playback -
 * see the git history for that exact bug.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.logLevel] - defaults to "warning" (production).
 *   scripts/check-stream.js can pass "debug" for troubleshooting - a crash
 *   this early is often gone before anything at "warning" severity gets
 *   logged, so a noisier level is sometimes the only way to see what ffmpeg
 *   was doing (e.g. "Opening ... for reading") right before it died.
 * @param {string} [options.headers] - see resolveForFfmpeg().
 * @returns {string[]}
 */
function buildFfmpegArgs(url, { logLevel = 'warning', headers } = {}) {
  const args = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];
  if (headers) {
    args.push('-headers', headers);
  }
  args.push(
    '-i', url,
    '-analyzeduration', '0',
    '-loglevel', logLevel,
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
  );
  return args;
}

/**
 * Create a playable AudioResource for a track, backed by a freshly spawned
 * ffmpeg process. Because the pipeline is streamed end-to-end (ffmpeg stdout ->
 * Transform -> AudioResource, pulled 20ms-frame-at-a-time by @discordjs/voice)
 * nothing here ever buffers a whole "track" up front - which is required for
 * live streams, which have no end.
 *
 * @param {{url: string, title: string}} track
 * @param {object} [options]
 * @param {number} [options.volume] - initial volume, 0-2 (1 = 100%).
 * @param {(message: string) => void} [options.onEvent] - called for notable,
 *   non-routine events (an unexpected exit, a suspected OOM kill) so callers
 *   can surface them somewhere more durable than the console (see
 *   src/lib/player.js, which routes this into src/lib/eventLog.js). Kept
 *   generic/optional here - this module doesn't know about guilds or the
 *   event log, callers decide what to do with it.
 * @returns {Promise<{resource: import('@discordjs/voice').AudioResource, ffmpegProcess: import('child_process').ChildProcess, destroy: () => void}>}
 */
async function createResource(track, { volume = 1, onEvent } = {}) {
  const { url, headers } = await resolveForFfmpeg(track.url);
  const ffmpeg = new prism.FFmpeg({ args: buildFfmpegArgs(url, { headers }) });
  const ffmpegProcess = ffmpeg.process;

  // ffmpeg's stderr is where Akamai HTTP errors, segment-fetch failures, etc.
  // actually surface - invaluable for diagnosing stream drops in production.
  if (ffmpegProcess && ffmpegProcess.stderr) {
    ffmpegProcess.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        console.warn(`[ffmpeg:${track.title}] ${line}`);
      }
    });
  }
  if (ffmpegProcess) {
    ffmpegProcess.on('error', (err) => {
      console.error(`[ffmpeg:${track.title}] process error:`, err);
    });
    // If ffmpeg gets killed outright (e.g. the container's memory limit
    // OOM-kills it) it can die without ever writing to stderr - stderr data
    // and process errors alone won't show that. This is the only place that
    // reliably surfaces it: a SIGKILL exit with a short lifetime and no
    // preceding log output is the signature of an OOM kill, not a stream/
    // network problem.
    const spawnedAt = Date.now();
    ffmpegProcess.on('exit', (code, signal) => {
      const aliveMs = Date.now() - spawnedAt;
      console.warn(`[ffmpeg:${track.title}] process exited after ${aliveMs}ms (code=${code}, signal=${signal})`);
      if (signal === 'SIGKILL' && aliveMs < 5000) {
        console.warn(`[ffmpeg:${track.title}] this looks like an OOM kill (killed almost immediately, no prior output) - check the server's memory limit in Pterodactyl.`);
        onEvent?.(`ffmpeg for **${track.title}** was killed almost instantly (signal=SIGKILL) - looks like an OOM kill.`);
      } else if (signal || (code !== 0 && code !== null)) {
        onEvent?.(`ffmpeg for **${track.title}** exited unexpectedly after ${aliveMs}ms (code=${code}, signal=${signal}).`);
      }
    });
  }

  ffmpeg.on('error', (err) => {
    // Surface transform-stream errors too - not all failures cleanly show up
    // as a process 'error'/'exit' event.
    console.error(`[ffmpeg:${track.title}] stream error:`, err.message);
  });

  const resource = createAudioResource(ffmpeg, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: track,
  });
  resource.volume.setVolume(volume);

  const destroy = () => {
    ffmpeg.destroy();
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill('SIGKILL');
    }
  };

  return { resource, ffmpegProcess, destroy };
}

module.exports = { createResource, buildFfmpegArgs, resolveForFfmpeg, getFfmpegHealth };
