require("dotenv").config();

const http = require("http");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  PermissionsBitField,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

/* =========================
   0) ENV
========================= */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const PARTY_BOARD_CHANNEL_ID = process.env.PARTY_BOARD_CHANNEL_ID; // 필수(파티게시판)
const SECRET_LOG_CHANNEL_ID = process.env.SECRET_LOG_CHANNEL_ID || ""; // 선택(운영진 로그)
const NICK_HELP_CHANNEL_ID = process.env.NICK_HELP_CHANNEL_ID || ""; // 선택(닉네임 채널)
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || ""; // 선택(운영진 역할)

const ENABLE_PARTY = (process.env.ENABLE_PARTY ?? "true") === "true";
const ENABLE_NICK = (process.env.ENABLE_NICK ?? "true") === "true";

if (!DISCORD_TOKEN) throw new Error("Missing env: DISCORD_TOKEN");
if (!CLIENT_ID) throw new Error("Missing env: CLIENT_ID");
if (!GUILD_ID) throw new Error("Missing env: GUILD_ID");
if (ENABLE_PARTY && !PARTY_BOARD_CHANNEL_ID) throw new Error("Missing env: PARTY_BOARD_CHANNEL_ID");

/* =========================
   1) Client
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/* =========================
   2) Slash Commands (기존 유지)
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("닉네임 설정 버튼을 이 채널에 생성합니다.")
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });
  console.log("✅ Slash command registered");
}

/* =========================
   3) Party Data (in-memory)
========================= */
// 파티 생성 드래프트: userId -> { kind, title, note, hh? }
const partyDraft = new Map();

// 시간변경 드래프트: `${userId}:${messageId}` -> { hh }
const editDraft = new Map();

// 자동 "게임중" 전환 타이머: messageId -> timeoutId
const timers = new Map();

/* =========================
   4) Constants / UI
========================= */
const KIND_OPTIONS = [
  { label: "게임", value: "게임", emoji: "🎮" },
  { label: "노래", value: "노래", emoji: "🎵" },
  { label: "영화", value: "영화", emoji: "🎬" },
  { label: "수다", value: "수다", emoji: "💬" },
];

const COLOR_RECRUIT = 0xe74c3c; // 빨강
const COLOR_PLAYING = 0x2ecc71; // 초록
const STATUS_LABEL = (status) => (status === "PLAYING" ? "🟢 게임중" : "🔴 모집중");

/* =========================
   5) Utils
========================= */
const now = () => new Date();
const toUnix = (d) => Math.floor(d.getTime() / 1000);

function isSameDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function roundUpToNext5(d) {
  const x = new Date(d);
  x.setSeconds(0, 0);
  const mm = x.getMinutes();
  const next5 = Math.ceil(mm / 5) * 5;
  x.setMinutes(next5 % 60);
  if (next5 >= 60) x.setHours(x.getHours() + 1);
  return x;
}

function clampNick(nick) {
  const s = (nick ?? "").trim();
  if (!s) return { ok: false, reason: "닉네임이 비어 있습니다." };
  if (s.length > 32) return { ok: false, reason: "닉네임은 32자 이내여야 합니다." };
  return { ok: true, value: s };
}

function isAdmin(member) {
  if (!ADMIN_ROLE_ID) return false;
  return member.roles.cache.has(ADMIN_ROLE_ID);
}

async function logSecret(guild, text) {
  if (!SECRET_LOG_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(SECRET_LOG_CHANNEL_ID).catch(() => null);
  if (ch?.isTextBased()) await ch.send(text).catch(() => {});
}

function clearTimer(messageId) {
  const t = timers.get(messageId);
  if (t) clearTimeout(t);
  timers.delete(messageId);
}

/* =========================
   6) Meta in embed footer (DB 대체)
========================= */
function buildMeta(meta) {
  const pairs = Object.entries(meta).map(([k, v]) => `${k}=${v}`);
  return `DDG|party|${pairs.join("|")}`;
}

function parseMeta(footerText) {
  if (!footerText?.startsWith("DDG|party|")) return null;
  const raw = footerText.split("|").slice(2);
  const meta = {};
  for (const p of raw) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    meta[p.slice(0, idx)] = p.slice(idx + 1);
  }
  return meta;
}

