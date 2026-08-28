'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * The commit currently checked out, resolved once at module load. Reflects
 * whatever boot.js already pulled onto disk before src/index.js (and
 * therefore this module) was ever required - so it always matches the code
 * actually running, not just what's in package.json.
 *
 * @type {string}
 */
let commitHash;
try {
  commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch {
  commitHash = 'unknown (not a git checkout)';
}

module.exports = { COMMIT_HASH: commitHash };
