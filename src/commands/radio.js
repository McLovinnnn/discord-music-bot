'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { PRESETS, getPreset } = require('../lib/presets');
const { createTrack } = require('../lib/track');
const { enqueueAndPlay } = require('../lib/enqueue');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Play a preset live radio station')
    .addStringOption((option) =>
      option
        .setName('station')
        .setDescription('Which station to play')
        .setRequired(false)
        .addChoices(...PRESETS.map((preset) => ({ name: preset.name, value: preset.key })))
    ),
  async execute(interaction) {
    const key = interaction.options.getString('station') || PRESETS[0].key;
    const preset = getPreset(key);
    if (!preset) {
      await interaction.reply({ content: 'Unknown station.', ephemeral: true });
      return;
    }

    const track = createTrack({
      url: preset.url,
      title: preset.name,
      requestedBy: interaction.user.tag,
      isLive: true,
    });
    await enqueueAndPlay(interaction, track);
  },
};
