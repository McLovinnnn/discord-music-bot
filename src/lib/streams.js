'use strict';

const fs = require('node:fs');
const prism = require('prism-media');
const { createAudioResource, StreamType } = require('@discordjs/voice');

// Defensive fallback: prism-media auto-detects ffmpeg-static when it's installed,
// but if that detection ever fails to trigger, pointing FFMPEG_PATH at the bundled
// binary directly guarantees a working ffmpeg without relying on one being present
// on the host/container's PATH.
if (!process.env.FFMPEG_PATH) {
  try {
    process.env.FFMPEG_PATH = require('ffmpeg-static');
  } catch {
    // ffmpeg-static not resolvable for some reason - fall through and let
    // prism-media try its own detection / a system "ffmpeg" on PATH.
  }
}

// ffmpeg-static's binary is downloaded by its own postinstall script, which
// some npm versions skip by default unless explicitly trusted (see this
// repo's package.json "allowScripts"). If that ever gets skipped anyway
// (e.g. a stricter npm config, --ignore-scripts), fail loudly and clearly at
// startup instead of a cryptic ENOENT the first time someone runs /play.
if (process.env.FFMPEG_PATH && !fs.existsSync(process.env.FFMPEG_PATH)) {
  console.error(
    `FFmpeg binary not found at "${process.env.FFMPEG_PATH}". ffmpeg-static's install script may have been skipped ` +
    `(check for "install scripts blocked"/"allowScripts" warnings during npm install). Try: ` +
    `node node_modules/ffmpeg-static/install.js`
  );
}

/**
 * Build the ffmpeg argument list that turns a direct audio/HLS URL into raw
 * PCM suitable for createAudioResource. Used identically for live and finite
 * tracks - there is no live/non-live branching at this layer, only in
 * GuildQueue's handling of what happens once the resulting resource goes idle.
 *
 * -reconnect / -reconnect_streamed / -reconnect_delay_max: ffmpeg's own
 *   HTTP-level reconnect for dropped HLS segment fetches - the first line of
 *   defense against an Akamai connection blip, before GuildQueue's own
 *   process-level respawn logic (the second line of defense) ever needs to
 *   trigger.
 * -analyzeduration 0 / -loglevel warning: start playback faster and keep
 *   ffmpeg's stderr limited to things actually worth logging.
 * -f s16le -ar 48000 -ac 2: raw 16-bit PCM, stereo, 48kHz - required (rather
 *   than having ffmpeg output Opus directly) because createAudioResource's
 *   inlineVolume transformer needs raw samples to apply /volume; it can't run
 *   on already-Opus-encoded frames.
 *
 * @param {string} url
 * @returns {string[]}
 */
function buildFfmpegArgs(url) {
  return [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', url,
    '-analyzeduration', '0',
    '-loglevel', 'warning',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];
}

/**
 * Create a playable AudioResource for a track, backed by a freshly spawned
 * ffmpeg process. Because the pipeline is streamed end-to-end (ffmpeg stdout ->
 * Transform -> AudioResource, pulled 20ms-frame-at-a-time by @discordjs/voice)
 * nothing here ever buffers a whole "track" up front - which is required for
 * live streams, which have no end.
 *
 * @param {{url: string, title: string}} track
 * @param {object} [options]
 * @param {number} [options.volume] - initial volume, 0-2 (1 = 100%).
 * @returns {{resource: import('@discordjs/voice').AudioResource, ffmpegProcess: import('child_process').ChildProcess, destroy: () => void}}
 */
function createResource(track, { volume = 1 } = {}) {
  const ffmpeg = new prism.FFmpeg({ args: buildFfmpegArgs(track.url) });
  const ffmpegProcess = ffmpeg.process;

  // ffmpeg's stderr is where Akamai HTTP errors, segment-fetch failures, etc.
  // actually surface - invaluable for diagnosing stream drops in production.
  if (ffmpegProcess && ffmpegProcess.stderr) {
    ffmpegProcess.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        console.warn(`[ffmpeg:${track.title}] ${line}`);
      }
    });
  }
  if (ffmpegProcess) {
    ffmpegProcess.on('error', (err) => {
      console.error(`[ffmpeg:${track.title}] process error:`, err);
    });
  }

  ffmpeg.on('error', (err) => {
    // Surface transform-stream errors too - not all failures cleanly show up
    // as a process 'error'/'exit' event.
    console.error(`[ffmpeg:${track.title}] stream error:`, err.message);
  });

  const resource = createAudioResource(ffmpeg, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: track,
  });
  resource.volume.setVolume(volume);

  const destroy = () => {
    ffmpeg.destroy();
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill('SIGKILL');
    }
  };

  return { resource, ffmpegProcess, destroy };
}

module.exports = { createResource, buildFfmpegArgs };
