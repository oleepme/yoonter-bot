// src/index.js
const http = require("http");
const { Client, GatewayIntentBits } = require("discord.js");

const { initDb, listActiveParties } = require("./db");
const { registerCommands } = require("./discord/registerCommands");
const {
  DISCORD_TOKEN,
  GUILD_ID,
  PARTY_BOARD_CHANNEL_ID,
  NICK_HELP_CHANNEL_ID,
  ENABLE_NICK,
  ENABLE_PARTY
} = require("./config");

const { partyBoardEmbed, partyBoardComponents } = require("./party/ui");
const { nicknameBoardComponents } = require("./features/nickname/ui");
const { handleNickname } = require("./features/nickname/handler");
const { handleParty, runPartyTick, syncOrderMessage } = require("./party/handler");

console.log("BOOT_OK");

// (A) 더미 웹 서버 (Railway 헬스용)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("OK"); })
  .listen(PORT, () => console.log(`🌐 Dummy web server running on port ${PORT}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

async function ensurePinnedBoard(channel, title, payloadBuilder) {
  const pins = await channel.messages.fetchPinned().catch(() => null);
  const exists = pins?.find(m => m.embeds?.[0]?.title === title);
  if (exists) return;

  const payload = payloadBuilder();
  const msg = await channel.send(payload);
  await msg.pin().catch(() => {});
}

initDb()
  .then(() => console.log("DB_OK"))
  .catch((e) => {
    console.error("DB_INIT_FAIL", e);
    process.exit(1);
  });

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();

  const guild = await client.guilds.fetch(GUILD_ID);

  // 파티 게시판 핀 보장 (footer meta 없이 제목으로 찾음)
  if (ENABLE_PARTY) {
    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (board?.isTextBased()) {
      await ensurePinnedBoard(board, "📌 파티 현황판", () => ({
        embeds: [partyBoardEmbed()],
        components: partyBoardComponents()
      }));
    }
  }

  // (선택) 닉네임 도움 핀 보장 - 기존 유지
  if (ENABLE_NICK && NICK_HELP_CHANNEL_ID) {
    const nickCh = await guild.channels.fetch(NICK_HELP_CHANNEL_ID).catch(() => null);
    if (nickCh?.isTextBased()) {
      // 닉네임 보드는 여기서는 간단히 유지 (원하면 이것도 제목 기반으로 바꿔줄게)
      const pins = await nickCh.messages.fetchPinned().catch(() => null);
      const exists = pins?.find(m => m.embeds?.[0]?.title === "🪪 닉네임 설정");
      if (!exists) {
        const msg = await nickCh.send({
          embeds: [{
            title: "🪪 닉네임 설정",
            description: "아래 버튼으로 서버 별명을 변경합니다."
          }],
          components: nicknameBoardComponents()
        });
        await msg.pin().catch(() => {});
      }
    }
  }

  // ✅ 재시작 후에도 주문서 싱크(깨짐 방지)
  if (ENABLE_PARTY) {
    const active = await listActiveParties().catch(() => []);
    for (const messageId of active) {
      await syncOrderMessage(guild, messageId).catch(() => {});
    }
  }

  // ✅ 30초마다 자동 상태 전환
  if (ENABLE_PARTY) {
    setInterval(() => {
      runPartyTick(client).catch(() => {});
    }, 30 * 1000);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    // 슬래시
    if (interaction.isChatInputCommand() && interaction.commandName === "ping") {
      await interaction.reply({ content: "pong", ephemeral: true });
      return;
    }

    // 닉네임
    if (ENABLE_NICK) {
      const handled = await handleNickname(interaction);
      if (handled) return;
    }

    // 파티
    if (ENABLE_PARTY) {
      const handled = await handleParty(interaction);
      if (handled) return;
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "⚠️ 오류가 발생했습니다. 로그 채널을 확인하세요.", ephemeral: true });
      } catch {}
    }
  }
});

client.login(DISCORD_TOKEN);
