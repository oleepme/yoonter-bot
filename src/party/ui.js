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

const KIND_OPTIONS = [
  { label: "게임", value: "게임", emoji: "🎮" },
  { label: "노래", value: "노래", emoji: "🎵" },
  { label: "영화", value: "영화", emoji: "🎬" },
  { label: "수다", value: "수다", emoji: "💬" },
];

// 1) 파티 현황판(고정 메시지) — “지저분한 설명” 최소화
function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription("아래 버튼으로 새 파티를 생성합니다.");
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

// 2) 생성 플로우
function kindSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("party:draft:kind")
      .setPlaceholder("카테고리 1 선택")
      .addOptions(KIND_OPTIONS.map((o) => ({ label: o.label, value: o.value, emoji: o.emoji })))
  );
}

function detailsModal() {
  const modal = new ModalBuilder().setCustomId("party:draft:details").setTitle("파티 정보 입력");

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("게임 이름")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const note = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(title), new ActionRowBuilder().addComponents(note));
  return modal;
}

function timeModeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:draft:asap").setLabel("⚡ 모이면 바로 시작").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("party:draft:time").setLabel("🕒 시간 지정").setStyle(ButtonStyle.Secondary)
  );
}

function hourSelectRow(customId) {
  const options = [];
  for (let h = 0; h <= 23; h++) options.push({ label: `${String(h).padStart(2, "0")}시`, value: String(h) });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("시 선택").addOptions(options)
  );
}

function minuteSelectRow(customId) {
  const options = [];
  for (let m = 0; m < 60; m += 5) options.push({ label: `${String(m).padStart(2, "0")}분`, value: String(m) });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("분(5분 단위) 선택").addOptions(options)
  );
}

// 3) 파티 메시지 버튼
function partyActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("party:leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:time").setLabel("시간변경").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger)
  );
}

function joinNoteModal(msgId) {
  const modal = new ModalBuilder().setCustomId(`party:joinnote:${msgId}`).setTitle("참가 비고(선택)");
  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("비고(선택) 예: 늦참10 / 마이크X")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// 4) DB -> 임베드 렌더링 (footer 메타 없음)
function buildPartyEmbedFromDb(party) {
  const max = Number(party.max_players || 4);

  const slots = [];
  for (let i = 0; i < max; i++) {
    const m = party.members?.[i];
    if (!m) slots.push(`${i + 1}.`);
    else slots.push(`${i + 1}. <@${m.user_id}>${m.note ? ` — ${m.note}` : ""}`);
  }

  const status = party.status;
  const statusLine = status === "PLAYING" ? "🟢 게임중" : status === "ENDED" ? "⚫ 종료" : "🔴 모집중";

  const timeLine =
    party.mode === "ASAP" ? "⚡ 모이면 바로 시작" : `🕒 <t:${Number(party.start_at)}:F> ( <t:${Number(party.start_at)}:R> )`;

  return new EmbedBuilder()
    .setColor(status === "PLAYING" ? 0x2ecc71 : status === "ENDED" ? 0x95a5a6 : 0xe74c3c)
    .setTitle(statusLine)
    .setDescription(`🎮 ${party.title}`)
    .addFields(
      { name: "특이사항", value: party.party_note?.trim() ? party.party_note.trim() : "(없음)", inline: true },
      { name: "시간", value: timeLine, inline: true },
      { name: "참가자", value: slots.join("\n"), inline: false }
    );
}

module.exports = {
  partyBoardEmbed,
  partyBoardComponents,
  kindSelectRow,
  detailsModal,
  timeModeRow,
  hourSelectRow,
  minuteSelectRow,
  partyActionRow,
  joinNoteModal,
  buildPartyEmbedFromDb,
};
