const { EmbedBuilder } = require("discord.js");
const { SECRET_LOG_CHANNEL_ID } = require("../config");
const { nowUnix } = require("./util");

async function logEmbed(guild, { title, fields = [], color = 0x95a5a6 }) {
  if (!SECRET_LOG_CHANNEL_ID) return;

  const ch = await guild.channels.fetch(SECRET_LOG_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(fields)
    .setFooter({ text: `ts=${nowUnix()}` });

  await ch.send({ embeds: [embed] }).catch(() => {});
}

function field(name, value, inline = false) {
  const v = (value ?? "").toString();
  return { name, value: v.length ? v : "(없음)", inline };
}

module.exports = { logEmbed, field };
