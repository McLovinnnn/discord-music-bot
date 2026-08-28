'use strict';

/**
 * Runs as this project's postinstall step (see package.json). ffmpeg-static's
 * own installer only checks whether a file exists at the expected path, not
 * whether it's actually a valid, runnable binary - so a corrupted or
 * incomplete download (e.g. an interrupted npm install) gets treated as
 * "already installed" forever after and never repairs itself.
 *
 * This verifies the binary actually runs (`ffmpeg -version`) and, if it
 * doesn't, deletes it and forces a fresh download before verifying again.
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function isWorkingBinary(binaryPath) {
  if (!fs.existsSync(binaryPath)) return false;
  const result = spawnSync(binaryPath, ['-version'], { stdio: 'ignore', timeout: 10_000 });
  // A crash (SIGSEGV/SIGILL/etc. - wrong architecture or a corrupted/
  // truncated download are the usual causes) shows up as `result.signal`;
  // a normal failure to run shows up as `result.error`.
  return !result.error && !result.signal && result.status === 0;
}

function runInstaller() {
  const result = spawnSync(process.execPath, [require.resolve('ffmpeg-static/install.js')], { stdio: 'inherit' });
  return !result.error && result.status === 0;
}

let binaryPath;
try {
  binaryPath = require('ffmpeg-static');
} catch (err) {
  console.error('ensure-ffmpeg: could not resolve the ffmpeg-static package at all:', err.message);
  process.exit(0); // Non-fatal - streams.js's own runtime check will report this clearly too.
}

if (isWorkingBinary(binaryPath)) {
  console.log(`ensure-ffmpeg: ${binaryPath} runs fine.`);
  process.exit(0);
}

if (fs.existsSync(binaryPath)) {
  console.warn(`ensure-ffmpeg: ${binaryPath} exists but doesn't run (wrong architecture or a corrupted/incomplete download) - deleting and re-downloading...`);
  try {
    fs.unlinkSync(binaryPath);
  } catch (err) {
    console.error(`ensure-ffmpeg: failed to delete the broken binary: ${err.message}`);
  }
} else {
  console.log('ensure-ffmpeg: no ffmpeg binary present yet - downloading...');
}

runInstaller();

if (isWorkingBinary(binaryPath)) {
  console.log(`ensure-ffmpeg: ${binaryPath} now runs fine.`);
} else {
  console.error(
    `ensure-ffmpeg: WARNING - ${binaryPath} still doesn't run after a fresh download. ` +
    'ffmpeg-static may not publish a working binary for this host\'s CPU architecture/OS. ' +
    'Audio playback will not work until this is resolved (see README troubleshooting).'
  );
}
