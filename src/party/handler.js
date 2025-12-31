// src/party/handler.js
const {
  InteractionType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const ui = require("./ui");
const config = require("../config");
const {
  initDb,
  upsertParty,
  getParty,
  setMemberNote,
  removeMember,
  deleteParty,
  setPartyStatus,
  updatePartyTime,
  listDueParties,
  listActiveParties,
} = require("../db");

/**
 * 핵심 방침:
 * - "이 메시지가 파티인지"는 footer/DDG 메타로 판단하지 않고 DB로 판단.
 * - messageId로 getParty(messageId) 조회해서 있으면 파티.
 */

const DRAFT = new Map(); // userId -> draft object

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// KST(한국) 기준 HH:mm -> unix seconds(UTC)
function kstUnixFromHHMM(hh, mm) {
  const now = new Date();
  const nowMs = now.getTime();

  // KST = UTC+9
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kstNow = new Date(nowMs + KST_OFFSET_MS);

  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();

  // "KST yyyy-mm-dd HH:mm" 을 UTC로 되돌림(-9h)
  let targetUtcMs = Date.UTC(y, m, d, hh, mm, 0, 0) - KST_OFFSET_MS;

  // 이미 지난 시간이면 내일로
  if (targetUtcMs <= nowMs) targetUtcMs += 24 * 60 * 60 * 1000;

  return Math.floor(targetUtcMs / 1000);
}

function safeTrim(v) {
  return (v ?? "").toString().trim();
}

function buildPartyEmbedFromDb(party) {
  // ui 버전에 따라 함수명이 다를 수 있어서 분기
  if (typeof ui.buildPartyEmbedFromDb === "function") {
    return ui.buildPartyEmbedFromDb(party);
  }

  // 구버전 ui: buildPartyEmbed(ownerId, ownerRoleLabel, kind...)
  if (typeof ui.buildPartyEmbed === "function") {
    const members = (party.members || []).map((m) => ({ userId: m.user_id, note: m.note || "" }));
    return ui.buildPartyEmbed({
      ownerId: party.owner_id,
      ownerRoleLabel: party.owner_role_label || "",
      kind: party.kind,
      title: party.title,
      note: party.party_note,
      mode: party.mode,
      startAtUnix: Number(party.start_at),
      status: party.status,
      members,
    });
  }

  // 최후 보험(최소 임베드)
  return new EmbedBuilder()
    .setTitle("파티")
    .setDescription(party.title || "(제목 없음)");
}

async function refreshPartyMessage(client, party) {
  const guild = await client.guilds.fetch(party.guild_id).catch(() => null);
  if (!guild) return false;

  const channel = await guild.channels.fetch(party.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  const msg = await channel.messages.fetch(party.message_id).catch(() => null);
  if (!msg) return false;

  const embed = buildPartyEmbedFromDb(party);
  const row = typeof ui.partyActionRow === "function" ? ui.partyActionRow() : null;

  await msg.edit({
    embeds: [embed],
    components: row ? [row] : [],
  });

  return true;
}

async function mustGetParty(interaction) {
  const msgId = interaction.message?.id;
  if (!msgId) return null;

  const party = await getParty(msgId);
  return party || null;
}

/**
 * ✅ index.js가 이걸 부르고 있음:
 * const { handleParty, runPartyTick, syncOrderMessage } = require("./party/handler");
 */

// 1) 파티 현황판(고정 메시지) 동기화
async function syncOrderMessage(client) {
  const guildId = config.GUILD_ID;
  const channelId = config.PARTY_BOARD_CHANNEL_ID;
  if (!guildId || !channelId) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  // 핀 메시지 중 “파티 현황판” 있으면 재사용, 없으면 생성+핀
  const pins = await channel.messages.fetchPins().catch(() => null);
  const pinned = pins?.find((m) => m.author?.id === client.user?.id);

  const embed = typeof ui.partyBoardEmbed === "function"
    ? ui.partyBoardEmbed()
    : new EmbedBuilder().setTitle("📌 파티 현황판").setDescription("아래 버튼으로 파티를 생성합니다.");

  const components = typeof ui.partyBoardComponents === "function"
    ? ui.partyBoardComponents()
    : [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("party:create")
            .setLabel("➕ 새 파티 만들기")
            .setStyle(ButtonStyle.Success)
        ),
      ];

  if (pinned) {
    await pinned.edit({ embeds: [embed], components }).catch(() => {});
    return;
  }

  const msg = await channel.send({ embeds: [embed], components }).catch(() => null);
  if (msg) await msg.pin().catch(() => {});
}

// 2) 자동 틱: 시간이 되면 모집중 -> 게임중
async function runPartyTick(client) {
  // listDueParties가 없으면(구버전) 자동전환은 일단 스킵
  if (typeof listDueParties !== "function") return;

  const due = await listDueParties(nowUnix()).catch(() => []);
  if (!Array.isArray(due) || due.length === 0) return;

  for (const messageId of due) {
    try {
      await setPartyStatus(messageId, "PLAYING");
      const party = await getParty(messageId);
      if (!party) continue;
      await refreshPartyMessage(client, party);
    } catch (e) {
      console.error("runPartyTick error:", e);
    }
  }
}

// 3) 인터랙션 핸들러
async function handleParty(interaction) {
  const client = interaction.client;

  // =========================
  // A) 현황판: 새 파티 만들기
  // =========================
  if (interaction.isButton() && interaction.customId === "party:create") {
    // ui 버전에 따라:
    // - 신버전: kindSelectRow로 단계 진행
    // - 구버전: createPartyModal로 한 번에 입력
    if (typeof ui.kindSelectRow === "function") {
      DRAFT.set(interaction.user.id, {});
      await interaction.reply({
        content: "카테고리를 선택하세요.",
        components: [ui.kindSelectRow()],
        ephemeral: true,
      });
      return true;
    }

    if (typeof ui.createPartyModal === "function") {
      await interaction.showModal(ui.createPartyModal());
      return true;
    }

    // 보험
    await interaction.reply({ content: "UI 구성이 준비되지 않았습니다(ui.js 확인 필요).", ephemeral: true });
    return true;
  }

  // =========================
  // B) 신버전 생성 플로우 (select + modal + 버튼)
  // =========================
  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:kind") {
    const d = DRAFT.get(interaction.user.id) || {};
    d.kind = interaction.values[0];
    DRAFT.set(interaction.user.id, d);

    if (typeof ui.detailsModal === "function") {
      await interaction.showModal(ui.detailsModal());
      return true;
    }

    await interaction.reply({ content: "detailsModal이 없습니다(ui.js 버전 확인).", ephemeral: true });
    return true;
  }

  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:draft:details") {
    const d = DRAFT.get(interaction.user.id);
    if (!d?.kind) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 생성해주세요.", ephemeral: true });
      return true;
    }

    d.title = safeTrim(interaction.fields.getTextInputValue("title"));
    d.note = safeTrim(interaction.fields.getTextInputValue("note"));
    DRAFT.set(interaction.user.id, d);

    if (typeof ui.timeModeRow === "function") {
      await interaction.reply({
        content: "시작 방식을 선택하세요.",
        components: [ui.timeModeRow()],
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({ content: "timeModeRow가 없습니다(ui.js 버전 확인).", ephemeral: true });
    return true;
  }

  // 모바시
  if (interaction.isButton() && interaction.customId === "party:draft:asap") {
    const d = DRAFT.get(interaction.user.id);
    if (!d?.kind || !d?.title) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 생성해주세요.", ephemeral: true });
      return true;
    }

    const boardChannelId = config.PARTY_BOARD_CHANNEL_ID;
    const board = await interaction.guild.channels.fetch(boardChannelId);

    const msg = await board.send({
      embeds: [new EmbedBuilder().setDescription("파티 생성 중...")],
      components: typeof ui.partyActionRow === "function" ? [ui.partyActionRow()] : [],
    });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: msg.guild.id,
      owner_id: interaction.user.id,
      kind: d.kind,
      title: d.title,
      party_note: d.note || "",
      mode: "ASAP",
      start_at: nowUnix(),
      status: "RECRUIT",
      max_players: 5, // 현재 화면이 5 슬롯이므로 임시 고정
    });

    await setMemberNote(msg.id, interaction.user.id, "");
    const party = await getParty(msg.id);
    await refreshPartyMessage(client, party);

    DRAFT.delete(interaction.user.id);
    await interaction.reply({ content: "✅ 파티가 생성되었습니다.", ephemeral: true });
    return true;
  }

  // 시간지정(시/분 선택)
  if (interaction.isButton() && interaction.customId === "party:draft:time") {
    if (typeof ui.hourSelectRow === "function") {
      await interaction.reply({ content: "시(시간)를 선택하세요.", components: [ui.hourSelectRow("party:draft:hh")], ephemeral: true });
      return true;
    }
    await interaction.reply({ content: "hourSelectRow가 없습니다(ui.js 버전 확인).", ephemeral: true });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:hh") {
    const d = DRAFT.get(interaction.user.id) || {};
    d.hh = Number(interaction.values[0]);
    DRAFT.set(interaction.user.id, d);

    if (typeof ui.minuteSelectRow === "function") {
      await interaction.reply({ content: "분(5분 단위)을 선택하세요.", components: [ui.minuteSelectRow("party:draft:mm")], ephemeral: true });
      return true;
    }
    await interaction.reply({ content: "minuteSelectRow가 없습니다(ui.js 버전 확인).", ephemeral: true });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:mm") {
    const d = DRAFT.get(interaction.user.id);
    if (!d?.kind || !d?.title || typeof d.hh !== "number") {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 생성해주세요.", ephemeral: true });
      return true;
    }

    const mm = Number(interaction.values[0]);
    const startAtUnix = kstUnixFromHHMM(d.hh, mm);

    const boardChannelId = config.PARTY_BOARD_CHANNEL_ID;
    const board = await interaction.guild.channels.fetch(boardChannelId);

    const msg = await board.send({
      embeds: [new EmbedBuilder().setDescription("파티 생성 중...")],
      components: typeof ui.partyActionRow === "function" ? [ui.partyActionRow()] : [],
    });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: msg.guild.id,
      owner_id: interaction.user.id,
      kind: d.kind,
      title: d.title,
      party_note: d.note || "",
      mode: "TIME",
      start_at: startAtUnix,
      status: "RECRUIT",
      max_players: 5,
    });

    await setMemberNote(msg.id, interaction.user.id, "");
    const party = await getParty(msg.id);
    await refreshPartyMessage(client, party);

    DRAFT.delete(interaction.user.id);
    await interaction.reply({ content: "✅ 파티가 생성되었습니다.", ephemeral: true });
    return true;
  }

  // =========================
  // C) 구버전 생성 플로우 (createPartyModal 제출)
  // =========================
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:create:modal") {
    // createPartyModal이 어떤 customId로 되어있는지 프로젝트마다 달라서,
    // 최소한 이 블록은 “필요하면” 네 ui.js의 customId에 맞춰 바꿔야 함.
    // 하지만 지금은 신버전 플로우를 우선 사용하도록 유지.
    await interaction.reply({ content: "createPartyModal 경로는 현재 ui.js customId에 맞춰야 합니다. (지금은 신버전 플로우 사용 권장)", ephemeral: true });
    return true;
  }

  // =========================
  // D) 파티 메시지 버튼들 (DB 기반 판별)
  // =========================
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const party = await mustGetParty(interaction);

    // ✅ 여기서 “파티가 아닙니다”가 뜨던 문제 해결: footer가 아니라 DB로 판별
    if (!party) {
      await interaction.reply({ content: "이 메시지는 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    // 참가/비고
    if (interaction.customId === "party:join") {
      if (typeof ui.joinNoteModal === "function") {
        await interaction.showModal(ui.joinNoteModal(party.message_id));
        return true;
      }
      await interaction.reply({ content: "joinNoteModal이 없습니다(ui.js 확인).", ephemeral: true });
      return true;
    }

    // 나가기
    if (interaction.customId === "party:leave") {
      await removeMember(party.message_id, interaction.user.id);

      const after = await getParty(party.message_id);
      const count = after?.members?.length ?? 0;

      // 전원 이탈 → 자동 종료 + 메시지 삭제
      if (count <= 0) {
        await deleteParty(party.message_id);
        await interaction.reply({ content: "모든 참가자가 나가서 파티가 자동 종료되었습니다.", ephemeral: true });
        await interaction.message.delete().catch(() => {});
        return true;
      }

      await refreshPartyMessage(client, after);
      await interaction.reply({ content: "➖ 나가기 처리 완료", ephemeral: true });
      return true;
    }

    // 시간 변경(파티장만)
    if (interaction.customId === "party:time") {
      if (interaction.user.id !== party.owner_id) {
        await interaction.reply({ content: "파티장만 시간 변경이 가능합니다.", ephemeral: true });
        return true;
      }

      // ui에 timeChangeModal이 있으면 그걸 쓰고, 없으면 HH:mm 모달 직접 띄움
      if (typeof ui.timeChangeModal === "function") {
        await interaction.showModal(ui.timeChangeModal(party.message_id));
        return true;
      }

      const modal = new ModalBuilder().setCustomId(`party:timechange:${party.message_id}`).setTitle("시간 변경 (HH:mm)");
      const input = new TextInputBuilder()
        .setCustomId("time")
        .setLabel("시간 (예: 14:05)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    // 시작(참가자면 가능)
    if (interaction.customId === "party:start") {
      const isMember = (party.members || []).some((m) => m.user_id === interaction.user.id);
      if (!isMember && interaction.user.id !== party.owner_id) {
        await interaction.reply({ content: "참가자만 시작할 수 있습니다.", ephemeral: true });
        return true;
      }

      await setPartyStatus(party.message_id, "PLAYING");
      const updated = await getParty(party.message_id);
      await refreshPartyMessage(client, updated);
      await interaction.reply({ content: "🟢 파티를 게임중으로 변경했습니다.", ephemeral: true });
      return true;
    }

// 종료(삭제 권한 없으니 "종료 상태 고정 + 버튼 제거"로 처리)
if (interaction.customId === "party:end") {
  const isMember = (party.members || []).some((m) => m.user_id === interaction.user.id);
  if (!isMember && interaction.user.id !== party.owner_id) {
    await interaction.reply({ content: "참가자만 종료할 수 있습니다.", ephemeral: true });
    return true;
  }

  // DB에서 파티 삭제(= 더 이상 파티로 취급 안 함)
  await deleteParty(party.message_id);

  // 메시지는 삭제 못하니, 파티 메시지를 "종료"로 고정 + 버튼 제거
  const endedEmbed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("⚫ 종료")
    .setDescription(`🎮 ${party.title || "파티"}`)
    .addFields(
      { name: "특이사항", value: party.party_note?.trim() ? party.party_note.trim() : "(없음)", inline: true },
      {
        name: "시간",
        value: party.mode === "ASAP" ? "⚡ 모이면 바로 시작" : `🕒 <t:${Number(party.start_at)}:F>`,
        inline: true,
      },
      { name: "참가자", value: "(종료됨)", inline: false }
    );

  await interaction.message.edit({ embeds: [endedEmbed], components: [] }).catch(() => {});
  await interaction.reply({ content: "⚫ 파티를 종료했습니다. (삭제 권한이 없어 메시지를 종료 상태로 고정합니다)", ephemeral: true });
  return true;
}


      await deleteParty(party.message_id);
      await interaction.reply({ content: "⚫ 파티를 종료하고 메시지를 삭제합니다.", ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return true;
    }

    await interaction.reply({ content: "처리할 수 없는 버튼입니다.", ephemeral: true });
    return true;
  }

  // =========================
  // E) 참가/비고 모달 제출
  // =========================
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    const msgId = interaction.customId.split(":")[2];
    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "이 메시지는 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    const note = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);
    await setMemberNote(msgId, interaction.user.id, note);

    const updated = await getParty(msgId);
    await refreshPartyMessage(client, updated);

    await interaction.reply({ content: "✅ 참가/비고가 반영되었습니다.", ephemeral: true });
    return true;
  }

  // =========================
  // F) 시간 변경 모달 제출(내장 HH:mm 모달)
  // =========================
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:timechange:")) {
    const msgId = interaction.customId.split(":")[2];
    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "이 메시지는 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    if (interaction.user.id !== party.owner_id) {
      await interaction.reply({ content: "파티장만 시간 변경이 가능합니다.", ephemeral: true });
      return true;
    }

    const raw = safeTrim(interaction.fields.getTextInputValue("time"));
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      await interaction.reply({ content: "형식이 잘못되었습니다. 예: 14:05", ephemeral: true });
      return true;
    }

    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      await interaction.reply({ content: "시간 범위가 잘못되었습니다. (00:00 ~ 23:59)", ephemeral: true });
      return true;
    }

    const startAt = kstUnixFromHHMM(hh, mm);
    await updatePartyTime(msgId, startAt);

    const updated = await getParty(msgId);
    await refreshPartyMessage(client, updated);

    await interaction.reply({ content: `✅ 시간이 변경되었습니다: <t:${startAt}:F>`, ephemeral: true });
    return true;
  }

  return false;
}

module.exports = {
  handleParty,
  runPartyTick,
  syncOrderMessage,
};
