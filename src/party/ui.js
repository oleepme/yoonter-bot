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

// 생성 모달: 게임/특이사항/최대인원 (시간칸 없음)
function createPartyModal() {
  const modal = new ModalBuilder().setCustomId("party:create:submit").setTitle("새 파티 만들기");

  const game = new TextInputBuilder()
    .setCustomId("game")
    .setLabel("🎮 게임 이름")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("파티 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const max = new TextInputBuilder()
    .setCustomId("max")
    .setLabel("파티 인원(숫자)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(game),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(max)
  );
  return modal;
}

// 수정 모달: 게임/특이사항/인원 모두 수정 가능
function editPartyModal(messageId, partyRow) {
  const modal = new ModalBuilder().setCustomId(`party:edit:submit:${messageId}`).setTitle("파티 수정");

  const game = new TextInputBuilder()
    .setCustomId("game")
    .setLabel("🎮 게임 이름")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue((partyRow.title ?? "").toString().slice(0, 100));

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("파티 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue((partyRow.party_note ?? "").toString().slice(0, 4000));

  const max = new TextInputBuilder()
    .setCustomId("max")
    .setLabel("파티 인원(숫자)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(partyRow.max_players ?? 4));

  modal.addComponents(
    new ActionRowBuilder().addComponents(game),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(max)
  );
  return modal;
}

// 시간 선택(드롭다운): 1) 시 선택, 2) 분 선택(00/15/30/45)
function hourSelectRow(customId) {
  const opts = [];
  for (let h = 0; h < 24; h++) opts.push({ label: `${String(h).padStart(2, "0")}시`, value: String(h) });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("시간(시) 선택").addOptions(opts)
  );
}

function minuteSelectRow(customId) {
  const opts = [];
  for (let m = 0; m < 60; m += 5) {
    const v = String(m).padStart(2, "0");
    opts.push({ label: `${v}분`, value: v });
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("시간(분) 선택 (5분 단위)")
      .addOptions(opts)
  );
}


// 시간 단계 공통 버튼: 모바시 / 취소
function timeStepButtons({ mobashiId, cancelId, mobashiLabel = "⚡ 모바시로 생성", cancelLabel = "취소" }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(mobashiId).setLabel(mobashiLabel).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cancelId).setLabel(cancelLabel).setStyle(ButtonStyle.Secondary)
  );
}

// 파티 메시지 액션 버튼
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

module.exports = {
  partyBoardEmbed,
  partyBoardComponents,
  createPartyModal,
  editPartyModal,
  hourSelectRow,
  minuteSelectRow,
  timeStepButtons,
  partyActionRow,
  joinNoteModal,
};
