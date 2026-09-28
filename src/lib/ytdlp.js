'use strict';

const path = require('node:path');

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * yt-dlp has no npm-managed binary distribution that doesn't require a
 * system Python (the `yt-dlp-exec` package assumes one is present, and the
 * bare `yt-dlp` GitHub release asset is a lightweight Python zipapp, not a
 * standalone binary - only the platform-suffixed assets are fully
 * self-contained, PyInstaller-bundled binaries with no Python dependency).
 * So this project downloads and manages it manually (see
 * scripts/ensure-ytdlp.js), the same way ffmpeg-static's binary is verified/
 * self-healed, just without an npm package doing the download for us.
 *
 * @returns {string} the local path yt-dlp is expected to live at.
 */
function getBinaryPath() {
  return path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

/**
 * Maps the current platform/arch to the correct GitHub release asset.
 * Deliberately only covers win32/x64 (local dev) and linux/x64+arm64 (the
 * actual Pterodactyl deployment target, confirmed glibc-based - not musl) -
 * covers what this project actually runs on rather than every platform
 * yt-dlp itself publishes for.
 *
 * @returns {string} the asset filename to fetch from the latest GitHub release.
 * @throws if the current platform/arch isn't one of the above.
 */
function getReleaseAssetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
    return 'yt-dlp_linux';
  }
  throw new Error(`No known yt-dlp standalone binary for platform "${process.platform}" (arch "${process.arch}").`);
}

function getDownloadUrl() {
  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${getReleaseAssetName()}`;
}

module.exports = { getBinaryPath, getDownloadUrl, BIN_DIR };
