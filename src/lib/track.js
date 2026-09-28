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
 * @param {string} [options.url] - direct audio/HLS stream URL to play. Required
 *   unless `resolveUrl` is given instead.
 * @param {() => Promise<string>} [options.resolveUrl] - resolves the playable
 *   URL lazily, right before playback, instead of having a fixed one up
 *   front. Needed for sources (YouTube) whose resolved stream URLs are
 *   signed/time-limited - resolving once and reusing it later would fail the
 *   same way a stale HLS URL would. When set, `isLive` must be passed
 *   explicitly too, since there's no URL string to infer it from.
 * @param {string} [options.title] - display title. Defaults to the URL itself.
 * @param {string} [options.requestedBy] - display name/tag of who queued this.
 * @param {boolean} [options.isLive] - explicit override; if omitted, inferred from the URL.
 * @returns {{url: string|undefined, resolveUrl: (() => Promise<string>)|undefined, title: string, requestedBy: string, isLive: boolean}}
 */
function createTrack({ url, resolveUrl, title, requestedBy, isLive }) {
  if (resolveUrl) {
    if (typeof resolveUrl !== 'function') {
      throw new Error('createTrack: "resolveUrl" must be a function');
    }
    if (typeof isLive !== 'boolean') {
      throw new Error('createTrack: "isLive" must be passed explicitly when using "resolveUrl" (there\'s no URL to infer it from)');
    }
  } else if (!url || typeof url !== 'string') {
    throw new Error('createTrack requires a string "url" (or a "resolveUrl" function)');
  }

  return {
    url,
    resolveUrl,
    title: title || url || 'Unknown track',
    requestedBy: requestedBy || 'unknown',
    isLive: typeof isLive === 'boolean' ? isLive : inferIsLive(url),
  };
}

module.exports = { createTrack, inferIsLive };
