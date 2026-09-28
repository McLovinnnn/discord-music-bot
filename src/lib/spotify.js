'use strict';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Client Credentials OAuth flow - no user login needed, this only ever
 * reads public playlist/track data. Cached in memory with a safety margin
 * before the real expiry.
 *
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET are not set.');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Spotify token request failed: HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresh a minute early rather than cutting it exactly at expiry.
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function apiGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify API request failed: HTTP ${res.status} ${res.statusText} (${path})`);
  }
  return res.json();
}

/**
 * Detects whether a URL is a Spotify playlist or track link, and extracts
 * its ID. Used by /play to decide how to route a given link; returns null
 * for anything that isn't a recognized open.spotify.com playlist/track URL,
 * so callers can fall through to trying YouTube, then a plain direct URL.
 *
 * @param {string} url
 * @returns {{type: 'playlist'|'track', id: string}|null}
 */
function parseLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'open.spotify.com') return null;

  const match = parsed.pathname.match(/^\/(playlist|track)\/([A-Za-z0-9]+)/);
  if (!match) return null;

  return { type: match[1], id: match[2] };
}

/**
 * Fetches every track in a playlist, paginating through Spotify's `next`
 * links (up to 100 items per page).
 *
 * @param {string} playlistId
 * @returns {Promise<Array<{title: string, artists: string[]}>>}
 */
async function fetchPlaylistTracks(playlistId) {
  const tracks = [];
  let nextPath = `/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(name,artists(name)))`;

  while (nextPath) {
    const data = await apiGet(nextPath);
    for (const item of data.items ?? []) {
      const track = item.track;
      if (!track) continue; // Removed/unavailable tracks can show up as null.
      tracks.push({
        title: track.name,
        artists: (track.artists ?? []).map((a) => a.name),
      });
    }
    // `next` is a full URL when present; convert it back to a path relative to API_BASE.
    nextPath = data.next ? data.next.replace(API_BASE, '') : null;
  }

  return tracks;
}

/**
 * @param {string} trackId
 * @returns {Promise<{title: string, artists: string[]}>}
 */
async function fetchTrack(trackId) {
  const data = await apiGet(`/tracks/${trackId}?fields=name,artists(name)`);
  return { title: data.name, artists: (data.artists ?? []).map((a) => a.name) };
}

module.exports = { getAccessToken, parseLink, fetchPlaylistTracks, fetchTrack };
