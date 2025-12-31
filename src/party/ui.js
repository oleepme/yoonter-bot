// src/party/ui.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const KIND_OPTIONS = [
  { label: "게임", value: "게임", emoji: "🎮" },
  { label: "노래", value: "노래", emoji: "🎵" },
  { label: "영화", value: "영화", emoji: "🎬" },
  { label: "수다", value: "수다", emoji: "💬" }
];

function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판")
    .setDescription([
      "아래 버튼으로 파티를 생성합니다.",
      "- 상시 운영",
      "- 종료 버튼 누르면 삭제",
      "- 상세 로그는 운영진 채널에만 기록"
    ].join("\n"));
  // footer 메타 금지
}

function partyBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("party:create").setLabel("➕ 새 파티 만들기").setStyle(ButtonStyle.Success)
    )
  ];
}

function kindSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("party:draft:kind")
      .setPlaceholder("카테고리 1 선택")
      .addOptions(KIND_OPTIONS.map(o => ({ label: o.label, value: o.value, emoji: o.emoji })))
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
    .setLabel("주문서 특이사항(선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(note)
  );
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
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("시 선택").addOptions(options.slice(0, 25))
  );
}

function minuteSelectRow(customId) {
  const options = [];
  for (let m = 0; m < 60; m += 5) options.push({ label: `${String(m).padStart(2, "0")}분`, value: String(m) });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder("분(5분 단위) 선택").addOptions(options)
  );
}

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

function statusText(status) {
  if (status === "PLAYING") return "플레이중";
  if (status === "ENDED") return "종료";
  return "모집중";
}

function startText(mode, startAtUnix) {
  if (mode === "ASAP") return "⚡ 모이면 바로 시작";
  return `🕒 <t:${startAtUnix}:t> ( <t:${startAtUnix}:R> )`;
}

function buildPartyEmbedFromDb(party) {
  const {
    status,
    title,
    party_note,
    mode,
    start_at,
    max_players,
    members
  } = party;

  const noteLine = (party_note && party_note.trim()) ? party_note.trim() : "(없음)";
  const timeLine = startText(mode, Number(start_at));

  const slots = [];
  const list = Array.isArray(members) ? members : [];
  for (let i = 0; i < (max_players || 4); i++) {
    const m = list[i];
    if (!m) slots.push(`${i + 1}.`);
    else slots.push(`${i + 1}. <@${m.user_id}>${m.note ? ` — ${m.note}` : ""}`);
  }

  return new EmbedBuilder()
    .setColor(status === "PLAYING" ? 0x2ecc71 : status === "ENDED" ? 0x95a5a6 : 0xe74c3c)
    // 상단 1줄: 상태
    .setTitle(statusText(status))
    // 상단 2줄: 🎮 게임 이름
    .setDescription(`🎮 ${title}`)
    // 1행(2칸): 특이사항/시간
    .addFields(
      { name: "주문서 특이사항", value: noteLine, inline: true },
      { name: "시간", value: timeLine, inline: true },
      // 2행(1칸): 참가자 목록
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
