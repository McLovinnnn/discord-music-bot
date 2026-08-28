'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../lib/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.currentTrack) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }

    queue.pause();
    await interaction.reply('Paused.');
  },
};
