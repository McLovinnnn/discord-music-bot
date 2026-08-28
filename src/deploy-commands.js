'use strict';

// Manual/standalone command registration. Not required for normal operation
// any more - src/index.js registers commands automatically on every boot
// (see REGISTER_COMMANDS_ON_BOOT in .env.example). This script is still
// useful for forcing an immediate re-register without restarting the bot,
// or for registering against a different token/guild than what's currently
// deployed.

require('dotenv').config();

const { registerCommands } = require('./lib/commandRegistry');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN and/or CLIENT_ID in the environment. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

(async () => {
  try {
    const { scope, names } = await registerCommands({ token: DISCORD_TOKEN, clientId: CLIENT_ID, guildId: GUILD_ID });
    if (scope === 'guild') {
      console.log(`Registered ${names.length} guild command(s) in guild ${GUILD_ID}: ${names.join(', ')}`);
    } else {
      console.log(`Registered ${names.length} global command(s): ${names.join(', ')}`);
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
