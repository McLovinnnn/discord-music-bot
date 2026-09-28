'use strict';

const spotify = require('./spotify');
const youtubeResolver = require('./youtubeResolver');

const REFRESH_HOURS = Number(process.env.PLAYLIST_REFRESH_HOURS || 12);

/** @type {Array<{title: string, artists: string[], videoId: string}>} */
let cachedTracks = [];
let lastRefreshedAt = 0;
let refreshInFlight = null;

/**
 * Re-fetches the fixed playlist (SPOTIFY_PLAYLIST_URL) from Spotify and
 * re-resolves each track to a YouTube video ID, replacing the cache. Tracks
 * that can't be matched on YouTube are skipped (logged, not fatal to the
 * whole refresh) - a single bad match shouldn't take out the entire playlist.
 *
 * @returns {Promise<void>}
 */
async function refresh() {
  // Coalesce concurrent callers (e.g. /jamiematt run twice back-to-back
  // before the first refresh finishes) onto the same in-flight refresh
  // instead of doing the work twice.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const playlistUrl = process.env.SPOTIFY_PLAYLIST_URL;
    if (!playlistUrl) {
      throw new Error('SPOTIFY_PLAYLIST_URL is not set.');
    }

    const link = spotify.parseLink(playlistUrl);
    if (!link || link.type !== 'playlist') {
      throw new Error(`SPOTIFY_PLAYLIST_URL doesn't look like a Spotify playlist link: ${playlistUrl}`);
    }

    const spotifyTracks = await spotify.fetchPlaylistTracks(link.id);
    const resolved = [];

    for (const track of spotifyTracks) {
      const videoId = await youtubeResolver.findVideoId(track.title, track.artists);
      if (!videoId) {
        console.warn(`dailyPlaylist: no YouTube match for "${track.artists.join(', ')} - ${track.title}", skipping.`);
        continue;
      }
      resolved.push({ title: track.title, artists: track.artists, videoId });
    }

    cachedTracks = resolved;
    lastRefreshedAt = Date.now();
    console.log(`dailyPlaylist: refreshed, ${resolved.length}/${spotifyTracks.length} tracks matched on YouTube.`);
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Returns the current cached track list, fetching for the first time if
 * empty. Does not force a refresh just because the interval hasn't fired
 * yet - the periodic refresh (see startPeriodicRefresh) handles staleness.
 *
 * @returns {Promise<Array<{title: string, artists: string[], videoId: string}>>}
 */
async function getTracks() {
  if (cachedTracks.length === 0) {
    await refresh();
  }
  return cachedTracks;
}

/**
 * Starts the recurring refresh interval. Called once from src/index.js at
 * boot, alongside an initial refresh - errors are logged, not thrown, since
 * a failed refresh (e.g. Spotify temporarily unreachable) shouldn't be
 * treated as fatal to the whole bot. A no-op if Spotify isn't configured at
 * all (this is an optional feature - not every deployment sets it up), so
 * it doesn't spam failed-refresh warnings every interval for no reason.
 */
function startPeriodicRefresh() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET || !process.env.SPOTIFY_PLAYLIST_URL) {
    console.log('dailyPlaylist: SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_PLAYLIST_URL not fully set - /jamiematt will be unavailable until configured.');
    return;
  }

  refresh().catch((err) => console.error('dailyPlaylist: initial refresh failed:', err.message));

  setInterval(() => {
    refresh().catch((err) => console.error('dailyPlaylist: periodic refresh failed:', err.message));
  }, REFRESH_HOURS * 60 * 60 * 1000);
}

/** @returns {number} timestamp (ms) of the last successful refresh, or 0 if never. */
function getLastRefreshedAt() {
  return lastRefreshedAt;
}

module.exports = { getTracks, refresh, startPeriodicRefresh, getLastRefreshedAt };