function parseMembersFromEmbed(embed) {
  const fields = embed.data?.fields ?? [];
  const membersField = fields.find((f) => f.name === "참가자")?.value ?? "";
  const members = membersField
    .split("\n")
    .filter((l) => l.startsWith("- <@"))
    .map((l) => {
      const m = l.match(/- <@(\d+)>(?: — (.*))?/);
      if (!m) return null;
      return { userId: m[1], note: (m[2] ?? "").trim() };
    })
    .filter(Boolean);
  return members;
}

/* =========================
   7) UI Builders
========================= */
function buildKindSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("draft_kind")
      .setPlaceholder("카테고리 1 선택: 게임 / 노래 / 영화 / 수다")
      .addOptions(KIND_OPTIONS.map((o) => ({ label: o.label, value: o.value, emoji: o.emoji })))
  );
}

function buildHourSelect(customId) {
  const minAllowed = roundUpToNext5(now());
  const today = now();

  // 이미 다음 5분이 내일이면 오늘 선택 불가
  if (!isSameDate(minAllowed, today)) return null;

  const options = [];
  const startH = minAllowed.getHours();
  for (let h = startH; h <= 23; h++) {
    options.push({ label: `${String(h).padStart(2, "0")}시`, value: String(h) });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("시(시간) 선택")
      .addOptions(options.slice(0, 25))
  );
}

function buildMinuteSelect(customId) {
  const options = [];
  for (let m = 0; m < 60; m += 5) {
    options.push({ label: `${String(m).padStart(2, "0")}분`, value: String(m) });
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("분(5분 단위) 선택")
      .addOptions(options)
  );
}

function asapButtonRow(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel("⚡ 모이면 바로 시작").setStyle(ButtonStyle.Primary)
  );
}

function partyActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party_join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("party_leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party_time").setLabel("시간변경").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party_start").setLabel("시작").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("party_end").setLabel("게임종료").setStyle(ButtonStyle.Danger)
  );
}

/* =========================
   8) Party Embed
========================= */
function buildPartyEmbed({ ownerId, kind, title, note, mode, startAtUnix, status, members }) {
  const kindEmoji = KIND_OPTIONS.find((o) => o.value === kind)?.emoji ?? "📌";
  const statusLabel = STATUS_LABEL(status);

  const startLine =
    mode === "ASAP"
      ? "⚡ 모이면 바로 시작"
      : `🕒 <t:${startAtUnix}:F>  ( <t:${startAtUnix}:R> )`;

  const noteLine = note?.trim() ? note.trim() : "(없음)";

  const memberLines = members.length
    ? members.map((m) => `- <@${m.userId}>${m.note ? ` — ${m.note}` : ""}`).join("\n")
    : "- (없음)";

  const embed = new EmbedBuilder()
    .setColor(status === "PLAYING" ? COLOR_PLAYING : COLOR_RECRUIT)
    .setTitle(`${kindEmoji} ${kind}`)
    .setDescription(`🎯 **${title}**`)
    .addFields(
      { name: "상태", value: statusLabel, inline: true },
      { name: "시작", value: startLine, inline: true },
      { name: "특이사항", value: noteLine, inline: false },
      { name: "참가자", value: memberLines, inline: false }
    )
    .setFooter({
      text: buildMeta({
        owner: ownerId,
        kind,
        mode,
        startAt: String(startAtUnix),
        status,
      }),
    });

  return embed;
}

/* =========================
   9) Scheduling
========================= */
async function promoteToPlaying(msg, reason) {
  const embed = msg.embeds?.[0];
  if (!embed) return;
  const meta = parseMeta(embed.footer?.text);
  if (!meta || meta.status === "PLAYING") return;

  const rebuilt = EmbedBuilder.from(embed);
  const members = parseMembersFromEmbed(rebuilt);

  const title =
    (rebuilt.data.description ?? "").replace("🎯 **", "").replace("**", "").trim() || "파티";

  const noteField = (rebuilt.data.fields ?? []).find((f) => f.name === "특이사항")?.value ?? "";
  const note = noteField === "(없음)" ? "" : noteField;

  const newEmbed = buildPartyEmbed({
    ownerId: meta.owner,
    kind: meta.kind,
    title,
    note,
    mode: meta.mode,
    startAtUnix: Number(meta.startAt),
    status: "PLAYING",
    members,
  });

  await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
  await logSecret(msg.guild, `🟢 [게임중][ID:${msg.id}] ${meta.kind} / ${title} | 사유: ${reason}`);
}

