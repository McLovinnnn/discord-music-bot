'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../lib/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.currentTrack) {
      await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
      return;
    }

    const title = queue.currentTrack.title;
    queue.skip();
    await interaction.reply(`Skipped **${title}**.`);
  },
};
