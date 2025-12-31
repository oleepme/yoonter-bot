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

// 1) 파티 현황판(고정 메시지) - "상세 메시지" 삭제 버전
function partyBoardEmbed() {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("📌 파티 현황판");
  // description 없음, footer 없음 (DDG 문자열 노출 방지)
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

// 2) "새 파티 만들기" 모달 (한 번에 입력)
function createPartyModal() {
  const modal = new ModalBuilder()
    .setCustomId("party:create:modal")
    .setTitle("새 파티 만들기");

  const game = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("🎮 게임 이름")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const note = new TextInputBuilder()
    .setCustomId("party_note")
    .setLabel("특이사항 (선택)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  const time = new TextInputBuilder()
    .setCustomId("start_hhmm")
    .setLabel("시작시간 (HH:mm) / 비우면 모바시")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("예: 14:05");

  const max = new TextInputBuilder()
    .setCustomId("max_players")
    .setLabel("최대 인원 (숫자)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("예: 4");

  modal.addComponents(
    new ActionRowBuilder().addComponents(game),
    new ActionRowBuilder().addComponents(note),
    new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(max)
  );

  return modal;
}

// 3) 참가 비고 모달
function joinNoteModal(messageId) {
  const modal = new ModalBuilder()
    .setCustomId(`party:joinnote:${messageId}`)
    .setTitle("참가 비고(선택)");

  const input = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("비고 예: 늦참10 / 마이크X")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// 4) 시간 변경 모달
function timeChangeModal(messageId) {
  const modal = new ModalBuilder()
    .setCustomId(`party:timechange:${messageId}`)
    .setTitle("시간 변경");

  const time = new TextInputBuilder()
    .setCustomId("start_hhmm")
    .setLabel("시작시간 (HH:mm)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("예: 14:05");

  modal.addComponents(new ActionRowBuilder().addComponents(time));
  return modal;
}

// 5) 파티 버튼들
function partyActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("party:join").setLabel("참가/비고").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("party:leave").setLabel("나가기").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:time").setLabel("시간변경").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("party:start").setLabel("시작").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("party:end").setLabel("종료").setStyle(ButtonStyle.Danger)
  );
}

// 6) 임베드 렌더링 (네가 요구한 레이아웃 고정)
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
  const status = party.status || "RECRUIT";
  const title = party.title || "";
  const partyNote = (party.party_note || "").trim() || "(없음)";
  const mode = party.mode || "TIME";
  const startAt = Number(party.start_at || 0);
  const maxPlayers = Number(party.max_players || 4);
  const members = Array.isArray(party.members) ? party.members : [];

  // 번호 슬롯 고정 1..maxPlayers
  const slots = [];
  for (let i = 0; i < maxPlayers; i++) {
    const m = members[i];
    if (!m) slots.push(`${i + 1}.`);
    else slots.push(`${i + 1}. <@${m.user_id}>${m.note ? ` — ${m.note}` : ""}`);
  }

  return new EmbedBuilder()
    .setColor(status === "PLAYING" ? 0x2ecc71 : status === "ENDED" ? 0x95a5a6 : 0xe74c3c)
    // 상단 1줄: 상태
    .setTitle(statusText(status))
    // 상단 2줄: 🎮 게임 이름
    .setDescription(`🎮 ${title}`)
    // 1행(2칸): 특이사항 / 시간
    .addFields(
      { name: "특이사항", value: partyNote, inline: true },
      { name: "시간", value: startText(mode, startAt), inline: true },
      // 2행(1칸): 참가자
      { name: "참가자", value: slots.join("\n"), inline: false }
    );
}

module.exports = {
  partyBoardEmbed,
  partyBoardComponents,
  createPartyModal,
  joinNoteModal,
  timeChangeModal,
  partyActionRow,
  buildPartyEmbedFromDb,
};
