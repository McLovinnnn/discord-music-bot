'use strict';

const {
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const { createResource } = require('./streams');

// Capped exponential backoff for re-attaching to a live stream after ffmpeg
// dies unexpectedly (e.g. the upstream Akamai connection dropped).
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * One GuildQueue per guild: owns the voice connection, the audio player, and
 * the track queue for that guild. See src/lib/queueManager.js for the
 * per-guild registry that creates/looks these up.
 */
class GuildQueue {
  /**
   * @param {object} options
   * @param {string} options.guildId
   * @param {import('discord.js').VoiceBasedChannel} options.voiceChannel
   * @param {import('discord.js').TextBasedChannel} [options.textChannel] - where status notifications are posted.
   * @param {Function} options.adapterCreator
   * @param {number} [options.volume] - initial volume, 0-2 (1 = 100%).
   * @param {Function} [options.onDestroyed] - called once, when this queue is destroyed, so the registry can drop its reference.
   */
  constructor({ guildId, voiceChannel, textChannel, adapterCreator, volume, onDestroyed }) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.volume = typeof volume === 'number' ? volume : 1;
    this._onDestroyed = onDestroyed;

    /** @type {Array<{url: string, title: string, requestedBy: string, isLive: boolean}>} */
    this.tracks = [];
    this.currentTrack = null;
    this.currentStream = null;
    this.paused = false;

    this.destroyed = false;
    this.intentionalStop = false;
    this.liveReconnectAttempt = 0;
    // Set/cleared by index.js's VoiceStateUpdate listener (alone-in-channel auto-disconnect).
    this.aloneTimer = null;

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator,
    });

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.connection.subscribe(this.player);

    this._wireConnection();
    this._wirePlayer();
  }

  /**
   * Waits for the voice connection to become ready. Call this right after
   * construction; on failure the queue destroys itself and the error should
   * be surfaced to whoever requested the connection.
   */
  async waitUntilReady(timeoutMs = 30_000) {
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, timeoutMs);
    } catch {
      this.destroy();
      throw new Error('Timed out connecting to the voice channel.');
    }
  }

  _wireConnection() {
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed) return;
      try {
        // A disconnect can be a transient blip (e.g. the voice server region
        // moved) that @discordjs/voice will recover from on its own, or a
        // real disconnect. Racing these two "recovering" states against each
        // other is the documented way to tell them apart.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Recovering by itself - nothing further to do.
      } catch {
        this.destroy();
      }
    });
  }

  _wirePlayer() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this._handleIdle().catch((err) => {
        console.error(`[GuildQueue:${this.guildId}] error handling idle state:`, err);
      });
    });
    this.player.on('error', (error) => {
      console.error(`[GuildQueue:${this.guildId}] player error:`, error.message);
      // @discordjs/voice emits 'error' on resource stream errors, sometimes
      // without a following Idle transition - route it through the same
      // reconnect-vs-advance logic as belt-and-suspenders.
      this._handleIdle().catch((err) => {
        console.error(`[GuildQueue:${this.guildId}] error handling player error:`, err);
      });
    });
  }

  async _handleIdle() {
    if (this.destroyed) return;

    if (this.intentionalStop) {
      this.intentionalStop = false;
      this._cleanupCurrentStream();
      await this.playNext();
      return;
    }

    if (this.currentTrack && this.currentTrack.isLive && !this.paused) {
      // ffmpeg exited/errored on its own - the live stream dropped. Try to
      // reconnect to the *same* track rather than treating this as "track
      // ended, advance queue".
      await this._reconnectLiveTrack();
      return;
    }

    // A finite track reached EOF naturally (or we're intentionally paused and
    // don't want a reconnect attempt to fire).
    if (!this.paused) {
      this._cleanupCurrentStream();
      await this.playNext();
    }
  }

  async _reconnectLiveTrack() {
    const track = this.currentTrack;
    this._cleanupCurrentStream();

    if (this.liveReconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this.notify(`Lost connection to **${track.title}** and gave up after ${RECONNECT_DELAYS_MS.length} reconnect attempts.`);
      this.liveReconnectAttempt = 0;
      this.currentTrack = null;
      await this.playNext();
      return;
    }

    if (this.liveReconnectAttempt === 0) {
      this.notify(`Lost connection to **${track.title}** - attempting to reconnect...`);
    }

    const delay = RECONNECT_DELAYS_MS[this.liveReconnectAttempt];
    this.liveReconnectAttempt += 1;

    setTimeout(() => {
      if (this.destroyed || !this.currentTrack) return;
      try {
        this._playResource(this.currentTrack);
      } catch (err) {
        console.error(`[GuildQueue:${this.guildId}] reconnect attempt failed:`, err.message);
        this._handleIdle().catch((idleErr) => {
          console.error(`[GuildQueue:${this.guildId}] error handling failed reconnect:`, idleErr);
        });
      }
    }, delay);
  }

  /** Add a track to the end of the queue. */
  enqueue(track) {
    this.tracks.push(track);
  }

  /** Start playing if nothing is currently playing. Call after enqueue(). */
  async ensurePlaying() {
    if (!this.currentTrack) {
      await this.playNext();
    }
  }

  async playNext() {
    if (this.destroyed) return;

    const next = this.tracks.shift();
    if (!next) {
      // Empty queue: stay connected (only /stop or the alone-timer disconnects).
      this.currentTrack = null;
      return;
    }

    this.liveReconnectAttempt = 0;
    this.currentTrack = next;
    this._playResource(next);
  }

  _playResource(track) {
    this._cleanupCurrentStream();
    const stream = createResource(track, { volume: this.volume });
    this.currentStream = stream;
    this.player.play(stream.resource);
  }

  _cleanupCurrentStream() {
    if (this.currentStream) {
      this.currentStream.destroy();
      this.currentStream = null;
    }
  }

  /** User-requested skip: advance to the next queued track (or go idle-empty). */
  skip() {
    this.intentionalStop = true;
    this.player.stop(true);
  }

  /**
   * Pausing a live track can't just be player.pause() - ffmpeg would keep
   * running and block writing to a full pipe indefinitely, risking the
   * upstream Akamai session timing out server-side. Instead, fully tear down
   * the ffmpeg process; resume() re-spawns a fresh one against the same URL,
   * so resuming "catches up to live" rather than replaying stale audio.
   * Finite tracks use the player's own pause, which is cheap and correct.
   */
  pause() {
    if (this.paused) return;
    this.paused = true;

    if (this.currentTrack && this.currentTrack.isLive) {
      this._cleanupCurrentStream();
      this.player.stop(true);
    } else {
      this.player.pause();
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;

    if (this.currentTrack && this.currentTrack.isLive) {
      this._playResource(this.currentTrack);
    } else {
      this.player.unpause();
    }
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.currentStream) {
      this.currentStream.resource.volume.setVolume(volume);
    }
  }

  /** Posts a status message to the guild's text channel, if one is set. */
  notify(message) {
    if (this.textChannel) {
      this.textChannel.send(message).catch((err) => {
        console.error(`[GuildQueue:${this.guildId}] failed to send notification:`, err.message);
      });
    }
  }

  /** Clears the queue, stops playback, kills any ffmpeg child, and leaves the channel. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.aloneTimer) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = null;
    }

    this.tracks = [];
    this.currentTrack = null;
    this._cleanupCurrentStream();

    try {
      this.player.stop(true);
    } catch {
      // Player may already be in a state where stop() throws - safe to ignore.
    }

    try {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
    } catch {
      // Connection may already be destroyed - safe to ignore.
    }

    if (this._onDestroyed) {
      this._onDestroyed();
    }
  }
}

module.exports = { GuildQueue };
