'use strict';

/**
 * Runs as part of this project's postinstall step (see package.json),
 * alongside ensure-ffmpeg.js. Downloads yt-dlp's standalone binary (see
 * src/lib/ytdlp.js for why it has to be fetched manually rather than via an
 * npm package) if missing, and verifies it actually runs - self-healing a
 * corrupted/incomplete download the same way ensure-ffmpeg.js does, since a
 * yt-dlp release is a fairly large (~20-40MB) download that can plausibly
 * fail partway through.
 *
 * Always fetches the *latest* release (not a pinned version) - yt-dlp is a
 * moving target that needs to keep up with YouTube's own changes, so an
 * install pulling in whatever's current is a feature here, not a risk to
 * pin against.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getBinaryPath, getDownloadUrl, BIN_DIR } = require('../src/lib/ytdlp');

function isWorkingBinary(binaryPath) {
  if (!fs.existsSync(binaryPath)) return false;
  const result = spawnSync(binaryPath, ['--version'], { stdio: 'ignore', timeout: 15_000 });
  return !result.error && !result.signal && result.status === 0;
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
  if (process.platform !== 'win32') {
    fs.chmodSync(destPath, 0o755);
  }
}

(async () => {
  let binaryPath;
  try {
    binaryPath = getBinaryPath();
  } catch (err) {
    console.error('ensure-ytdlp:', err.message);
    process.exit(0); // Non-fatal - youtubeResolver.js's own runtime check reports this clearly too.
    return;
  }

  if (isWorkingBinary(binaryPath)) {
    console.log(`ensure-ytdlp: ${binaryPath} runs fine.`);
    return;
  }

  if (fs.existsSync(binaryPath)) {
    console.warn(`ensure-ytdlp: ${binaryPath} exists but doesn't run (corrupted/incomplete download) - deleting and re-downloading...`);
    try {
      fs.unlinkSync(binaryPath);
    } catch (err) {
      console.error(`ensure-ytdlp: failed to delete the broken binary: ${err.message}`);
    }
  } else {
    console.log(`ensure-ytdlp: no yt-dlp binary present yet at ${binaryPath} - downloading...`);
  }

  try {
    const url = getDownloadUrl();
    console.log(`ensure-ytdlp: downloading ${url}`);
    await download(url, binaryPath);
  } catch (err) {
    console.error(`ensure-ytdlp: download failed: ${err.message}`);
  }

  if (isWorkingBinary(binaryPath)) {
    console.log(`ensure-ytdlp: ${binaryPath} now runs fine.`);
  } else {
    console.error(
      `ensure-ytdlp: WARNING - ${binaryPath} still doesn't run after a fresh download. ` +
      'YouTube-sourced playback (/jamiematt, Spotify/YouTube links via /play) will not work until this is resolved.'
    );
  }
})();
