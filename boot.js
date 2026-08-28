'use strict';

/**
 * Entry point (see package.json "start"). Runs *before* anything in src/ is
 * required - this ordering matters, because Node caches modules on first
 * require(), so any pulled update has to land on disk before app code loads.
 *
 * This is a boot-time-only check: it looks for a newer commit on GitHub once,
 * at startup, and pulls it in before starting the bot. It deliberately does
 * NOT keep checking while the bot is running, to avoid the complexity/risk of
 * a process restarting itself out from under an active Discord voice
 * connection. New commits take effect the next time the process (re)starts.
 */

require('dotenv').config();

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = __dirname;
const AUTO_UPDATE = (process.env.AUTO_UPDATE ?? 'true').toLowerCase() !== 'false';
const UPDATE_BRANCH = process.env.UPDATE_BRANCH || 'main';
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

function checkForUpdate() {
  if (!AUTO_UPDATE) {
    console.log('AUTO_UPDATE is disabled - skipping GitHub update check.');
    return;
  }

  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    console.log('Not a git checkout - skipping GitHub update check (deploy via "git clone" to enable auto-update).');
    return;
  }

  // A network hiccup here must never prevent the bot from booting on its
  // current code - every git call below is wrapped so failures just fall
  // through to "boot on what's already on disk".
  try {
    git(['fetch', 'origin', UPDATE_BRANCH]);
  } catch (err) {
    console.warn('Update check: git fetch failed, booting on current code.', err.message);
    return;
  }

  let localHead;
  let remoteHead;
  try {
    localHead = git(['rev-parse', 'HEAD']);
    remoteHead = git(['rev-parse', `origin/${UPDATE_BRANCH}`]);
  } catch (err) {
    console.warn('Update check: could not resolve commit hashes, booting on current code.', err.message);
    return;
  }

  if (localHead === remoteHead) {
    console.log(`Up to date (${localHead.slice(0, 7)}).`);
    return;
  }

  console.log(`Update available: ${localHead.slice(0, 7)} -> ${remoteHead.slice(0, 7)}. Pulling...`);

  let changedFiles = [];
  try {
    changedFiles = git(['diff', '--name-only', localHead, remoteHead]).split('\n').filter(Boolean);
  } catch {
    // Non-fatal - just means we won't know below whether to run npm install.
  }

  try {
    // Fast-forward only: deliberately refuses to merge/rebase on a deployed
    // instance. If this fails (e.g. local commits that diverged from
    // origin), fall through and boot on the current code rather than crash.
    git(['pull', '--ff-only', 'origin', UPDATE_BRANCH]);
  } catch (err) {
    console.warn('Update check: git pull --ff-only failed (local changes on the server?). Booting on current code.', err.message);
    return;
  }

  const manifestChanged = changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json');
  if (manifestChanged) {
    console.log('package.json changed - running npm install...');
    try {
      execFileSync(NPM_BIN, ['install', '--omit=dev'], { cwd: REPO_ROOT, stdio: 'inherit' });
    } catch (err) {
      console.error('npm install after update failed - the bot may not start correctly:', err.message);
    }
  }

  console.log(`Updated to ${git(['rev-parse', '--short', 'HEAD'])}.`);
}

checkForUpdate();

require('./src/index.js');
