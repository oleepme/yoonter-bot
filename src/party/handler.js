// src/party/handler.js
const {
  InteractionType,
  EmbedBuilder,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require("discord.js");

const { PARTY_BOARD_CHANNEL_ID, ROLE_NEWBIE_ID, ROLE_MEMBER_ID } = require("../config");
const { logEmbed, field } = require("../discord/log");
const { safeTrim, nowUnix } = require("../discord/util");

const {
  kindSelectRow,
  detailsModal,
  timeModeRow,
  hourSelectRow,
  minuteSelectRow,
  partyActionRow,
  joinNoteModal,
} = require("./ui");

const { clearTimer } = require("./scheduler");

const {
  upsertParty,
  getParty,
  setMemberNote,
  removeMember,
  deleteParty,
  setPartyStatus,
  updatePartyTime,
} = require("../db");

// 유저별 파티 생성 드래프트(임시)
// userId -> { kind, title, note, mode, hh, mm }
const draft = new Map();

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || ""; // 있으면 운영진 권한으로 인정

function getOwnerRoleLabel(member) {
  if (ROLE_NEWBIE_ID && member.roles.cache.has(ROLE_NEWBIE_ID)) return "뉴비";
  if (ROLE_MEMBER_ID && member.roles.cache.has(ROLE_MEMBER_ID)) return "멤버";
  return "";
}

function isAdmin(member) {
  if (!member) return false;
  if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
  // 서버 관리자 권한도 운영진으로 인정(보험)
  return member.permissions?.has?.(PermissionFlagsBits.Administrator) ?? false;
}

function statusText(status) {
  if (status === "PLAYING") return "🟢 게임중";
  if (status === "ENDED") return "⚫ 종료";
  return "🔴 모집중";
}

function startText(mode, startAtUnix) {
  if (mode === "ASAP") return "⚡ 모이면 바로 시작";
  return `🕒 <t:${startAtUnix}:F> ( <t:${startAtUnix}:R> )`;
}

/**
 * 서버가 UTC여도 “한국 기준(Asia/Seoul)”으로 오늘/내일을 계산해서 unix seconds로 변환
 * - 유저가 선택한 HH:mm이 이미 지난 시간이면 내일로 넘김
 */
function kstUnixFromHHMM(hh, mm) {
  const now = new Date();
  // UTC 기준 ms
  const nowMs = now.getTime();

  // KST는 UTC+9
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kstNow = new Date(nowMs + KST_OFFSET_MS);

  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth(); // 0-based
  const d = kstNow.getUTCDate();

  // "KST의 yyyy-mm-dd hh:mm"을 UTC로 되돌리려면 -9시간
  let targetUtcMs = Date.UTC(y, m, d, hh, mm, 0, 0) - KST_OFFSET_MS;

  // 이미 지난 시간이면 내일
  if (targetUtcMs <= nowMs) {
    targetUtcMs += 24 * 60 * 60 * 1000;
  }

  return Math.floor(targetUtcMs / 1000);
}

function buildPartyEmbedFromDb(party) {
  const {
    title,
    party_note,
    mode,
    start_at,
    status,
    max_players,
    members,
  } = party;

  // 번호 슬롯 고정
  const slots = [];
  const max = Number(max_players || 4);

  for (let i = 0; i < max; i++) {
    const m = members?.[i];
    if (!m) {
      slots.push(`${i + 1}.`);
    } else {
      const note = (m.note || "").trim();
      slots.push(`${i + 1}. <@${m.user_id}>${note ? ` — ${note}` : ""}`);
    }
  }

  return new EmbedBuilder()
    .setColor(status === "PLAYING" ? 0x2ecc71 : status === "ENDED" ? 0x95a5a6 : 0xe74c3c)
    // 상단 1줄: 상태
    .setTitle(statusText(status))
    // 상단 2줄: 🎮 게임 이름
    .setDescription(`🎮 ${title}`)
    // 1행(2칸): 특이사항 / 시간
    .addFields(
      { name: "특이사항", value: (party_note && party_note.trim()) ? party_note.trim() : "(없음)", inline: true },
      { name: "시간", value: startText(mode, Number(start_at)), inline: true },
      // 2행(1칸): 참가자
      { name: "참가자", value: slots.join("\n"), inline: false },
    );
}

/**
 * “이 메시지가 파티인가?” 판별은 footer가 아니라 DB로 한다.
 */
async function mustGetPartyOrReply(interaction) {
  const msg = interaction.message;
  const party = await getParty(msg.id);
  if (!party) {
    await interaction.reply({ content: "이 메시지는 파티가 아닙니다.", ephemeral: true });
    return null;
  }
  return party;
}

async function refreshPartyMessage(guild, messageId) {
  // DB 기준으로 다시 불러와서 메시지 edit
  const party = await getParty(messageId);
  if (!party) return false;

  const channel = await guild.channels.fetch(party.channel_id).catch(() => null);
  if (!channel) return false;

  const msg = await channel.messages.fetch(party.message_id).catch(() => null);
  if (!msg) return false;

  const embed = buildPartyEmbedFromDb(party);
  await msg.edit({ embeds: [embed], components: [partyActionRow()] });
  return true;
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // 1) 게시판에서 "새 파티 만들기"
  if (interaction.isButton() && interaction.customId === "party:create") {
    draft.set(interaction.user.id, {});
    await interaction.reply({
      content: "카테고리 1을 선택하세요.",
      components: [kindSelectRow()],
      ephemeral: true,
    });

    await logEmbed(guild, {
      title: "📌 파티 생성 시작",
      fields: [field("유저", `<@${interaction.user.id}>`)],
    });

    return true;
  }

  // 2) 카테고리1 선택
  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:kind") {
    const d = draft.get(interaction.user.id) ?? {};
    d.kind = interaction.values[0];
    draft.set(interaction.user.id, d);

    await interaction.showModal(detailsModal());
    return true;
  }

  // 3) 카테고리2/3 입력 (모달)
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:draft:details") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 [새 파티 만들기]를 눌러주세요.", ephemeral: true });
      return true;
    }

    d.title = safeTrim(interaction.fields.getTextInputValue("title"));
    d.note = safeTrim(interaction.fields.getTextInputValue("note"));
    draft.set(interaction.user.id, d);

    await interaction.reply({
      content: "시작 방식을 선택하세요.",
      components: [timeModeRow()],
      ephemeral: true,
    });

    return true;
  }

  // 4) 모이면 바로 시작
  if (interaction.isButton() && interaction.customId === "party:draft:asap") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true });
      return true;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const ownerMember = await guild.members.fetch(interaction.user.id);
    const roleLabel = getOwnerRoleLabel(ownerMember);

    // 먼저 메시지 생성
    const tempEmbed = new EmbedBuilder().setDescription("파티 생성 중...");
    const msg = await board.send({ embeds: [tempEmbed], components: [partyActionRow()] });

    // DB에 파티 저장 (messageId 매핑이 핵심)
    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: d.kind,
      title: d.title,
      party_note: d.note || "",
      mode: "ASAP",
      start_at: nowUnix(),
      status: "RECRUIT",
      max_players: 5, // 지금은 5 고정 (다음 단계에서 입력받도록 확장)
    });

    // 파티장 자동 참가(1번 슬롯)
    await setMemberNote(msg.id, interaction.user.id, "");

    // 메시지 임베드 최종 갱신
    await refreshPartyMessage(guild, msg.id);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("역할표기", roleLabel || "(없음)", true),
        field("종류", d.kind, true),
        field("제목", d.title),
        field("모드", "ASAP", true),
      ],
    });

    draft.delete(interaction.user.id);
    return true;
  }

  // 4-2) 시간 지정 시작 (시 선택)
  if (interaction.isButton() && interaction.customId === "party:draft:time") {
    await interaction.reply({
      content: "시(시간)를 선택하세요.",
      components: [hourSelectRow("party:draft:hh")],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:hh") {
    const d = draft.get(interaction.user.id) ?? {};
    d.hh = Number(interaction.values[0]);
    draft.set(interaction.user.id, d);

    await interaction.reply({
      content: "분(5분 단위)을 선택하세요.",
      components: [minuteSelectRow("party:draft:mm")],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:mm") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title || typeof d.hh !== "number") {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true });
      return true;
    }

    const mm = Number(interaction.values[0]);
    const startAtUnix = kstUnixFromHHMM(d.hh, mm);

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const ownerMember = await guild.members.fetch(interaction.user.id);
    const roleLabel = getOwnerRoleLabel(ownerMember);

    const tempEmbed = new EmbedBuilder().setDescription("파티 생성 중...");
    const msg = await board.send({ embeds: [tempEmbed], components: [partyActionRow()] });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
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

    await refreshPartyMessage(guild, msg.id);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성(시간지정)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("역할표기", roleLabel || "(없음)", true),
        field("종류", d.kind, true),
        field("제목", d.title),
        field("시작", `<t:${startAtUnix}:F>`),
      ],
    });

    draft.delete(interaction.user.id);
    return true;
  }

  // ==========================
  // 5) 파티 메시지 버튼들 (DB 기반 판별)
  // ==========================
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const party = await mustGetPartyOrReply(interaction);
    if (!party) return true;

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const admin = isAdmin(member);

    const isOwner = interaction.user.id === party.owner_id;

    // 참가/비고
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(interaction.message.id));
      return true;
    }

    // 나가기
    if (interaction.customId === "party:leave") {
      await removeMember(party.message_id, interaction.user.id);

      // 멤버 0명이면 자동 종료(메시지도 삭제)
      const after = await getParty(party.message_id);
      const count = after?.members?.length ?? 0;

      if (count <= 0) {
        clearTimer(party.message_id);
        await deleteParty(party.message_id);

        await interaction.reply({ content: "모든 참가자가 나가서 파티가 자동 종료되었습니다.", ephemeral: true });
        await interaction.message.delete().catch(() => {});

        await logEmbed(guild, {
          title: "⚫ 파티 자동 종료(전원 이탈)",
          color: 0x95a5a6,
          fields: [
            field("파티 메시지 ID", party.message_id, true),
            field("마지막 이탈", `<@${interaction.user.id}>`, true),
          ],
        });

        return true;
      }

      await refreshPartyMessage(guild, party.message_id);
      await interaction.reply({ content: "➖ 나가기 처리 완료", ephemeral: true });

      await logEmbed(guild, {
        title: "➖ 파티 나가기",
        fields: [
          field("파티 메시지 ID", party.message_id, true),
          field("유저", `<@${interaction.user.id}>`, true),
        ],
      });

      return true;
    }

    // 시간 변경 (파티장 or 운영진)
    if (interaction.customId === "party:time") {
      if (!isOwner && !admin) {
        await interaction.reply({ content: "파티장(또는 운영진)만 시간 변경이 가능합니다.", ephemeral: true });
        return true;
      }

      // HH:mm 모달
      const modal = new ModalBuilder()
        .setCustomId(`party:timechange:${party.message_id}`)
        .setTitle("시간 변경 (HH:mm)");

      const input = new TextInputBuilder()
        .setCustomId("time")
        .setLabel("시간 (예: 14:05)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    // 시작 (파티원도 가능 / 운영진도 가능)
    if (interaction.customId === "party:start") {
      const isMember = (party.members || []).some(m => m.user_id === interaction.user.id);

      if (!isMember && !admin && !isOwner) {
        await interaction.reply({ content: "참가자(또는 운영진)만 시작할 수 있습니다.", ephemeral: true });
        return true;
      }

      clearTimer(party.message_id);
      await setPartyStatus(party.message_id, "PLAYING");
      await refreshPartyMessage(guild, party.message_id);

      await interaction.reply({ content: "🟢 파티를 게임중으로 변경했습니다.", ephemeral: true });

      await logEmbed(guild, {
        title: "🟢 파티 시작",
        color: 0x2ecc71,
        fields: [
          field("파티 메시지 ID", party.message_id, true),
          field("시작자", `<@${interaction.user.id}>`, true),
        ],
      });

      return true;
    }

    // 종료 (참가자도 가능 / 운영진도 가능)
    if (interaction.customId === "party:end") {
      const isMember = (party.members || []).some(m => m.user_id === interaction.user.id);

      if (!isMember && !admin && !isOwner) {
        await interaction.reply({ content: "참가자(또는 운영진)만 종료할 수 있습니다.", ephemeral: true });
        return true;
      }

      clearTimer(party.message_id);
      await deleteParty(party.message_id);

      await interaction.reply({ content: "⚫ 파티를 종료하고 메시지를 삭제합니다.", ephemeral: true });
      await interaction.message.delete().catch(() => {});

      await logEmbed(guild, {
        title: "⚫ 파티 종료",
        color: 0x95a5a6,
        fields: [
          field("파티 메시지 ID", party.message_id, true),
          field("종료자", `<@${interaction.user.id}>`, true),
        ],
      });

      return true;
    }

    // 예외
    await interaction.reply({ content: "처리할 수 없는 버튼입니다.", ephemeral: true });
    return true;
  }

  // ==========================
  // 6) 참가 비고 모달 제출
  // ==========================
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    const msgId = interaction.customId.split(":")[2];

    // 파티 존재 여부(DB 기준)
    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "이 메시지는 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    const inputNote = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    // 참가 + 비고 저장
    await setMemberNote(msgId, interaction.user.id, inputNote);

    // 메시지 갱신
    await refreshPartyMessage(guild, msgId);

    await interaction.reply({ content: "✅ 참가/비고가 반영되었습니다.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 참가/비고",
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("비고", inputNote || "(없음)"),
      ],
    });

    return true;
  }

  // ==========================
  // 7) 시간 변경 모달 제출
  // ==========================
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:timechange:")) {
    const msgId = interaction.customId.split(":")[2];

    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "이 메시지는 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    const admin = isAdmin(member);
    const isOwner = interaction.user.id === party.owner_id;

    if (!isOwner && !admin) {
      await interaction.reply({ content: "파티장(또는 운영진)만 시간 변경이 가능합니다.", ephemeral: true });
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

    const startAtUnix = kstUnixFromHHMM(hh, mm);

    clearTimer(msgId);
    await updatePartyTime(msgId, startAtUnix);

    await refreshPartyMessage(guild, msgId);

    await interaction.reply({ content: `✅ 시간이 변경되었습니다: <t:${startAtUnix}:F>`, ephemeral: true });

    await logEmbed(guild, {
      title: "🕒 파티 시간 변경",
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("변경자", `<@${interaction.user.id}>`, true),
        field("새 시간", `<t:${startAtUnix}:F>`),
      ],
    });

    return true;
  }

  return false;
}

module.exports = { handleParty };
