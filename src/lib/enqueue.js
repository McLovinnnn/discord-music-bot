'use strict';

const { getOrCreateQueue } = require('./queueManager');

const DEFAULT_VOLUME = Number(process.env.DEFAULT_VOLUME || 100) / 100;

/**
 * Shared entry point for /play and /radio: validates the caller is in a
 * voice channel the bot can join and speak in, gets-or-creates that guild's
 * queue, enqueues the track, and starts playback if nothing is currently
 * playing. Keeping this logic here means play.js and radio.js don't
 * duplicate the voice-channel/permission checks.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{url: string, title: string, requestedBy: string, isLive: boolean}} track
 */
async function enqueueAndPlay(interaction, track) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    return;
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
    await interaction.reply({ content: 'I need **Connect** and **Speak** permissions in that voice channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  let queue;
  try {
    queue = await getOrCreateQueue(interaction.guildId, {
      voiceChannel,
      textChannel: interaction.channel,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      volume: DEFAULT_VOLUME,
    });
  } catch (err) {
    await interaction.editReply(`Couldn't join the voice channel: ${err.message}`);
    return;
  }

  const wasIdle = !queue.currentTrack;
  queue.enqueue(track);
  await queue.ensurePlaying();

  const label = `**${track.title}**${track.isLive ? ' (LIVE)' : ''}`;
  await interaction.editReply(wasIdle ? `Now playing ${label}.` : `Added ${label} to the queue.`);
}

module.exports = { enqueueAndPlay, DEFAULT_VOLUME };
