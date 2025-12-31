// src/party/ui.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

/**
 * MOVIE/CHAT/MUSIC = 인원 제한 없음(무한 참가)
 */
function isUnlimitedKind(kind) {
  return kind === "MOVIE" || kind === "CHAT" || kind === "MUSIC";
}

function kindLabel(kind) {
  if (kind === "GAME") return "게임";
  if (kind === "MOVIE") return "영화";
  if (kind === "CHAT") return "수다";
  if (kind === "MUSIC") return "노래";
  return "게임";
}

function kindIcon(kind) {
  if (kind === "MOVIE") return "🎬";
  if (kind === "CHAT") return "💬";
  if (kind === "MUSIC") return "🎤";
  return "🎮";
}

/**
 * (선택) 파티 현황판(고정메시지) 임베드
 */
function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription(
      [
        "아래 버튼으로 파티를 생성합니다.",
        "- 파티는 한 메시지(임베드)로 운영 (변경은 edit)",
        "- 종료 시 버튼 제거 + 🗑 삭제 버튼만 남김",
      ].join("\n")
    );
}

/**
 * (선택) 현황판에 붙일 버튼
 */
function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("party:create")
        .setLabel("➕ 새 파티 만들기")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

/**
 * ✅ 종류 선택을 버튼 4개로 제공
 * handler에서 customId prefix로 분기:
 * - party:create:kindbtn:GAME
 * - party:create:kindbtn:MOVIE
 * - party:create:kindbtn:CHAT
 * - party:create:kindbtn:MUSIC
 */
function kindButtonsRow(customIdPrefix = "party:create:kindbtn") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:GAME`)
      .setLabel("🕹️ 게임")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:MOVIE`)
      .setLabel("🎥 영화")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:CHAT`)
      .setLabel("💬 수다")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:MUSIC`)
      .setLabel("🎤 노래")
      .setStyle(ButtonStyle.Secondary)
  );
}

function cancelRow(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel("취소").setStyle(ButtonStyle.Secondary)
  );
}

/**
 * 파티 생성 모달
 * - GAME/MOVIE: title 필수
 * - CHAT/MUSIC: title 없음(입력칸 없음)
 * - GAME만 max 입력칸 노출
 */
function createPartyModal(kind) {
  const modal = new ModalBuilder()
    .setCustomId(`party:create:submit:${kind}`)
    .setTitle("새 파티 만들기");

  const rows = [];

  // ✅ GAME/MOVIE만 제목
  if (kind === "GAME") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("게임 이름(필수)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    rows.push(new ActionRowBuilder().addComponents(title));
  } else if (kind === "MOVIE") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("영화 이름(필수)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    rows.push(new ActionRowBuilder().addComponents(title));
  }

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("시간(선택) — 비우면 모바시")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  rows.push(new ActionRowBuilder().addComponents(note));
  rows.push(new ActionRowBuilder().addComponents(time));

  // ✅ GAME만 인원제한 입력
  if (!isUnlimitedKind(kind)) {
    const max = new TextInputBuilder()
      .setCustomId("max")
      .setLabel("인원제한(2~20 숫자)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    rows.push(new ActionRowBuilder().addComponents(max));
  }

  modal.addComponents(...rows);
  return modal;
}

/**
 * 파티 수정 모달
 * - kind 수정 불가(핸들러에서 kind는 DB 값 사용)
 * - GAME만 max 수정 노출
 */
function editPartyModal(messageId, kind, partyRow) {
  const modal = new ModalBuilder()
    .setCustomId(`party:edit:submit:${messageId}:${kind}`)
    .setTitle("파티 수정");

  const rows = [];

  if (kind === "GAME") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("게임 이름(필수)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue((partyRow.title ?? "").toString().slice(0, 100));
    rows.push(new ActionRowBuilder().addComponents(title));
  } else if (kind === "MOVIE") {
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("영화 이름(필수)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue((partyRow.title ?? "").toString().slice(0, 100));
    rows.push(new ActionRowBuilder().addComponents(title));
  }

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue((partyRow.party_note ?? "").toString().slice(0, 4000));

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("시간(선택) — 비우면 모바시")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue((partyRow.time_text ?? "").toString().slice(0, 200));

  rows.push(new ActionRowBuilder().addComponents(note));
  rows.push(new ActionRowBuilder().addComponents(time));

  if (!isUnlimitedKind(kind)) {
    const max = new TextInputBuilder()
      .setCustomId("max")
      .setLabel("인원제한(2~20 숫자)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(partyRow.max_players ?? 4));
    rows.push(new ActionRowBuilder().addComponents(max));
  }

  modal.addComponents(...rows);
  return modal;
}

/**
 * 파티 메시지의 기본 버튼 5개
 */
function partyActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("party:leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:edit").setLabel("수정").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger)
  );
}

/**
 * 종료 상태에서 노출되는 삭제 버튼
 */
function endedActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:delete").setLabel("🗑 삭제").setStyle(ButtonStyle.Danger)
  );
}

/**
 * 참가 비고 입력 모달
 */
function joinNoteModal(msgId) {
  const modal = new ModalBuilder()
    .setCustomId(`party:joinnote:${msgId}`)
    .setTitle("참가 비고(선택)");

  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("비고(선택) 예: 늦참10/마이크X")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

module.exports = {
  isUnlimitedKind,
  kindLabel,
  kindIcon,

  partyBoardEmbed,
  partyBoardComponents,

  kindButtonsRow,
  cancelRow,

  createPartyModal,
  editPartyModal,

  partyActionRow,
  endedActionRow,

  joinNoteModal,
};
