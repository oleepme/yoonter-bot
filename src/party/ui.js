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

function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription(["아래에서 파티 종류를 눌러 바로 생성합니다.", "파티는 임베드 1개 메시지로 운영됩니다."].join("\n"))
    .setFooter({ text: "DDG|partyboard|v1" });
}

function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:create:GAME").setLabel("🎮 게임").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("party:create:MOVIE").setLabel("🎬 영화").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:create:CHAT").setLabel("💬 수다").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:create:MUSIC").setLabel("🎤 노래").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createPartyModal(kind) {
  const modal = new ModalBuilder().setCustomId(`party:create:submit:${kind}`).setTitle(`새 ${kindLabel(kind)} 파티`);

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel(isUnlimitedKind(kind) ? "제목(선택)" : "제목(필수)")
    .setStyle(TextInputStyle.Short)
    .setRequired(!isUnlimitedKind(kind));

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("시간(자유입력 / 비우면 모바시)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(time),
  );

  if (!isUnlimitedKind(kind)) {
    const max = new TextInputBuilder()
      .setCustomId("max")
      .setLabel("인원제한(2~20)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(max));
  }

  return modal;
}

// ✅ 파티 정보 수정 모달(파티장/운영진 공용) — 인원 추가/제거 없음
function editPartyModal(msgId, party /* isAdminEdit unused but kept for compatibility */, _isAdminEdit) {
  const kind = party?.kind || "GAME";

  const modal = new ModalBuilder().setCustomId(`party:edit:submit:${msgId}`).setTitle("파티 수정");

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel(isUnlimitedKind(kind) ? "제목(선택)" : "제목(필수)")
    .setStyle(TextInputStyle.Short)
    .setRequired(!isUnlimitedKind(kind))
    .setValue((party?.title ?? "").toString());

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue((party?.party_note ?? "").toString());

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("시간(자유입력 / 비우면 모바시)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue((party?.time_text ?? "").toString());

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(time),
  );

  if (!isUnlimitedKind(kind)) {
    const max = new TextInputBuilder()
      .setCustomId("max")
      .setLabel("인원제한(2~20)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(party?.max_players ?? 4));

    modal.addComponents(new ActionRowBuilder().addComponents(max));
  }

  return modal;
}

// ✅ 운영진 전용 인원 관리 모달(슬롯 텍스트 1칸)
function manageMembersModal(msgId, slotsText) {
  const modal = new ModalBuilder().setCustomId(`party:manage:submit:${msgId}`).setTitle("인원 관리(운영진)");

  const input = new TextInputBuilder()
    .setCustomId("slots_text")
    .setLabel("슬롯 편집 (적으면 추가 / 지우면 제거)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue((slotsText ?? "").toString().slice(0, 3900));

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function joinNoteModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:joinnote:${msgId}`).setTitle("참가/비고");
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("비고(선택) 예: 늦참10 / 마이크X")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function waitModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:wait:submit:${msgId}`).setTitle("대기 등록");
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("대기 코멘트(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function partyActionRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("party:leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:wait").setLabel("대기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:waitoff").setLabel("대기 해지").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:edit").setLabel("수정").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:manage").setLabel("인원 관리").setStyle(ButtonStyle.Secondary), // ✅ 운영진 전용(핸들러에서 권한 체크)
      new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function endedActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:delete").setLabel("🗑 삭제").setStyle(ButtonStyle.Danger),
  );
}

module.exports = {
  partyBoardEmbed,
  partyBoardComponents,
  createPartyModal,
  editPartyModal,
  manageMembersModal,
  joinNoteModal,
  waitModal,
  partyActionRows,
  endedActionRow,
  kindLabel,
  kindIcon,
  isUnlimitedKind,
};