async function scheduleAutoPlaying(msg) {
  const embed = msg.embeds?.[0];
  if (!embed) return;
  const meta = parseMeta(embed.footer?.text);
  if (!meta) return;

  clearTimer(msg.id);

  if (meta.status === "PLAYING") return;
  if (meta.mode === "ASAP") return;

  const startAt = Number(meta.startAt);
  if (!startAt) return;

  const delay = startAt * 1000 - Date.now();
  if (delay <= 0) {
    await promoteToPlaying(msg, "시간도래(즉시)");
    return;
  }

  const id = setTimeout(() => {
    promoteToPlaying(msg, "시간도래").catch(() => {});
  }, delay);

  timers.set(msg.id, id);
}

/* =========================
   10) Pinned Boards
========================= */
async function ensurePinnedPartyBoard(guild) {
  if (!ENABLE_PARTY) return;

  const ch = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return;

  const pins = await ch.messages.fetchPinned().catch(() => null);
  if (pins?.find((m) => m.embeds?.[0]?.footer?.text === "DDG|partyboard|v1")) return;

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 게시판")
    .setDescription(
      [
        "아래 버튼으로 파티를 생성하세요. (명령어 입력 없음)",
        "- 시작시간: 오늘 기준 시/분 선택(분은 5분 단위)",
        "- 상태: 🔴 모집중 / 🟢 게임중",
        "- 종료 시 주문서 삭제",
        "- 상세 로그는 운영진만 확인",
      ].join("\n")
    )
    .setFooter({ text: "DDG|partyboard|v1" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("create_party").setLabel("➕ 새 파티 만들기").setStyle(ButtonStyle.Success)
  );

  const msg = await ch.send({ embeds: [embed], components: [row] });
  await msg.pin().catch(() => {});
}

async function ensurePinnedNickBoard(guild) {
  if (!ENABLE_NICK || !NICK_HELP_CHANNEL_ID) return;

  const ch = await guild.channels.fetch(NICK_HELP_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return;

  const pins = await ch.messages.fetchPinned().catch(() => null);
  if (pins?.find((m) => m.embeds?.[0]?.footer?.text === "DDG|nickboard|v1")) return;

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("🪪 닉네임 설정")
    .setDescription("아래 버튼으로 서버 별명을 설정하세요. (명령어 입력 없음)")
    .setFooter({ text: "DDG|nickboard|v1" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("nickname_button").setLabel("닉네임 설정하기").setStyle(ButtonStyle.Primary)
  );

  const msg = await ch.send({ embeds: [embed], components: [row] });
  await msg.pin().catch(() => {});
}

async function rebuildSchedules(guild) {
  if (!ENABLE_PARTY) return;

  const ch = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return;

  const msgs = await ch.messages.fetch({ limit: 100 }).catch(() => null);
  if (!msgs) return;

  for (const [, m] of msgs) {
    const e = m.embeds?.[0];
    const meta = parseMeta(e?.footer?.text);
    if (!meta) continue;
    if (meta.owner && meta.kind) await scheduleAutoPlaying(m);
  }
}

/* =========================
   11) Ready
========================= */
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();

  const guild = await client.guilds.fetch(GUILD_ID);
  await ensurePinnedPartyBoard(guild);
  await ensurePinnedNickBoard(guild);
  await rebuildSchedules(guild);
});

/* =========================
   12) InteractionCreate
========================= */
client.on("interactionCreate", async (interaction) => {
  try {
    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));

    /* ===== (A) 닉네임: 기존 /setup 유지 ===== */
    if (ENABLE_NICK && interaction.isChatInputCommand() && interaction.commandName === "setup") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("nickname_button")
          .setLabel("닉네임 설정하기")
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({
        content:
          "닉네임 설정이 어려우면 아래 버튼을 눌러주세요.\n입력한 값으로 **서버 별명**이 변경됩니다.",
        components: [row],
      });
      return;
    }

    /* ===== (B) 닉네임: 버튼 -> 모달 -> 변경 ===== */
    if (ENABLE_NICK && interaction.isButton() && interaction.customId === "nickname_button") {
      const modal = new ModalBuilder().setCustomId("nickname_modal").setTitle("닉네임 설정");

      const nicknameInput = new TextInputBuilder()
        .setCustomId("nickname_input")
        .setLabel("변경할 닉네임을 입력하세요")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32);

      modal.addComponents(new ActionRowBuilder().addComponents(nicknameInput));

      await interaction.showModal(modal);
      return;
    }

    if (
      ENABLE_NICK &&
      interaction.type === InteractionType.ModalSubmit &&
      interaction.customId === "nickname_modal"
    ) {
      const raw = interaction.fields.getTextInputValue("nickname_input");
      const v = clampNick(raw);

      if (!v.ok) {
        await interaction.reply({ content: v.reason, ephemeral: true });
        return;
      }

      const botMember = interaction.guild.members.me;
      if (!botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        await interaction.reply({
          content:
            "봇에 **닉네임 관리(Manage Nicknames)** 권한이 없습니다.\n서버 역할 설정을 확인해주세요.",
          ephemeral: true,
        });
        return;
      }

      await interaction.member.setNickname(v.value);

      await interaction.reply({
        content: `✅ 서버 닉네임이 **${v.value}**(으)로 변경되었습니다.`,
        ephemeral: true,
      });

      await logSecret(guild, `🪪 [닉변] <@${interaction.user.id}> → "${v.value}" (성공)`);
      return;
    }

    /* ===== (C) 파티: 게시판 "새 파티 만들기" 버튼 ===== */
    if (ENABLE_PARTY && interaction.isButton() && interaction.customId === "create_party") {
      const minAllowed = roundUpToNext5(now());
      if (!isSameDate(minAllowed, now())) {
        await interaction.reply({
          content: "오늘 남은 시간이 거의 없어요. 내일 다시 파티를 만들어주세요.",
          ephemeral: true,
        });
        return;
      }

      partyDraft.set(interaction.user.id, {});
      await interaction.reply({
        content: "카테고리 1을 선택하세요.",
        components: [buildKindSelect()],
        ephemeral: true,
      });
      return;
    }

    /* ===== (D) 파티: 카테고리1 선택 -> 카테고리2/3 모달 ===== */
    if (ENABLE_PARTY && interaction.isStringSelectMenu() && interaction.customId === "draft_kind") {
      const d = partyDraft.get(interaction.user.id) ?? {};
      d.kind = interaction.values[0];
      partyDraft.set(interaction.user.id, d);

      const modal = new ModalBuilder().setCustomId("draft_details").setTitle("파티 정보 입력");

      const title = new TextInputBuilder()
        .setCustomId("title")
        .setLabel("카테고리 2: 게임/종류 (자유 입력)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(60);

      const note = new TextInputBuilder()
        .setCustomId("note")
        .setLabel("카테고리 3: 특이사항 (선택)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(200);

      modal.addComponents(
        new ActionRowBuilder().addComponents(title),
        new ActionRowBuilder().addComponents(note)
      );

      await interaction.showModal(modal);
      return;
    }

    /* ===== (E) 파티: 카테고리2/3 입력 -> 시 선택 + 모이면 시작 ===== */
    if (
      ENABLE_PARTY &&
      interaction.type === InteractionType.ModalSubmit &&
      interaction.customId === "draft_details"
    ) {
      const d = partyDraft.get(interaction.user.id);
      if (!d?.kind) {
        await interaction.reply({
          content: "세션이 만료됐어요. 다시 [새 파티 만들기]를 눌러주세요.",
          ephemeral: true,
        });
        return;
      }

      d.title = (interaction.fields.getTextInputValue("title") ?? "").trim();
      d.note = (interaction.fields.getTextInputValue("note") ?? "").trim();
      partyDraft.set(interaction.user.id, d);

      const hourRow = buildHourSelect("draft_hour");
      if (!hourRow) {
        partyDraft.delete(interaction.user.id);
        await interaction.reply({
          content: "오늘 남은 시간이 거의 없어요. 내일 다시 파티를 만들어주세요.",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: "카테고리 4: 시작시간(오늘). 먼저 **시(시간)** 를 선택하세요.",
        components: [hourRow, asapButtonRow("draft_asap")],
        ephemeral: true,
      });
      return;
    }

    /* ===== (F) 파티 생성: 모이면 시작 ===== */
    if (ENABLE_PARTY && interaction.isButton() && interaction.customId === "draft_asap") {
      const d = partyDraft.get(interaction.user.id);
      if (!d?.kind || !d?.title) {
        await interaction.reply({ content: "세션이 만료됐어요. 다시 만들어주세요.", ephemeral: true });
        return;
      }

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
      const startAtUnix = toUnix(now()); // 메타 저장용

      const embed = buildPartyEmbed({
        ownerId: interaction.user.id,
        kind: d.kind,
        title: d.title,
        note: d.note,
        mode: "ASAP",
        startAtUnix,
        status: "RECRUIT",
        members: [{ userId: interaction.user.id, note: "" }],
      });

      const msg = await board.send({ embeds: [embed], components: [partyActionRow()] });

      await logSecret(
        guild,
        `✅ [생성][ID:${msg.id}] ${d.kind} / ${d.title} | 시작: 모이면 | 파티장: <@${interaction.user.id}>`
      );

      partyDraft.delete(interaction.user.id);
      await interaction.reply({ content: "파티 주문서를 만들었어요. 게시판을 확인하세요.", ephemeral: true });
      return;
    }

    /* ===== (G) 파티 생성: 시 선택 -> 분 선택 ===== */
    if (ENABLE_PARTY && interaction.isStringSelectMenu() && interaction.customId === "draft_hour") {
      const d = partyDraft.get(interaction.user.id);
      if (!d?.kind || !d?.title) {
        await interaction.reply({
          content: "세션이 만료됐어요. 다시 [새 파티 만들기]를 눌러주세요.",
          ephemeral: true,
        });
        return;
      }

      d.hh = Number(interaction.values[0]);
      partyDraft.set(interaction.user.id, d);

      await interaction.reply({
        content: `선택한 시간: **${String(d.hh).padStart(2, "0")}시**. 이제 **분(5분 단위)** 을 선택하세요.`,
        components: [buildMinuteSelect("draft_minute")],
        ephemeral: true,
      });
      return;
    }

    /* ===== (H) 파티 생성: 분 선택 -> 주문서 생성 ===== */
    if (ENABLE_PARTY && interaction.isStringSelectMenu() && interaction.customId === "draft_minute") {
      const d = partyDraft.get(interaction.user.id);
      if (!d?.kind || !d?.title || typeof d.hh !== "number") {
        await interaction.reply({
          content: "세션이 만료됐어요. 다시 [새 파티 만들기]를 눌러주세요.",
          ephemeral: true,
        });
        return;
      }

      const mm = Number(interaction.values[0]);

      const start = new Date();
      start.setSeconds(0, 0);
      start.setHours(d.hh, mm, 0, 0);

      const minAllowed = roundUpToNext5(new Date());
      if (!isSameDate(minAllowed, start)) {
        partyDraft.delete(interaction.user.id);
        await interaction.reply({
          content: "오늘 남은 시간이 거의 없어요. 내일 다시 파티를 만들어주세요.",
          ephemeral: true,
        });
        return;
      }

      if (start.getTime() < minAllowed.getTime()) {
        await interaction.reply({
          content: `이미 지난 시간이에s입니다. (최소 가능 시간: ${String(minAllowed.getHours()).padStart(2, "0")}:${String(
            minAllowed.getMinutes()
          ).padStart(2, "0")})`,
          ephemeral: true,
        });
        return;
      }

      const startAtUnix = toUnix(start);

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
      const embed = buildPartyEmbed({
        ownerId: interaction.user.id,
        kind: d.kind,
        title: d.title,
        note: d.note,
        mode: "TIME",
        startAtUnix,
        status: "RECRUIT",
        members: [{ userId: interaction.user.id, note: "" }],
      });

      const msg = await board.send({ embeds: [embed], components: [partyActionRow()] });
      await scheduleAutoPlaying(msg);

      await logSecret(
        guild,
        `✅ [생성][ID:${msg.id}] ${d.kind} / ${d.title} | 시작: <t:${startAtUnix}:t> | 파티장: <@${interaction.user.id}>`
      );

      partyDraft.delete(interaction.user.id);
      await interaction.reply({ content: "파티 주문서를 만들었어요. 게시판을 확인하세요.", ephemeral: true });
      return;
    }

    /* ===== (I) 파티 주문서 버튼 처리 ===== */
    if (
      ENABLE_PARTY &&
      interaction.isButton() &&
      ["party_join", "party_leave", "party_time", "party_start", "party_end"].includes(interaction.customId)
    ) {
      const msg = interaction.message;
      const embed = msg.embeds?.[0];
      const meta = parseMeta(embed?.footer?.text);

      if (!meta) {
        await interaction.reply({ content: "이 메시지는 파티 주문서가 아니에요.", ephemeral: true });
        return;
      }

      const rebuilt = EmbedBuilder.from(embed);
      const members = parseMembersFromEmbed(rebuilt);

      const title =
        (rebuilt.data.description ?? "").replace("🎯 **", "").replace("**", "").trim() || "파티";

      const noteField = (rebuilt.data.fields ?? []).find((f) => f.name === "특이사항")?.value ?? "";
      const note = noteField === "(없음)" ? "" : noteField;

      const ownerId = meta.owner;
      const member = await guild.members.fetch(interaction.user.id);
      const canManage = interaction.user.id === ownerId || isAdmin(member);

      // 참가/비고
      if (interaction.customId === "party_join") {
        const modal = new ModalBuilder().setCustomId(`join_note:${msg.id}`).setTitle("참가 비고(선택)");

        const input = new TextInputBuilder()
          .setCustomId("note")
          .setLabel("비고(선택) 예: 늦참10 / 마이크X / 뉴비")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(80);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // 나가기
      if (interaction.customId === "party_leave") {
        const next = members.filter((m) => m.userId !== interaction.user.id);

        const newEmbed = buildPartyEmbed({
          ownerId,
          kind: meta.kind,
          title,
          note,
          mode: meta.mode,
          startAtUnix: Number(meta.startAt),
          status: meta.status,
          members: next,
        });

        await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
        await interaction.reply({ content: "나가기 처리 완료.", ephemeral: true });
        await logSecret(guild, `➖ [나가기][ID:${msg.id}] ${meta.kind} / ${title} | <@${interaction.user.id}>`);
        return;
      }

      // 시간변경 (파티장/운영진만)
      if (interaction.customId === "party_time") {
        if (!canManage) {
          await interaction.reply({ content: "파티장/운영진만 시간 변경이 가능해요.", ephemeral: true });
          return;
        }

        const minAllowed = roundUpToNext5(now());
        if (!isSameDate(minAllowed, now())) {
          await interaction.reply({
            content: "오늘 남은 시간이 거의 없어요. 내일 다시 변경해주세요.",
            ephemeral: true,
          });
          return;
        }

        const hourRow = buildHourSelect(`edit_hour:${msg.id}`);
        if (!hourRow) {
          await interaction.reply({
            content: "오늘 남은 시간이 거의 없어요. 내일 다시 변경해주세요.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: "새 시작시간(오늘). 먼저 **시(시간)** 를 선택하세요. (분은 5분 단위)",
          components: [hourRow, asapButtonRow(`edit_asap:${msg.id}`)],
          ephemeral: true,
        });
        return;
      }

      // 시작 (파티장/운영진만)
      if (interaction.customId === "party_start") {
        if (!canManage) {
          await interaction.reply({ content: "파티장/운영진만 시작이 가능해요.", ephemeral: true });
          return;
        }
        await promoteToPlaying(msg, "시작 버튼");
        await interaction.reply({ content: "🟢 게임중으로 전환했어요.", ephemeral: true });
        return;
      }

      // 종료 (파티장/운영진만)
      if (interaction.customId === "party_end") {
        if (!canManage) {
          await interaction.reply({ content: "파티장/운영진만 종료가 가능해요.", ephemeral: true });
          return;
        }

        clearTimer(msg.id);
        await interaction.reply({ content: "파티를 종료하고 주문서를 삭제합니다.", ephemeral: true });

        await logSecret(
          guild,
          `🛑 [종료][ID:${msg.id}] ${meta.kind} / ${title} | 종료자: <@${interaction.user.id}> | 최종: ${
            members.map((m) => `<@${m.userId}>`).join(" ") || "(없음)"
          }`
        );

        await msg.delete().catch(() => {});
        return;
      }
    }

    /* ===== (J) 참가 비고 모달 제출 ===== */
    if (
      ENABLE_PARTY &&
      interaction.type === InteractionType.ModalSubmit &&
      interaction.customId.startsWith("join_note:")
    ) {
      const msgId = interaction.customId.split(":")[1];

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
      const msg = await board.messages.fetch(msgId).catch(() => null);

      if (!msg) {
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const embed = msg.embeds?.[0];
      const meta = parseMeta(embed?.footer?.text);
      if (!meta) {
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const rebuilt = EmbedBuilder.from(embed);
      const members = parseMembersFromEmbed(rebuilt);

      const title =
        (rebuilt.data.description ?? "").replace("🎯 **", "").replace("**", "").trim() || "파티";

      const noteField = (rebuilt.data.fields ?? []).find((f) => f.name === "특이사항")?.value ?? "";
      const note = noteField === "(없음)" ? "" : noteField;

      const inputNote = (interaction.fields.getTextInputValue("note") ?? "").trim().slice(0, 80);

      const idx = members.findIndex((m) => m.userId === interaction.user.id);
      if (idx >= 0) members[idx].note = inputNote;
      else members.push({ userId: interaction.user.id, note: inputNote });

      const newEmbed = buildPartyEmbed({
        ownerId: meta.owner,
        kind: meta.kind,
        title,
        note,
        mode: meta.mode,
        startAtUnix: Number(meta.startAt),
        status: meta.status,
        members,
      });

      await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
      await interaction.reply({ content: "참가/비고 반영 완료.", ephemeral: true });

      // 비고 내용은 민감할 수 있으니 로그에는 '참가'만 남김
      await logSecret(guild, `➕ [참가][ID:${msg.id}] ${meta.kind} / ${title} | <@${interaction.user.id}>`);
      return;
    }

    /* ===== (K) 시간변경: 시 선택 -> 분 선택 ===== */
    if (ENABLE_PARTY && interaction.isStringSelectMenu() && interaction.customId.startsWith("edit_hour:")) {
      const msgId = interaction.customId.split(":")[1];

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
      const msg = await board.messages.fetch(msgId).catch(() => null);
      if (!msg) {
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const embed = msg.embeds?.[0];
      const meta = parseMeta(embed?.footer?.text);
      if (!meta) {
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id);
      const canManage = interaction.user.id === meta.owner || isAdmin(member);
      if (!canManage) {
        await interaction.reply({ content: "파티장/운영진만 시간 변경이 가능해요.", ephemeral: true });
        return;
      }

      const hh = Number(interaction.values[0]);
      editDraft.set(`${interaction.user.id}:${msgId}`, { hh });

      await interaction.reply({
        content: `선택한 시간: **${String(hh).padStart(2, "0")}시**. 이제 **분(5분 단위)** 을 선택하세요.`,
        components: [buildMinuteSelect(`edit_minute:${msgId}`)],
        ephemeral: true,
      });
      return;
    }

    /* ===== (L) 시간변경: 분 선택 -> 적용 + 재스케줄 ===== */
    if (ENABLE_PARTY && interaction.isStringSelectMenu() && interaction.customId.startsWith("edit_minute:")) {
      const msgId = interaction.customId.split(":")[1];
      const key = `${interaction.user.id}:${msgId}`;
      const stash = editDraft.get(key);

      if (!stash || typeof stash.hh !== "number") {
        await interaction.reply({ content: "세션이 만료됐어요. 다시 시간변경을 눌러주세요.", ephemeral: true });
        return;
      }

      const mm = Number(interaction.values[0]);

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
      const msg = await board.messages.fetch(msgId).catch(() => null);
      if (!msg) {
        editDraft.delete(key);
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const embed = msg.embeds?.[0];
      const meta = parseMeta(embed?.footer?.text);
      if (!meta) {
        editDraft.delete(key);
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id);
      const canManage = interaction.user.id === meta.owner || isAdmin(member);
      if (!canManage) {
        editDraft.delete(key);
        await interaction.reply({ content: "파티장/운영진만 시간 변경이 가능해요.", ephemeral: true });
        return;
      }

      const start = new Date();
      start.setSeconds(0, 0);
      start.setHours(stash.hh, mm, 0, 0);

      const minAllowed = roundUpToNext5(new Date());
      if (!isSameDate(minAllowed, start)) {
        editDraft.delete(key);
        await interaction.reply({ content: "오늘 남은 시간이 거의 없어요. 내일 다시 변경해주세요.", ephemeral: true });
        return;
      }

      if (start.getTime() < minAllowed.getTime()) {
        await interaction.reply({
          content: `이미 지난 시간이에요. (최소 가능 시간: ${String(minAllowed.getHours()).padStart(2, "0")}:${String(
            minAllowed.getMinutes()
          ).padStart(2, "0")})`,
          ephemeral: true,
        });
        return;
      }

      const startAtUnix = toUnix(start);

      const rebuilt = EmbedBuilder.from(embed);
      const members = parseMembersFromEmbed(rebuilt);

      const title =
        (rebuilt.data.description ?? "").replace("🎯 **", "").replace("**", "").trim() || "파티";

      const noteField = (rebuilt.data.fields ?? []).find((f) => f.name === "특이사항")?.value ?? "";
      const note = noteField === "(없음)" ? "" : noteField;

      // 시간 변경 시 모집중으로 되돌림(정책)
      const newEmbed = buildPartyEmbed({
        ownerId: meta.owner,
        kind: meta.kind,
        title,
        note,
        mode: "TIME",
        startAtUnix,
        status: "RECRUIT",
        members,
      });

      await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
      await scheduleAutoPlaying(msg);

      await interaction.reply({ content: `시간을 <t:${startAtUnix}:t>로 변경했어요.`, ephemeral: true });
      await logSecret(guild, `🕒 [시간변경][ID:${msg.id}] ${meta.kind} / ${title} | → <t:${startAtUnix}:t> | by <@${interaction.user.id}>`);

      editDraft.delete(key);
      return;
    }

    /* ===== (M) 시간변경: 모이면 시작 ===== */
    if (ENABLE_PARTY && interaction.isButton() && interaction.customId.startsWith("edit_asap:")) {
      const msgId = interaction.customId.split(":")[1];

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
      const msg = await board.messages.fetch(msgId).catch(() => null);
      if (!msg) {
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const embed = msg.embeds?.[0];
      const meta = parseMeta(embed?.footer?.text);
      if (!meta) {
        await interaction.reply({ content: "주문서를 찾지 못했어요.", ephemeral: true });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id);
      const canManage = interaction.user.id === meta.owner || isAdmin(member);
      if (!canManage) {
        await interaction.reply({ content: "파티장/운영진만 시간 변경이 가능해요.", ephemeral: true });
        return;
      }

      const rebuilt = EmbedBuilder.from(embed);
      const members = parseMembersFromEmbed(rebuilt);

      const title =
        (rebuilt.data.description ?? "").replace("🎯 **", "").replace("**", "").trim() || "파티";

      const noteField = (rebuilt.data.fields ?? []).find((f) => f.name === "특이사항")?.value ?? "";
      const note = noteField === "(없음)" ? "" : noteField;

      clearTimer(msg.id);

      const newEmbed = buildPartyEmbed({
        ownerId: meta.owner,
        kind: meta.kind,
        title,
        note,
        mode: "ASAP",
        startAtUnix: toUnix(now()),
        status: "RECRUIT",
        members,
      });

      await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
      await interaction.reply({ content: "시작 방식을 “모이면 시작”으로 변경했어요.", ephemeral: true });
      await logSecret(guild, `⚡ [시간변경][ID:${msg.id}] ${meta.kind} / ${title} | → 모이면 시작 | by <@${interaction.user.id}>`);
      return;
    }
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content:
            "⚠️ 오류가 발생했습니다.\n대부분 **봇 역할 위치가 낮거나 권한이 부족**한 경우입니다.",
          ephemeral: true,
        });
      } catch {}
    }
  }
});

/* =========================
   13) Login
========================= */
client.login(DISCORD_TOKEN);

/* =========================
   14) Render용 더미 웹서버
========================= */
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  })
  .listen(PORT, () => {
    console.log(`🌐 Dummy web server running on port ${PORT}`);
  });
