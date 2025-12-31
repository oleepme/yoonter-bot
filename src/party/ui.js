// src/party/ui.js
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
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

// ✅ 현황판(고정 메시지) 임베드/버튼
function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription(
      [
        "아래 버튼으로 새 파티를 생성합니다.",
        "- 파티는 1개의 임베드 메시지(주문서)로 운영합니다.",
        "- 변경은 메시지 새로 만들지 않고 edit로만 갱신합니다.",
      ].join("\n")
    );
}

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

// ✅ 종류 선택 버튼(4개)
function kindButtonsRow(prefix = "party:create:kindbtn") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:GAME`).setLabel("🎮 게임").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}:MOVIE`).setLabel("🎬 영화").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:CHAT`).setLabel("💬 수다").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}:MUSIC`).setLabel("🎤 노래").setStyle(ButtonStyle.Secondary)
  );
}

function cancelRow(customId = "party:cancel") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel("취소").setStyle(ButtonStyle.Secondary)
  );
}

// ✅ 파티 생성 모달 (GAME만 max 노출)
function createPartyModal(kind) {
  const modal = new ModalBuilder().setCustomId(`party:create:modal:${kind}`).setTitle(`새 ${kindLabel(kind)} 파티`);

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel(isUnlimitedKind(kind) ? "제목(선택)" : "제목(필수)")
    .setStyle(TextInputStyle.Short)
    .setRequired(!isUnlimitedKind(kind));

  const note = new TextInputBuilder()
    .setCustomId("party_note")
    .setLabel("주문서 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const time = new TextInputBuilder()
    .setCustomId("time_text")
    .setLabel("시간(자유 입력 / 모바시=비우기)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(time),
  );

  if (!isUnlimitedKind(kind)) {
    const max = new TextInputBuilder()
      .setCustomId("max_players")
      .setLabel("인원제한(2~20)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(max));
  }

  return modal;
}

// ✅ 파티 수정 모달 (kind 수정 불가 / GAME만 max 노출)
function editPartyModal(msgId, kind, party) {
  const modal = new ModalBuilder().setCustomId(`party:edit:modal:${msgId}`).setTitle(`파티 수정 (${kindLabel(kind)})`);

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel(isUnlimitedKind(kind) ? "제목(선택)" : "제목(필수)")
    .setStyle(TextInputStyle.Short)
    .setRequired(!isUnlimitedKind(kind))
    .setValue((party?.title ?? "").toString());

  const note = new TextInputBuilder()
    .setCustomId("party_note")
    .setLabel("주문서 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue((party?.party_note ?? "").toString());

  const time = new TextInputBuilder()
    .setCustomId("time_text")
    .setLabel("시간(자유 입력 / 모바시=비우기)")
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
      .setCustomId("max_players")
      .setLabel("인원제한(2~20)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(party?.max_players ?? 4));

    modal.addComponents(new ActionRowBuilder().addComponents(max));
  }

  return modal;
}

// ✅ 참가/비고 모달
function joinNoteModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:joinnote:${msgId}`).setTitle("참가/비고");

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("참가 비고(선택) 예: 늦참10 / 마이크X")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(note));
  return modal;
}

// ✅ 대기 모달 (버튼으로만 대기 가능)
function waitModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:wait:modal:${msgId}`).setTitle("대기 등록");

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("대기 코멘트(선택) 예: 밥먹고 자리나면")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(note));
  return modal;
}

// ✅ 운영진 강제참가 모달
function adminForceJoinModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:admin:forcejoin:${msgId}`).setTitle("운영진: 강제 참가");

  const users = new TextInputBuilder()
    .setCustomId("users")
    .setLabel("추가할 유저(멘션/ID/서버별명 여러 개 가능)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const mode = new TextInputBuilder()
    .setCustomId("mode")
    .setLabel("mode: add 또는 replace (기본 add)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(users), new ActionRowBuilder().addComponents(mode));
  return modal;
}

// ✅ 파티 주문서 버튼 (2줄, 중복 없음)
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
      new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("party:admin").setLabel("관리(운영진)").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ✅ 종료 상태: 삭제 버튼만 남김
function endedActionRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:delete").setLabel("🗑 삭제").setStyle(ButtonStyle.Danger),
    ),
  ];
}

module.exports = {
  // embed/board
  partyBoardEmbed,
  partyBoardComponents,

  // modals
  createPartyModal,
  editPartyModal,
  joinNoteModal,
  waitModal,
  adminForceJoinModal,

  // buttons/rows
  kindButtonsRow,
  cancelRow,
  partyActionRows,
  endedActionRow,

  // labels
  isUnlimitedKind,
  kindLabel,
  kindIcon,
};
