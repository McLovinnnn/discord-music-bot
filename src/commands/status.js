'use strict';

const { SlashCommandBuilder, EmbedBuilder, time } = require('discord.js');
const { getQueue } = require('../lib/queueManager');
const { getRecent } = require('../lib/eventLog');
const { getFfmpegHealth } = require('../lib/streams');
const { COMMIT_HASH } = require('../lib/version');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot health/diagnostics: version, uptime, ffmpeg status, and recent events'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    const ffmpeg = getFfmpegHealth();
    const memoryMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

    const embed = new EmbedBuilder()
      .setTitle('Bot Status')
      .addFields(
        { name: 'Commit', value: `\`${COMMIT_HASH}\``, inline: true },
        {
          name: 'Uptime',
          value: interaction.client.uptime ? formatUptime(interaction.client.uptime) : 'unknown',
          inline: true,
        },
        { name: 'Memory', value: `${memoryMb} MB`, inline: true },
        { name: 'ffmpeg', value: ffmpeg.ok ? '✅ OK' : `⚠️ ${ffmpeg.detail || 'not OK'}`, inline: true },
      );

    if (queue && !queue.destroyed) {
      const trackLine = queue.currentTrack
        ? `${queue.currentTrack.title}${queue.currentTrack.isLive ? ' (LIVE)' : ''}`
        : '(queue empty, idle)';
      embed.addFields(
        { name: 'This server', value: `Connected — ${trackLine}` },
        { name: 'Reconnects this session', value: String(queue.reconnectCount), inline: true },
      );
    } else {
      embed.addFields({ name: 'This server', value: 'Not connected to a voice channel.' });
    }

    const recent = getRecent(interaction.guildId, 5);
    embed.addFields({
      name: 'Recent events',
      value: recent.length > 0
        ? recent.map((entry) => `${time(new Date(entry.timestamp), 'R')} — ${entry.message}`).join('\n')
        : 'None recorded this session.',
    });

    await interaction.reply({ embeds: [embed] });
  },
};

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}
