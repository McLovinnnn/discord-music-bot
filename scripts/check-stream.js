'use strict';

/**
 * Standalone smoke test: spawns ffmpeg against a stream URL and confirms PCM
 * bytes come back within a timeout, without touching Discord at all. Useful
 * both for local dev and as a Pterodactyl troubleshooting step that isolates
 * "network/ffmpeg problem" from "bot code problem".
 *
 * Usage: npm run check-stream [-- <url>]
 * Defaults to the BBC Radio 2 preset if no URL is given.
 */

const { spawn } = require('child_process');
const { BBC_RADIO_TWO } = require('../src/lib/presets');
const { buildFfmpegArgs } = require('../src/lib/streams');

const TIMEOUT_MS = 10_000;
const url = process.argv[2] || BBC_RADIO_TWO.url;

let ffmpegPath;
try {
  ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
} catch {
  ffmpegPath = 'ffmpeg';
}

console.log(`Checking stream: ${url}`);
console.log(`Using ffmpeg binary: ${ffmpegPath}`);

const child = spawn(ffmpegPath, buildFfmpegArgs(url));

let bytesReceived = 0;
let settled = false;

const timer = setTimeout(() => {
  finish(bytesReceived > 0);
}, TIMEOUT_MS);

child.stdout.on('data', (chunk) => {
  bytesReceived += chunk.length;
  if (bytesReceived >= 65536 && !settled) {
    // Got a healthy chunk of PCM well before the timeout - no need to wait longer.
    finish(true);
  }
});

child.stderr.on('data', (chunk) => {
  const line = chunk.toString().trim();
  if (line) {
    console.warn(`[ffmpeg] ${line}`);
  }
});

child.on('error', (err) => {
  console.error('Failed to spawn ffmpeg:', err.message);
  finish(false);
});

child.on('exit', (code) => {
  if (!settled && bytesReceived === 0) {
    console.error(`ffmpeg exited (code ${code}) before producing any audio.`);
    finish(false);
  }
});

function finish(success) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (!child.killed) {
    child.kill('SIGKILL');
  }

  if (success) {
    console.log(`OK: received ${bytesReceived} bytes of PCM from the stream.`);
    process.exit(0);
  } else {
    console.error(`FAILED: no audio received from the stream within ${TIMEOUT_MS}ms.`);
    process.exit(1);
  }
}
