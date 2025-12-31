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
 * 파티 종류 정책
 * - GAME: 인원 제한(슬롯형)
 * - MOVIE/CHAT/MUSIC: 무제한(리스트형), 인원 입력 UI 없음
 */
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

/**
 * 현황판(핀 메시지) - footer 텍스트로 “이게 현황판이다”를 식별함
 * ※ index.js의 ensurePinnedMessage가 이 footerText로 기존 핀을 찾는 방식이어야 함
 */
function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription(
      [
        "아래 버튼으로 파티를 생성합니다.",
        "",
        "- 파티는 임베드 1개 메시지(주문서)로 운영",
        "- 변경은 새 메시지 생성 없이 edit()로만 반영",
        "- 종료 시 주문서는 삭제",
      ].join("\n"),
    )
    .setFooter({ text: "DDG|partyboard|v1" });
}

/**
 * 현황판 버튼 4종(에페메랄 선택 단계 제거)
 * customId: party:create:<KIND>
 */
function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:create:GAME").setLabel("🎮 게임 하기").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("party:create:MOVIE").setLabel("🎬 영화 보기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:create:CHAT").setLabel("💬 수다 떨기").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:create:MUSIC").setLabel("🎤 노래 부르기").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * 생성 모달
 * - GAME만 max 입력 받음
 * - time은 자유 입력(비우면 모바시)
 */
function createPartyModal(kind) {
  const modal = new ModalBuilder()
    .setCustomId(`party:create:submit:${kind}`)
    .setTitle(`새 ${kindLabel(kind)} 파티`);

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

/**
 * 수정 모달
 * - kind는 수정 불가(요구사항)
 * - GAME만 max 입력 받음
 */
function editPartyModal(msgId, kind, party) {
  const modal = new ModalBuilder()
    .setCustomId(`party:edit:submit:${msgId}`)
    .setTitle(`파티 수정 (${kindLabel(kind)})`);

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

/**
 * 참가/비고 모달
 */
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

/**
 * 대기 등록 모달(선택 코멘트)
 */
function waitModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:wait:submit:${msgId}`).setTitle("대기 등록");
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("대기 코멘트(선택) 예: 자리나면 합류")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

/**
 * 운영진 강제 참가 모달
 */
function adminForceJoinModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:admin:forcejoin:${msgId}`).setTitle("운영진: 강제 참가");

  const users = new TextInputBuilder()
    .setCustomId("users")
    .setLabel("서버별명/멘션/ID 여러 개 (줄바꿈/쉼표 구분)")
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

/**
 * 주문서 버튼(2줄)
 */
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
      new ButtonBuilder().setCustomId("party:admin").setLabel("관리(운영진)").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * 종료 상태에서 남기는 버튼(삭제)
 */
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
  joinNoteModal,
  waitModal,
  adminForceJoinModal,

  partyActionRows,
  endedActionRow,

  isUnlimitedKind,
  kindLabel,
  kindIcon,
};
