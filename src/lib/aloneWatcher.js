'use strict';

const AUTO_DISCONNECT_MS = Number(process.env.AUTO_DISCONNECT_MINUTES || 5) * 60_000;

/**
 * Checks whether a guild's voice channel currently has any non-bot members
 * in it, and starts/clears that queue's "alone" disconnect timer accordingly.
 * Called both right after joining a channel and on every relevant
 * VoiceStateUpdate (see src/index.js).
 *
 * @param {import('./player').GuildQueue} queue
 * @param {import('discord.js').VoiceBasedChannel|undefined} voiceChannel
 */
function checkAlone(queue, voiceChannel) {
  if (!queue || queue.destroyed || !voiceChannel) return;

  const humanCount = voiceChannel.members.filter((member) => !member.user.bot).size;

  if (humanCount === 0) {
    if (!queue.aloneTimer) {
      queue.aloneTimer = setTimeout(() => {
        queue.aloneTimer = null;
        if (queue.destroyed) return;
        queue.notify('Left the channel — no one was listening.');
        queue.destroy();
      }, AUTO_DISCONNECT_MS);
    }
  } else if (queue.aloneTimer) {
    clearTimeout(queue.aloneTimer);
    queue.aloneTimer = null;
  }
}

module.exports = { checkAlone, AUTO_DISCONNECT_MS };
