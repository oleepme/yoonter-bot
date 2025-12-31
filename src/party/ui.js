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
        { label: "게임", value: "GAME" },
        { label: "영화", value: "MOVIE" },
        { label: "수다", value: "CHAT" },
        { label: "노래", value: "MUSIC" }
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

  // 조건부: 게임/영화일 때만 이름 입력
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

  const max = new TextInputBuilder()
    .setCustomId("max")
    .setLabel("인원제한(숫자)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  rows.push(
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(max)
  );

  modal.addComponents(...rows);
  return modal;
}

function editKindSelectRow(customId, currentKind) {
  // 현재 kind가 선택된 느낌은 placeholder로만 처리(Discord select는 preselect가 제한적)
  const placeholder = `현재: ${kindLabel(currentKind)} (변경할 종류 선택)`;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(
        { label: "게임", value: "GAME" },
        { label: "영화", value: "MOVIE" },
        { label: "수다", value: "CHAT" },
        { label: "노래", value: "MUSIC" }
      )
  );
}

function editPartyModal(messageId, kind, partyRow) {
  const modal = new ModalBuilder().setCustomId(`party:edit:submit:${messageId}:${kind}`).setTitle("파티 수정");

  const rows = [];

  // 조건부: 게임/영화면 이름 입력, 수다/노래면 없음
  if (kind === "GAME") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("게임")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue((partyRow.title ?? "").toString().slice(0, 100));
    rows.push(new ActionRowBuilder().addComponents(title));
  } else if (kind === "MOVIE") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("영화이름")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue((partyRow.title ?? "").toString().slice(0, 100));
    rows.push(new ActionRowBuilder().addComponents(title));
  }

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue((partyRow.party_note ?? "").toString().slice(0, 4000));

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("시간 (예: 오후3시/저녁9시/모바시) — 비우면 모바시")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue((partyRow.time_text ?? "").toString().slice(0, 200));

  const max = new TextInputBuilder()
    .setCustomId("max")
    .setLabel("인원제한(숫자)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(partyRow.max_players ?? 4));

  rows.push(
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(max)
  );

  modal.addComponents(...rows);
  return modal;
}

function partyActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("party:leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:edit").setLabel("수정").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger)
  );
}

function joinNoteModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:joinnote:${msgId}`).setTitle("참가 비고(선택)");
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("비고 예: 10시참/늦참/뉴비")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function kindLabel(kind) {
  if (kind === "GAME") return "🎮게임";
  if (kind === "MOVIE") return "🎬영화";
  if (kind === "CHAT") return "💬수다";
  if (kind === "MUSIC") return "🎤노래";
  return "게임";
}

function kindIcon(kind) {
  if (kind === "CHAT") return "💬";
  if (kind === "MOVIE") return "🎬";
  if (kind === "MUSIC") return "🎤";
  return "🎮";
}

function endedActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:delete").setLabel("🗑 삭제").setStyle(ButtonStyle.Danger)
  );
}

module.exports = {
  partyBoardEmbed,
  partyBoardComponents,
  kindSelectRow,
  cancelRow,
  createPartyModal,
  editPartyModal,
  partyActionRow,
  endedActionRow,   // ✅ 추가
  joinNoteModal,
  kindLabel,
  kindIcon,
};

