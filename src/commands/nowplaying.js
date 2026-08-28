'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getQueue } = require('../lib/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show what is currently playing'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.currentTrack) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }

    const track = queue.currentTrack;
    const embed = new EmbedBuilder()
      .setTitle(track.title)
      .addFields({ name: 'Requested by', value: track.requestedBy, inline: true });

    if (track.isLive) {
      // Live streams have no fixed duration and can't be seeked, so we
      // deliberately show a LIVE badge instead of a duration/progress bar.
      embed.addFields({ name: 'Status', value: '🔴 LIVE', inline: true });
    } else {
      const elapsedMs = queue.currentStream?.resource?.playbackDuration ?? 0;
      embed.addFields({ name: 'Elapsed', value: formatDuration(elapsedMs), inline: true });
    }

    await interaction.reply({ embeds: [embed] });
  },
};

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
