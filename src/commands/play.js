'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { createTrack } = require('../lib/track');
const { enqueueAndPlay, joinAndGetQueue, playOnQueue } = require('../lib/enqueue');
const spotify = require('../lib/spotify');
const youtubeResolver = require('../lib/youtubeResolver');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a direct audio/HLS URL, a Spotify track/playlist link, or a YouTube link')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('URL to play')
        .setRequired(true)
    ),
  async execute(interaction) {
    const input = interaction.options.getString('url', true);

    const spotifyLink = spotify.parseLink(input);
    if (spotifyLink?.type === 'playlist') {
      await playSpotifyPlaylist(interaction, spotifyLink.id);
      return;
    }
    if (spotifyLink?.type === 'track') {
      await playSpotifyTrack(interaction, spotifyLink.id);
      return;
    }

    const youtubeVideoId = youtubeResolver.parseVideoId(input);
    if (youtubeVideoId) {
      await playYoutubeLink(interaction, youtubeVideoId);
      return;
    }

    await playDirectUrl(interaction, input);
  },
};

/**
 * Spotify playlist and track resolution both need a Spotify API call plus
 * one-or-more YouTube lookups - slow enough that, like /jamiematt, the
 * reply has to be deferred (via joinAndGetQueue) *before* doing that work,
 * not after.
 */
async function playSpotifyPlaylist(interaction, playlistId) {
  const queue = await joinAndGetQueue(interaction);
  if (!queue) return;

  let spotifyTracks;
  try {
    spotifyTracks = await spotify.fetchPlaylistTracks(playlistId);
  } catch (err) {
    await interaction.editReply(`Couldn't load that Spotify playlist: ${err.message}`);
    return;
  }

  const tracks = [];
  for (const t of spotifyTracks) {
    const videoId = await youtubeResolver.findVideoId(t.title, t.artists);
    if (!videoId) continue;
    tracks.push(
      createTrack({
        title: `${t.artists.join(', ')} - ${t.title}`,
        requestedBy: interaction.user.tag,
        isLive: false,
        resolveUrl: () => youtubeResolver.resolveStreamUrl(videoId),
      })
    );
  }

  await playOnQueue(interaction, queue, tracks);
}

async function playSpotifyTrack(interaction, trackId) {
  const queue = await joinAndGetQueue(interaction);
  if (!queue) return;

  let spotifyTrack;
  try {
    spotifyTrack = await spotify.fetchTrack(trackId);
  } catch (err) {
    await interaction.editReply(`Couldn't load that Spotify track: ${err.message}`);
    return;
  }

  const videoId = await youtubeResolver.findVideoId(spotifyTrack.title, spotifyTrack.artists);
  if (!videoId) {
    await interaction.editReply(`Couldn't find a YouTube match for **${spotifyTrack.artists.join(', ')} - ${spotifyTrack.title}**.`);
    return;
  }

  const track = createTrack({
    title: `${spotifyTrack.artists.join(', ')} - ${spotifyTrack.title}`,
    requestedBy: interaction.user.tag,
    isLive: false,
    resolveUrl: () => youtubeResolver.resolveStreamUrl(videoId),
  });
  await playOnQueue(interaction, queue, [track]);
}

/**
 * A direct YouTube link already identifies the video - no search needed -
 * so this only needs one (fast) title lookup, but still routes through the
 * join-first/defer-first ordering for consistency and because that lookup
 * is still a network call.
 */
async function playYoutubeLink(interaction, videoId) {
  const queue = await joinAndGetQueue(interaction);
  if (!queue) return;

  const title = await youtubeResolver.getTitle(videoId);
  const track = createTrack({
    title,
    requestedBy: interaction.user.tag,
    isLive: false,
    resolveUrl: () => youtubeResolver.resolveStreamUrl(videoId),
  });
  await playOnQueue(interaction, queue, [track]);
}

async function playDirectUrl(interaction, input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    await interaction.reply({
      content: "That doesn't look like a valid URL. Try a direct audio/HLS stream URL, a Spotify track/playlist link, or a YouTube link.",
      ephemeral: true,
    });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    await interaction.reply({ content: 'Only http(s) URLs are supported.', ephemeral: true });
    return;
  }

  const track = createTrack({ url: input, requestedBy: interaction.user.tag });
  await enqueueAndPlay(interaction, track);
}
