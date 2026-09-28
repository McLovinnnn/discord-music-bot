'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getBinaryPath, BIN_DIR } = require('./ytdlp');

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;
// yt-dlp can produce a lot of stdout for some queries (format lists etc.) -
// this is generous headroom for the --print/--get-url calls actually used here.
const MAX_BUFFER = 10 * 1024 * 1024;

// On a datacenter/hosting-provider IP, YouTube's bot check can be strict
// enough that forcing a different client (see FALLBACK_EXTRACTOR_ARGS below)
// still isn't enough - confirmed in practice during this project's own
// deployment. The only fully reliable fix at that point is real cookies from
// a logged-in browser session (yt-dlp's own guidance, not something this
// project can automate). If a cookies.txt file (Netscape format - export via
// a browser extension like "Get cookies.txt LOCALLY") is placed at this
// path, it's used automatically; otherwise this is a no-op, so nothing here
// requires cookies to work at all. Lives in bin/ deliberately - already
// gitignored, so a cookies file dropped there never risks being committed.
const COOKIES_PATH = process.env.YTDLP_COOKIES_FILE || path.join(BIN_DIR, 'cookies.txt');

function cookiesArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

/**
 * Extracts a video ID from a direct YouTube link (youtube.com/watch?v=,
 * youtu.be/, music.youtube.com/watch?v=). Pure URL parsing, no yt-dlp call.
 *
 * @param {string} url
 * @returns {string|null}
 */
function parseVideoId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, '').replace(/^music\./, '');
  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1);
    return id || null;
  }
  if (host === 'youtube.com') {
    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v');
    }
    if (parsed.pathname.startsWith('/shorts/')) {
      return parsed.pathname.split('/')[2] || null;
    }
  }
  return null;
}

/**
 * yt-dlp's bundled Python runtime doesn't reliably honor PYTHONIOENCODING
 * when its stdout is a pipe rather than a real console - on Windows this has
 * been observed emitting non-ASCII characters (e.g. the en-dash in "Artist -
 * Title") as raw Windows-1252 bytes instead of UTF-8, which corrupts to the
 * U+FFFD replacement character if decoded as UTF-8. Decoding as UTF-8 first
 * and only falling back to Windows-1252 if that produced a replacement
 * character (rather than assuming the platform) means this self-corrects
 * regardless of whether the same issue does or doesn't show up on the actual
 * Linux deployment target.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeYtdlpOutput(buffer) {
  const asUtf8 = buffer.toString('utf8');
  if (!asUtf8.includes('�')) return asUtf8;
  try {
    return new TextDecoder('windows-1252').decode(buffer);
  } catch {
    return asUtf8;
  }
}

// YouTube's anti-bot checks are markedly stricter for datacenter/hosting-
// provider IPs (exactly what a Pterodactyl host runs on) than for a home
// connection - "Sign in to confirm you're not a bot" can show up even for
// ordinary public videos. Forcing a specific client via --extractor-args is
// the standard workaround, but which client actually works turns out to be
// environment-dependent in a way that isn't safe to hardcode: testing
// several candidates (tv, web_safari, android, ios) against a real,
// *unflagged* connection found every forced client except "android" failed
// outright on format availability (a different failure mode from the bot
// check this is meant to fix), and "android" only worked when combined with
// a more tolerant "bestaudio/best" format selector (see resolveStreamUrl).
//
// So rather than gambling on one hardcoded client working everywhere, this
// tries the default (unforced) client first - which is what actually works
// on an unflagged connection - and only falls back to forcing a client if
// that specific attempt fails. Configurable so the fallback client can be
// tuned without a code change if this stops working (YouTube's checks shift
// every few weeks and yt-dlp ships counter-fixes to match - see
// https://github.com/yt-dlp/yt-dlp/wiki).
const FALLBACK_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || 'youtube:player_client=android';

async function execYtdlp(args) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  const fullArgs = [...cookiesArgs(), ...args];
  const { stdout } = await execFileAsync(getBinaryPath(), fullArgs, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env, encoding: 'buffer' });
  return decodeYtdlpOutput(stdout).trim();
}

async function runYtdlp(args) {
  try {
    return await execYtdlp(args);
  } catch (err) {
    console.warn(`youtubeResolver: default client failed (${err.message.split('\n')[0]}), retrying with ${FALLBACK_EXTRACTOR_ARGS}...`);
    return execYtdlp(['--extractor-args', FALLBACK_EXTRACTOR_ARGS, ...args]);
  }
}

/** yt-dlp expects a URL, not a bare video ID. */
function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Searches YouTube for "<artists> - <title>" and returns the top result's
 * video ID, or null if nothing came back (caller skips the track).
 *
 * @param {string} title
 * @param {string[]} artists
 * @returns {Promise<string|null>}
 */
async function findVideoId(title, artists) {
  const query = `ytsearch1:${artists.join(', ')} - ${title}`;
  try {
    const output = await runYtdlp(['--print', '%(id)s', '--no-warnings', '--skip-download', query]);
    return output || null;
  } catch (err) {
    console.warn(`youtubeResolver: search failed for "${query}": ${err.message}`);
    return null;
  }
}

/**
 * Basic title lookup, used when /play is given a direct YouTube link (where
 * there's no Spotify metadata to display instead).
 *
 * @param {string} videoId
 * @returns {Promise<string>}
 */
async function getTitle(videoId) {
  try {
    return await runYtdlp(['--print', '%(title)s', '--no-warnings', '--skip-download', watchUrl(videoId)]);
  } catch (err) {
    console.warn(`youtubeResolver: title lookup failed for ${videoId}: ${err.message}`);
    return videoId;
  }
}

/**
 * Resolves a direct, playable audio-only stream URL for a video ID.
 * **Called fresh at play time, not cached** - like the HLS DNS-resolution
 * workaround in streams.js, these googlevideo.com URLs are signed/
 * time-limited, so resolving once and reusing later in the day would fail
 * the same way a stale URL would anywhere else in this project.
 *
 * @param {string} videoId
 * @returns {Promise<string>}
 * @throws if no playable audio URL could be resolved.
 */
async function resolveStreamUrl(videoId) {
  // "bestaudio/best" (a fallback chain), not a bare "bestaudio" - some
  // clients' format lists (particularly the "android" fallback client used
  // when the default is blocked, see runYtdlp above) don't include a clean
  // audio-only entry, which "bestaudio" alone fails on outright.
  const url = await runYtdlp(['-f', 'bestaudio/best', '--get-url', '--no-warnings', watchUrl(videoId)]);
  if (!url || !url.startsWith('http')) {
    throw new Error(`yt-dlp returned no playable URL for video ${videoId}`);
  }
  return url;
}

module.exports = { parseVideoId, findVideoId, getTitle, resolveStreamUrl };
