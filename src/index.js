'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, Collection, GatewayIntentBits, Events } = require('discord.js');
const queueManager = require('./lib/queueManager');
const { checkAlone } = require('./lib/aloneWatcher');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN and/or CLIENT_ID in the environment. Copy .env.example to .env and fill them in (or set them as Pterodactyl Startup Variables).');
  process.exit(1);
}

// @discordjs/voice's modern transport encryption expects Node's built-in
// aes-256-gcm cipher. Fail loud-but-not-fatal if it's missing so a broken
// voice connection doesn't show up as a confusing silent failure later.
if (!crypto.getCiphers().includes('aes-256-gcm')) {
  console.warn('WARNING: this Node runtime does not expose the aes-256-gcm cipher. Voice connections may fail to establish. Consider installing @noble/ciphers as a fallback (see @discordjs/voice docs) or upgrading Node.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (!command?.data || !command?.execute) {
    console.warn(`Skipping ${file}: missing "data" or "execute" export.`);
    continue;
  }
  client.commands.set(command.data.name, command);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag} (${client.commands.size} commands loaded).`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error executing /${interaction.commandName}:`, err);
    const payload = { content: 'Something went wrong running that command.', ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyErr) {
      console.error('Failed to report command error to the user:', replyErr);
    }
  }
});

// Drives the "alone in channel" auto-disconnect: fires on every voice state
// change, but only does work when it's relevant to a channel the bot is
// currently connected to in that guild.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guild = newState.guild ?? oldState.guild;
  const queue = queueManager.getQueue(guild.id);
  if (!queue || queue.destroyed) return;

  const botChannelId = queue.connection.joinConfig.channelId;
  if (oldState.channelId !== botChannelId && newState.channelId !== botChannelId) return;

  const channel = guild.channels.cache.get(botChannelId);
  checkAlone(queue, channel);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, disconnecting from all voice channels...`);
  queueManager.destroyAll();
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Best-effort clean voice disconnect before letting Pterodactyl restart us -
  // a full restart is much worse for anyone currently listening than a
  // graceful exit, but limping on in a possibly-corrupt state is worse still.
  try {
    queueManager.destroyAll();
  } catch {
    // Already in an unstable state - nothing more we can safely do.
  }
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
