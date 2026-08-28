'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../lib/queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.currentTrack) {
      await interaction.reply({ content: 'Nothing to resume.', ephemeral: true });
      return;
    }

    const note = queue.currentTrack.isLive
      ? ' (note: resuming live radio catches up to live — it does not resume from where it left off)'
      : '';
    queue.resume();
    await interaction.reply(`Resumed.${note}`);
  },
};
