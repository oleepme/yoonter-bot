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

// 현황판(고정메시지)
function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription("아래 버튼으로 파티를 생성합니다.");
}

// ✅ 종류별 생성 버튼(에페메랄 0)
function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:create:GAME").setLabel("🕹️ 게임 하기").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("party:create:MOVIE").setLabel("🎥 영화 보기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:create:CHAT").setLabel("💬 수다 떨기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:create:MUSIC").setLabel("🎤 노래 부르기").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// 생성 모달
function createPartyModal(kind) {
  const modal = new ModalBuilder()
    .setCustomId(`party:create:submit:${kind}`)
    .setTitle("새 파티 만들기");

  const rows = [];

  if (kind === "GAME") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("게임 이름(필수)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  } else if (kind === "MOVIE") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("영화 이름(필수)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("note")
        .setLabel("특이사항(선택)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false),
    ),
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("시간(선택) — 비우면 모바시")
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
  );

  // ✅ GAME만 인원제한
  if (!isUnlimitedKind(kind)) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("max")
          .setLabel("인원제한(2~20 숫자)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  }

  modal.addComponents(...rows);
  return modal;
}

// 수정 모달
function editPartyModal(messageId, kind, partyRow) {
  const modal = new ModalBuilder()
    .setCustomId(`party:edit:submit:${messageId}:${kind}`)
    .setTitle("파티 수정");

  const rows = [];

  if (kind === "GAME") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("게임 이름(필수)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue((partyRow.title ?? "").toString().slice(0, 100)),
      ),
    );
  } else if (kind === "MOVIE") {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("영화 이름(필수)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue((partyRow.title ?? "").toString().slice(0, 100)),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("note")
        .setLabel("특이사항(선택)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue((partyRow.party_note ?? "").toString().slice(0, 4000)),
    ),
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("시간(선택) — 비우면 모바시")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue((partyRow.time_text ?? "").toString().slice(0, 200)),
    ),
  );

  if (!isUnlimitedKind(kind)) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("max")
          .setLabel("인원제한(2~20 숫자)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(partyRow.max_players ?? 4)),
      ),
    );
  }

  modal.addComponents(...rows);
  return modal;
}

// 참가 비고 모달
function joinNoteModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:joinnote:${msgId}`).setTitle("참가 비고(선택)");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("note")
        .setLabel("비고(선택) 예: 늦참10/마이크X")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false),
    ),
  );

  return modal;
}

// ✅ 운영진 강제참가 모달(UI만)
function adminForceJoinModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:admin:forcejoin:${msgId}`).setTitle("운영진: 강제 참가");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("users")
        .setLabel("추가할 유저 (멘션/ID 여러 개 가능)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("mode")
        .setLabel("모드: add 또는 replace (기본 add)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
  );

  return modal;
}

// ✅ 버튼은 5개 제한 때문에 2줄로 반환
function partyActionRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("party:leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:edit").setLabel("수정").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:admin").setLabel("관리(운영진)").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function endedActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:delete").setLabel("🗑 삭제").setStyle(ButtonStyle.Danger),
  );
}

module.exports = {
  isUnlimitedKind,
  kindLabel,
  kindIcon,
  partyBoardEmbed,
  partyBoardComponents,
  createPartyModal,
  editPartyModal,
  joinNoteModal,
  adminForceJoinModal,
  partyActionRows,
  endedActionRow,
};
