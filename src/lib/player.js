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
const eventLog = require('./eventLog');

// Capped exponential backoff for re-attaching to a live stream after ffmpeg
// dies unexpectedly (e.g. the upstream Akamai connection dropped).
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// Smaller retry budget for a finite track whose ffmpeg process crashes
// (as opposed to a live stream dropping, which gets the fuller backoff
// above) - a couple of quick attempts before giving up and moving on,
// rather than holding up the rest of the queue.
const FINITE_RETRY_DELAYS_MS = [1000, 3000];

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
    // Lifetime count of reconnect *sequences* triggered (not individual
    // retries within one), surfaced by /status.
    this.reconnectCount = 0;
    // Retry budget for the *current* finite track after an abnormal ffmpeg
    // exit (see _playResource/_handleIdle) - reset whenever a new track starts.
    this.finiteRetryAttempt = 0;
    this._currentStreamAbnormalExit = false;
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
        eventLog.log(this.guildId, 'Voice connection lost (not recovering) - leaving the channel.');
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

    if (this.paused) return;

    if (this.currentTrack && this._currentStreamAbnormalExit && this.finiteRetryAttempt < FINITE_RETRY_DELAYS_MS.length) {
      // ffmpeg crashed/errored rather than reaching a normal EOF - retry the
      // same track a couple of times before treating it as "ended, advance
      // queue". Without this, a crash (e.g. a YouTube-sourced track hitting
      // the same class of issue the BBC HTTP stream did) would silently look
      // identical to the track just finishing.
      await this._retryFiniteTrack();
      return;
    }

    if (this.currentTrack && this._currentStreamAbnormalExit) {
      // Retry budget exhausted - unlike a natural EOF, this is worth telling
      // the user about before moving on.
      const msg = `Gave up on **${this.currentTrack.title}** after ${FINITE_RETRY_DELAYS_MS.length} failed attempts - skipping.`;
      this.notify(msg);
      eventLog.log(this.guildId, msg);
    }

    // A finite track reached EOF naturally (or its retry budget ran out).
    this._cleanupCurrentStream();
    await this.playNext();
  }

  async _retryFiniteTrack() {
    const track = this.currentTrack;
    this._cleanupCurrentStream();

    const delay = FINITE_RETRY_DELAYS_MS[this.finiteRetryAttempt];
    this.finiteRetryAttempt += 1;
    const attempt = this.finiteRetryAttempt;
    const attemptsTotal = FINITE_RETRY_DELAYS_MS.length;
    eventLog.log(this.guildId, `**${track.title}** stopped unexpectedly - retrying (attempt ${attempt}/${attemptsTotal})...`);

    setTimeout(async () => {
      if (this.destroyed || this.currentTrack !== track) return;
      try {
        await this._playResource(track);
      } catch (err) {
        console.error(`[GuildQueue:${this.guildId}] finite-track retry failed:`, err.message);
        this._handleIdle().catch((idleErr) => {
          console.error(`[GuildQueue:${this.guildId}] error handling failed finite retry:`, idleErr);
        });
      }
    }, delay);
  }

  async _reconnectLiveTrack() {
    const track = this.currentTrack;
    this._cleanupCurrentStream();

    if (this.liveReconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      const msg = `Lost connection to **${track.title}** and gave up after ${RECONNECT_DELAYS_MS.length} reconnect attempts.`;
      this.notify(msg);
      eventLog.log(this.guildId, msg);
      this.liveReconnectAttempt = 0;
      this.currentTrack = null;
      await this.playNext();
      return;
    }

    if (this.liveReconnectAttempt === 0) {
      this.reconnectCount += 1;
      const msg = `Lost connection to **${track.title}** - attempting to reconnect...`;
      this.notify(msg);
      eventLog.log(this.guildId, msg);
    }

    const delay = RECONNECT_DELAYS_MS[this.liveReconnectAttempt];
    this.liveReconnectAttempt += 1;

    setTimeout(async () => {
      if (this.destroyed || !this.currentTrack) return;
      try {
        await this._playResource(this.currentTrack);
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
    this.finiteRetryAttempt = 0;
    this.currentTrack = next;
    await this._playResource(next);
  }

  async _playResource(track) {
    this._cleanupCurrentStream();
    this._currentStreamAbnormalExit = false;
    const stream = await createResource(track, {
      volume: this.volume,
      onEvent: (message) => {
        this._currentStreamAbnormalExit = true;
        eventLog.log(this.guildId, message);
      },
    });
    // Something else (skip/stop/destroy) may have happened while we were
    // awaiting DNS resolution/ffmpeg spawn above - don't let a stale resource
    // clobber whatever's now current.
    if (this.destroyed || this.currentTrack !== track) {
      stream.destroy();
      return;
    }
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

  async resume() {
    if (!this.paused) return;
    this.paused = false;

    if (this.currentTrack && this.currentTrack.isLive) {
      await this._playResource(this.currentTrack);
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
