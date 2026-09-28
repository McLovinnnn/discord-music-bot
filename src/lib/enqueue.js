'use strict';

const { getOrCreateQueue } = require('./queueManager');

const DEFAULT_VOLUME = Number(process.env.DEFAULT_VOLUME || 100) / 100;

/**
 * Shared by every enqueue path (/play, /radio, /jamiematt, Spotify/YouTube
 * links via /play): validates the caller is in a voice channel the bot can
 * join and speak in, defers the reply, and gets-or-creates that guild's
 * queue. Returns the queue, or null after already replying with an error -
 * callers just need to bail out when they get null back.
 *
 * Deliberately does the voice-channel checks and defers the reply *before*
 * any slow work (Spotify API calls, YouTube resolution) - Discord requires
 * a reply or a deferral within 3 seconds of the interaction, and resolving
 * a Spotify playlist's worth of YouTube matches easily takes longer than
 * that. Callers with slow resolution to do (see playOnQueue below) should
 * call this first, then do that work, then call playOnQueue - not the other
 * way around.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<import('./player').GuildQueue|null>}
 */
async function joinAndGetQueue(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    return null;
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
    await interaction.reply({ content: 'I need **Connect** and **Speak** permissions in that voice channel.', ephemeral: true });
    return null;
  }

  await interaction.deferReply();

  try {
    return await getOrCreateQueue(interaction.guildId, {
      voiceChannel,
      textChannel: interaction.channel,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      volume: DEFAULT_VOLUME,
    });
  } catch (err) {
    await interaction.editReply(`Couldn't join the voice channel: ${err.message}`);
    return null;
  }
}

function trackLabel(track) {
  return `**${track.title}**${track.isLive ? ' (LIVE)' : ''}`;
}

/**
 * Enqueues one or more already-resolved tracks onto a queue obtained from
 * joinAndGetQueue, starts playback if idle, and edits the (already deferred)
 * reply. Split out from joinAndGetQueue specifically so callers that need to
 * do slow resolution work (Spotify/YouTube) can do it *between* the two -
 * join+defer first, resolve, then this.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('./player').GuildQueue} queue
 * @param {Array<{url: string, title: string, requestedBy: string, isLive: boolean}>} tracks
 */
async function playOnQueue(interaction, queue, tracks) {
  if (tracks.length === 0) {
    await interaction.editReply('No playable tracks found.');
    return;
  }

  const wasIdle = !queue.currentTrack;
  for (const track of tracks) {
    queue.enqueue(track);
  }
  await queue.ensurePlaying();

  if (tracks.length === 1) {
    const label = trackLabel(tracks[0]);
    await interaction.editReply(wasIdle ? `Now playing ${label}.` : `Added ${label} to the queue.`);
    return;
  }

  const rest = tracks.length - 1;
  const suffix = rest > 0 ? ` (+${rest} more queued)` : '';
  await interaction.editReply(wasIdle ? `Now playing ${trackLabel(tracks[0])}${suffix}.` : `Added ${tracks.length} tracks to the queue.`);
}

/**
 * Convenience wrapper for the common case: a single track that's already
 * fully known up front (no slow resolution needed in between), e.g. /radio
 * or a direct-URL /play. For anything that needs to resolve tracks *after*
 * joining (to keep the reply deferred within Discord's 3-second window),
 * use joinAndGetQueue + playOnQueue directly instead.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{url: string, title: string, requestedBy: string, isLive: boolean}} track
 */
async function enqueueAndPlay(interaction, track) {
  const queue = await joinAndGetQueue(interaction);
  if (!queue) return;
  await playOnQueue(interaction, queue, [track]);
}

module.exports = { enqueueAndPlay, joinAndGetQueue, playOnQueue, DEFAULT_VOLUME };
