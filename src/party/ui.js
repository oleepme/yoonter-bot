// src/party/ui.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

function isUnlimitedKind(kind) {
  return kind === "MOVIE" || kind === "CHAT" || kind === "MUSIC";
}

function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription(
      [
        "아래 버튼으로 파티를 생성합니다.",
        "- 파티는 한 메시지(임베드)로 운영 (변경은 edit)",
        "- 종료 시 메시지는 남고 버튼만 제거됩니다.",
      ].join("\n")
    );
}

function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:create").setLabel("➕ 새 파티 만들기").setStyle(ButtonStyle.Success)
    ),
  ];
}

function kindSelectRow(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("파티 종류 선택")
      .addOptions(
        { label: "🕹️게임", value: "GAME" },
        { label: "🎥영화", value: "MOVIE" },
        { label: "💬수다", value: "CHAT" },
        { label: "🎤노래", value: "MUSIC" }
      )
  );
}

function cancelRow(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel("취소").setStyle(ButtonStyle.Secondary)
  );
}

function createPartyModal(kind) {
  const modal = new ModalBuilder().setCustomId(`party:create:submit:${kind}`).setTitle("새 파티 만들기");
  const rows = [];

  // ✅ GAME/MOVIE만 이름 입력 (기존 정책 유지)
  if (kind === "GAME") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("게임")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    rows.push(new ActionRowBuilder().addComponents(title));
  } else if (kind === "MOVIE") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("영화이름")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    rows.push(new ActionRowBuilder().addComponents(title));
  }

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("시간 (예: 오후3시/저녁9시/모바시) — 비우면 모바시")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  rows.push(new ActionRowBuilder().addComponents(note), new ActionRowBuilder().addComponents(time));

  // ✅ GAME만 인원제한 입력칸 노출
  if (!isUnlimitedKind(kind)) {
    const max = new TextInputBuilder()
      .setCustomId("max")
      .setLabel("인원제한(숫자)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
