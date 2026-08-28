'use strict';

/**
 * A small in-memory ring buffer of notable events (reconnect attempts,
 * give-ups, ffmpeg crashes, voice disconnects) for the /status command to
 * surface. Deliberately not persisted - this is "recent history for
 * diagnosing what just happened", not an audit log; resetting on restart is
 * expected and fine.
 */

const MAX_ENTRIES = 30;

/** @type {Array<{timestamp: number, guildId: string, message: string}>} */
const entries = [];

/**
 * @param {string} guildId
 * @param {string} message
 */
function log(guildId, message) {
  entries.push({ timestamp: Date.now(), guildId, message });
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

/**
 * @param {string} guildId
 * @param {number} [limit]
 * @returns {Array<{timestamp: number, guildId: string, message: string}>} newest first
 */
function getRecent(guildId, limit = 5) {
  const forGuild = entries.filter((entry) => entry.guildId === guildId);
  return forGuild.slice(-limit).reverse();
}

module.exports = { log, getRecent };
