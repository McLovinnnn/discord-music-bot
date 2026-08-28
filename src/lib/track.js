'use strict';

/**
 * A Track is a plain object describing one playable item in a guild's queue.
 * It intentionally carries no playback state (no ffmpeg process, no resource) -
 * that lives in GuildQueue/streams.js. This keeps Track cheap to create and easy
 * to display (e.g. in /queue, /nowplaying).
 */

/**
 * Infer whether a URL points at a live stream (as opposed to a finite file).
 * HLS live playlists (.m3u8) and Smooth Streaming manifests (.isml, used by the
 * BBC's Akamai endpoints) have no fixed duration and can't be seeked, so anything
 * that looks like one is treated as live by default.
 *
 * @param {string} url
 * @returns {boolean}
 */
function inferIsLive(url) {
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('.isml');
}

/**
 * @param {object} options
 * @param {string} options.url - direct audio/HLS stream URL to play.
 * @param {string} [options.title] - display title. Defaults to the URL itself.
 * @param {string} [options.requestedBy] - display name/tag of who queued this.
 * @param {boolean} [options.isLive] - explicit override; if omitted, inferred from the URL.
 * @returns {{url: string, title: string, requestedBy: string, isLive: boolean}}
 */
function createTrack({ url, title, requestedBy, isLive }) {
  if (!url || typeof url !== 'string') {
    throw new Error('createTrack requires a string "url"');
  }

  return {
    url,
    title: title || url,
    requestedBy: requestedBy || 'unknown',
    isLive: typeof isLive === 'boolean' ? isLive : inferIsLive(url),
  };
}

module.exports = { createTrack, inferIsLive };
