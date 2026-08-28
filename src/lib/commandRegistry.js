'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

/** Reads every command module's data.toJSON() from src/commands. */
function loadCommandData() {
  const commandsDir = path.join(__dirname, '..', 'commands');
  return fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => require(path.join(commandsDir, f)).data.toJSON());
}

/**
 * Registers all slash commands with Discord. Guild-scoped (registers
 * instantly) if guildId is given, otherwise global (can take up to ~1hr to
 * propagate to every server). The PUT overwrites the full command set each
 * time, so calling this repeatedly (e.g. once per boot) is safe/idempotent.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.clientId
 * @param {string} [options.guildId]
 * @returns {Promise<{scope: 'guild'|'global', names: string[]}>}
 */
async function registerCommands({ token, clientId, guildId }) {
  const commands = loadCommandData();
  const rest = new REST({ version: '10' }).setToken(token);
  const names = commands.map((c) => c.name);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    return { scope: 'guild', names };
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  return { scope: 'global', names };
}

module.exports = { loadCommandData, registerCommands };
