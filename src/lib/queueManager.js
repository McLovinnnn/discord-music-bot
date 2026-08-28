'use strict';

const { GuildQueue } = require('./player');
const { checkAlone } = require('./aloneWatcher');

/** @type {Map<string, GuildQueue>} */
const queues = new Map();

/** @returns {GuildQueue|undefined} */
function getQueue(guildId) {
  return queues.get(guildId);
}

/**
 * Returns the guild's existing queue, or creates and connects a new one.
 * Resolves only once the voice connection is Ready.
 *
 * @param {string} guildId
 * @param {object} options
 * @param {import('discord.js').VoiceBasedChannel} options.voiceChannel
 * @param {import('discord.js').TextBasedChannel} [options.textChannel]
 * @param {Function} options.adapterCreator
 * @param {number} [options.volume]
 * @returns {Promise<GuildQueue>}
 */
async function getOrCreateQueue(guildId, { voiceChannel, textChannel, adapterCreator, volume }) {
  const existing = queues.get(guildId);
  if (existing && !existing.destroyed) {
    return existing;
  }

  const queue = new GuildQueue({
    guildId,
    voiceChannel,
    textChannel,
    adapterCreator,
    volume,
    onDestroyed: () => {
      // Only remove ourselves if we're still the registered queue for this
      // guild - avoids a late destroy() clobbering a newer queue that has
      // since replaced us in the map.
      if (queues.get(guildId) === queue) {
        queues.delete(guildId);
      }
    },
  });
  queues.set(guildId, queue);

  await queue.waitUntilReady();
  // Covers the edge case of joining a channel that's already empty (or the
  // requester leaving the instant the bot connects) - normally the next
  // VoiceStateUpdate handles this, but this check fires immediately too.
  checkAlone(queue, voiceChannel);
  return queue;
}

function deleteQueue(guildId) {
  const queue = queues.get(guildId);
  if (queue) {
    queue.destroy();
  }
}

/** Destroys every active queue - used on process shutdown/crash. */
function destroyAll() {
  for (const queue of queues.values()) {
    queue.destroy();
  }
}

module.exports = { getQueue, getOrCreateQueue, deleteQueue, destroyAll };
