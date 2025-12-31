const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = require("../config");

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("봇이 살아있는지 확인합니다.").toJSON()
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

module.exports = { registerCommands };
