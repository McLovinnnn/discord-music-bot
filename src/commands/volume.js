'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../lib/queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the playback volume')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Volume percentage (0-200)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200)
    ),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue) {
      await interaction.reply({ content: "I'm not in a voice channel.", ephemeral: true });
      return;
    }

    const level = interaction.options.getInteger('level', true);
    queue.setVolume(level / 100);
    await interaction.reply(`Volume set to ${level}%.`);
  },
};
