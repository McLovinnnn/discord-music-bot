'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { createTrack } = require('../lib/track');
const { enqueueAndPlay } = require('../lib/enqueue');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a direct audio/HLS stream URL')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('Direct audio or HLS (.m3u8) stream URL')
        .setRequired(true)
    ),
  async execute(interaction) {
    const url = interaction.options.getString('url', true);

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      await interaction.reply({
        content: "That doesn't look like a valid URL. `/play` only supports direct audio/HLS stream URLs (no search, no YouTube) — try `/radio` for a preset station.",
        ephemeral: true,
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      await interaction.reply({ content: 'Only http(s) URLs are supported.', ephemeral: true });
      return;
    }

    const track = createTrack({ url, requestedBy: interaction.user.tag });
    await enqueueAndPlay(interaction, track);
  },
};
