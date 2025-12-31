// src/party/ui.js
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

function partyBoardEmbed() {
  return {
    color: 0x95a5a6,
    title: "📌 파티 현황판",
    description: [
      "아래 버튼으로 파티를 생성합니다.",
      "- 상시 운영",
      "- 종료 버튼 누르면 종료 고정(버튼 제거)",
      "- 상세 로그는 운영진 채널에만 기록",
    ].join("\n"),
  };
}

function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:create").setLabel("➕ 새 파티 만들기").setStyle(ButtonStyle.Success)
    ),
  ];
}

/**
 * 파티 생성 모달 (한 번에 끝)
 * - game: 게임 이름(필수)
 * - note: 주문서 특이사항(선택)
 * - mode: ASAP/TIME (필수)
 * - time: TIME일 때 HH:mm (선택)
 * - max: 최대인원(필수)
 */
function createPartyModal() {
  const modal = new ModalBuilder().setCustomId("party:create:submit").setTitle("새 파티 만들기");

  const game = new TextInputBuilder()
    .setCustomId("game")
    .setLabel("🎮 게임 이름")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("주문서 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const mode = new TextInputBuilder()
    .setCustomId("mode")
    .setLabel("시작 방식: ASAP 또는 TIME")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("TIME일 때 시작시간 (HH:mm) / ASAP이면 비워도 됨")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const max = new TextInputBuilder()
    .setCustomId("max")
    .setLabel("최대 인원(숫자)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(game),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(mode),
    new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(max)
  );

  return modal;
}

/**
 * 주문서 수정 모달
 * - note: 특이사항(선택)
 * - mode: ASAP/TIME (필수)
 * - time: TIME일 때 HH:mm (선택)
 */
function editPartyModal(messageId, partyRow) {
  const modal = new ModalBuilder().setCustomId(`party:edit:submit:${messageId}`).setTitle("주문서 수정");

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("주문서 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const mode = new TextInputBuilder()
    .setCustomId("mode")
    .setLabel("시작 방식: ASAP 또는 TIME")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const time = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("TIME일 때 시작시간 (HH:mm) / ASAP이면 비워도 됨")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  // 기본값 세팅(가능한 범위에서만)
  const currentNote = (partyRow.party_note ?? "").toString();
  const currentMode = (partyRow.mode ?? "ASAP").toString().toUpperCase();
  const currentStartAt = Number(partyRow.start_at || 0);

  note.setValue(currentNote.slice(0, 4000));
  mode.setValue(currentMode === "TIME" ? "TIME" : "ASAP");

  // TIME이면 HH:mm 채워주기
  if (currentMode === "TIME" && currentStartAt > 0) {
    const d = new Date(currentStartAt * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    time.setValue(`${hh}:${mm}`);
  } else {
    time.setValue("");
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(mode),
    new ActionRowBuilder().addComponents(time)
  );

  return modal;
}

/**
 * 파티 주문서 버튼들
 * - 시간변경 제거
 * - 수정 버튼 추가
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
 * 참가/비고 모달
 */
function joinNoteModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:joinnote:${msgId}`).setTitle("참가 비고(선택)");
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("비고(선택) 예: 10시참/늦참/뉴비")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

module.exports = {
  partyBoardEmbed,
  partyBoardComponents,
  createPartyModal,
  editPartyModal,
  partyActionRow,
  joinNoteModal,
};
