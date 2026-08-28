'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getQueue } = require('../lib/queueManager');

const MAX_LISTED = 10;

module.exports = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || (!queue.currentTrack && queue.tracks.length === 0)) {
      await interaction.reply({ content: 'The queue is empty.', ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder().setTitle('Queue');

    if (queue.currentTrack) {
      const live = queue.currentTrack.isLive ? ' (LIVE)' : '';
      embed.addFields({
        name: 'Now Playing',
        value: `${queue.currentTrack.title}${live} — requested by ${queue.currentTrack.requestedBy}`,
      });
    }

    if (queue.tracks.length > 0) {
      const lines = queue.tracks
        .slice(0, MAX_LISTED)
        .map((track, i) => `${i + 1}. ${track.title} — requested by ${track.requestedBy}`);
      if (queue.tracks.length > MAX_LISTED) {
        lines.push(`+${queue.tracks.length - MAX_LISTED} more`);
      }
      embed.addFields({ name: 'Up Next', value: lines.join('\n') });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
