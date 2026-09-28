'use strict';

const { SlashCommandBuilder } = require('discord.js');
const dailyPlaylist = require('../lib/dailyPlaylist');
const youtubeResolver = require('../lib/youtubeResolver');
const { createTrack } = require('../lib/track');
const { joinAndGetQueue, playOnQueue } = require('../lib/enqueue');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('jamiematt')
    .setDescription("Play today's tracks from the daily Spotify playlist"),
  async execute(interaction) {
    // Join/defer *before* dailyPlaylist.getTracks(), which can be slow on a
    // cold cache (a full Spotify + per-track YouTube resolution pass) -
    // Discord needs a reply or deferral within 3 seconds, well before that
    // could realistically finish.
    const queue = await joinAndGetQueue(interaction);
    if (!queue) return;

    let dailyTracks;
    try {
      dailyTracks = await dailyPlaylist.getTracks();
    } catch (err) {
      await interaction.editReply(`Couldn't load the playlist: ${err.message}`);
      return;
    }

    if (dailyTracks.length === 0) {
      await interaction.editReply("Today's playlist is empty (or SPOTIFY_PLAYLIST_URL isn't configured) - nothing to play.");
      return;
    }

    const tracks = dailyTracks.map((t) =>
      createTrack({
        title: `${t.artists.join(', ')} - ${t.title}`,
        requestedBy: interaction.user.tag,
        isLive: false,
        resolveUrl: () => youtubeResolver.resolveStreamUrl(t.videoId),
      })
    );

    await playOnQueue(interaction, queue, tracks);
  },
};
