console.log("BOOT_OK");


const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`봇 로그인됨: ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

