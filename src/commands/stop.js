'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getQueue, deleteQueue } = require('../lib/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop playback, clear the queue, and leave the channel'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue) {
      await interaction.reply({ content: "I'm not in a voice channel.", ephemeral: true });
      return;
    }

    deleteQueue(interaction.guildId);
    await interaction.reply('Stopped and left the channel.');
  },
};
