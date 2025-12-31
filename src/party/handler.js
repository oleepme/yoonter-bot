// src/party/handler.js
const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID } = require("../config");
const { logEmbed, field } = require("../discord/log");
const { safeTrim, nowUnix } = require("../discord/util");
const { createPartyModal, editPartyModal, partyActionRow, joinNoteModal } = require("./ui");
const { upsertParty, getParty, setMemberNote, removeMember, deleteParty } = require("../db");

function isAdmin(interaction) {
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  if (!ADMIN_ROLE_ID) return false;
  const m = interaction.member;
  return !!(m?.roles?.cache?.has?.(ADMIN_ROLE_ID));
}

function statusText(status) {
  if (status === "PLAYING") return "플레이중";
  if (status === "ENDED") return "종료";
  return "모집중";
}

function formatTime(mode, startAtUnix) {
  if (mode === "ASAP") return "⚡ 모이면 바로 시작";
  return `🕒 <t:${startAtUnix}:t> ( <t:${startAtUnix}:R> )`;
}

function buildParticipantsLines(maxPlayers, membersRows) {
  const slots = [];
  const m = Array.isArray(membersRows) ? membersRows : [];

  for (let i = 0; i < maxPlayers; i++) {
    const mm = m[i];
    if (!mm) {
      slots.push(`${i + 1}.`);
      continue;
    }
    const note = (mm.note ?? "").toString().trim();
    slots.push(`${i + 1}. <@${mm.user_id}>${note ? ` — ${note}` : ""}`);
  }
  return slots.join("\n");
}

/**
 * 임베드 레이아웃 (요구 반영)
 * - 특이사항 / 시간: inline:false로 “다른 줄”
 */
function buildPartyEmbedFromDb(partyRow, membersRows) {
  const statusLine = `상태: ${statusText(partyRow.status)}`;
  const gameLine = `🎮 ${partyRow.title}`;

  const partyNote = (partyRow.party_note ?? "").toString().trim() || "(없음)";
  const timeLine = formatTime(partyRow.mode, Number(partyRow.start_at));

  const maxPlayers = Number(partyRow.max_players) || 4;
  const participants = buildParticipantsLines(maxPlayers, membersRows);

  return {
    color:
      partyRow.status === "PLAYING" ? 0x2ecc71 : partyRow.status === "ENDED" ? 0x95a5a6 : 0xe74c3c,
    title: `${statusLine}\n${gameLine}`,
    fields: [
      { name: "주문서 특이사항", value: partyNote, inline: false },
      { name: "시간", value: timeLine, inline: false },
      { name: "참가자 목록", value: participants, inline: false },
    ],
  };
}

async function refreshMessageFromDb(guild, channelId, messageId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) return null;

  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg) return null;

  const party = await getParty(messageId);
  if (!party) return null;

  const embed = buildPartyEmbedFromDb(party, party.members);
  const components = party.status === "ENDED" ? [] : [partyActionRow()];

  await msg.edit({ embeds: [embed], components }).catch(() => {});
  return { msg, party };
}

function parseMode(modeRaw) {
  const m = (modeRaw ?? "").toString().trim().toUpperCase();
  if (m === "ASAP") return "ASAP";
  if (m === "TIME") return "TIME";
  return null;
}

function parseHHMM(timeRaw) {
  const t = (timeRaw ?? "").toString().trim();
  if (!t) return null;
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return { ok: false, reason: "HH:mm 형식이 아닙니다. 예: 21:30" };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return { ok: false, reason: "시간 범위가 올바르지 않습니다. (00:00~23:59)" };
  return { ok: true, hh, mm };
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // 1) 게시판 “새 파티 만들기” → 모달 1번
  if (interaction.isButton() && interaction.customId === "party:create") {
    await interaction.showModal(createPartyModal());
    return true;
  }

  // 2) 파티 생성 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:create:submit") {
    const game = safeTrim(interaction.fields.getTextInputValue("game"));
    const note = safeTrim(interaction.fields.getTextInputValue("note"));
    const modeRaw = safeTrim(interaction.fields.getTextInputValue("mode"));
    const timeRaw = safeTrim(interaction.fields.getTextInputValue("time"));
    const maxRaw = safeTrim(interaction.fields.getTextInputValue("max"));

    const mode = parseMode(modeRaw);
    if (!mode) {
      await interaction.reply({ content: "시작 방식은 ASAP 또는 TIME만 가능합니다.", ephemeral: true });
      return true;
    }

    const max = Number(maxRaw);
    if (!Number.isInteger(max) || max < 2 || max > 20) {
      await interaction.reply({ content: "최대 인원은 2~20 사이 숫자로 입력하세요.", ephemeral: true });
      return true;
    }

    let startAtUnix = nowUnix();
    if (mode === "TIME") {
      const parsed = parseHHMM(timeRaw);
      if (!parsed || parsed.ok === false) {
        await interaction.reply({ content: `TIME 모드일 때 시작시간 오류: ${parsed?.reason ?? "HH:mm 형식 필요"}`, ephemeral: true });
        return true;
      }
      const dt = new Date();
      dt.setSeconds(0, 0);
      dt.setHours(parsed.hh, parsed.mm, 0, 0);
      startAtUnix = Math.floor(dt.getTime() / 1000);
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.reply({ content: "게시판 채널을 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    // 메시지 먼저 생성(메시지ID를 DB 키로 사용)
    const msg = await board.send({ content: "주문서 생성 중..." });

    // DB 저장
    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: "게임",
      title: game,
      party_note: note,
      mode,
      start_at: startAtUnix,
      status: "RECRUIT",
      max_players: max,
    });

    // 파티장 자동 참가
    await setMemberNote(msg.id, interaction.user.id, "");

    // 임베드 반영
    await refreshMessageFromDb(guild, msg.channel.id, msg.id);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("파티장", `<@${interaction.user.id}>`, true),
        field("게임", game),
        field("모드", mode, true),
        field("최대인원", String(max), true),
      ],
    });

    return true;
  }

  // 3) 파티 메시지 버튼 처리
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msgId = interaction.message?.id;
    const chId = interaction.message?.channel?.id;

    if (!msgId || !chId) {
      await interaction.reply({ content: "메시지 정보를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "DB에 등록된 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    if (party.status === "ENDED") {
      await interaction.reply({ content: "이미 종료된 파티입니다.", ephemeral: true });
      return true;
    }

    // 참가/비고
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msgId));
      return true;
    }

    // 나가기
    if (interaction.customId === "party:leave") {
      await removeMember(msgId, interaction.user.id);

      // 전원 이탈 → 자동 종료 고정 + DB 정리
      const after = await getParty(msgId);
      if (!after || (after.members?.length ?? 0) === 0) {
        await upsertParty({ ...party, status: "ENDED" });
        await refreshMessageFromDb(guild, chId, msgId);
        await deleteParty(msgId);

        await interaction.reply({ content: "모든 인원이 나가 파티가 자동 종료되었습니다.", ephemeral: true });
        await logEmbed(guild, {
          title: "⚫ 파티 자동 종료(전원 이탈)",
          color: 0x95a5a6,
          fields: [field("파티 메시지 ID", msgId, true)],
        });
        return true;
      }

      await refreshMessageFromDb(guild, chId, msgId);
      await interaction.reply({ content: "➖ 나가기 완료", ephemeral: true });
      await logEmbed(guild, {
        title: "➖ 파티 나가기",
        fields: [field("파티 메시지 ID", msgId, true), field("유저", `<@${interaction.user.id}>`, true)],
      });
      return true;
    }

    // 수정(파티장/운영진만)
    if (interaction.customId === "party:edit") {
      const ok = (interaction.user.id === party.owner_id) || isAdmin(interaction);
      if (!ok) {
        await interaction.reply({ content: "파티장 또는 운영진만 주문서를 수정할 수 있습니다.", ephemeral: true });
        await logEmbed(guild, {
          title: "🟠 주문서 수정 시도(거부)",
          color: 0xe67e22,
          fields: [
            field("파티 메시지 ID", msgId, true),
            field("시도자", `<@${interaction.user.id}>`, true),
            field("파티장", `<@${party.owner_id}>`, true),
          ],
        });
        return true;
      }

      await interaction.showModal(editPartyModal(msgId, party));
      return true;
    }

    // 시작
    if (interaction.customId === "party:start") {
      await upsertParty({ ...party, status: "PLAYING" });
      await refreshMessageFromDb(guild, chId, msgId);
      await interaction.reply({ content: "🟢 플레이중으로 변경했습니다.", ephemeral: true });
      await logEmbed(guild, {
        title: "🟢 파티 시작",
        color: 0x2ecc71,
        fields: [field("파티 메시지 ID", msgId, true), field("처리자", `<@${interaction.user.id}>`, true)],
      });
      return true;
    }

    // 종료(삭제가 아니라 종료 고정)
    if (interaction.customId === "party:end") {
      // 정책: 파티원도 종료 가능이지만, 최소한 파티 멤버/파티장/운영진이어야 함
      const memberIds = (party.members ?? []).map(m => m.user_id);
      const isMember = memberIds.includes(interaction.user.id);
      const ok = isMember || (interaction.user.id === party.owner_id) || isAdmin(interaction);

      if (!ok) {
        await interaction.reply({ content: "파티원/파티장/운영진만 종료할 수 있습니다.", ephemeral: true });
        return true;
      }

      await upsertParty({ ...party, status: "ENDED" });
      await refreshMessageFromDb(guild, chId, msgId);

      // DB 정리(원하면 ENDED 보존 정책으로 변경 가능)
      await deleteParty(msgId);

      await interaction.reply({ content: "⚫ 파티를 종료했습니다. (메시지는 남고 버튼은 제거됩니다)", ephemeral: true });
      await logEmbed(guild, {
        title: "⚫ 파티 종료",
        color: 0x95a5a6,
        fields: [field("파티 메시지 ID", msgId, true), field("종료자", `<@${interaction.user.id}>`, true)],
      });
      return true;
    }

    await interaction.reply({ content: "처리할 수 없는 버튼입니다.", ephemeral: true });
    return true;
  }

  // 4) 참가 비고 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    const msgId = interaction.customId.split(":")[2];
    const party = await getParty(msgId);

    if (!party) {
      await interaction.reply({ content: "DB에서 파티를 찾지 못했습니다.", ephemeral: true });
      return true;
    }
    if (party.status === "ENDED") {
      await interaction.reply({ content: "이미 종료된 파티입니다.", ephemeral: true });
      return true;
    }

    const inputNote = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    // 정원 체크
    const maxPlayers = Number(party.max_players) || 4;
    const exists = (party.members ?? []).some(m => m.user_id === interaction.user.id);
    const memberCount = party.members?.length ?? 0;

    if (!exists && memberCount >= maxPlayers) {
      await interaction.reply({ content: `이미 정원이 찼습니다. (최대 ${maxPlayers}명)`, ephemeral: true });
      return true;
    }

    await setMemberNote(msgId, interaction.user.id, inputNote);
    await refreshMessageFromDb(guild, party.channel_id, msgId);

    await interaction.reply({ content: "➕ 참가/비고 반영 완료", ephemeral: true });
    await logEmbed(guild, {
      title: "➕ 파티 참가/비고",
      fields: [field("파티 메시지 ID", msgId, true), field("유저", `<@${interaction.user.id}>`, true), field("비고", inputNote || "(없음)")],
    });
    return true;
  }

  // 5) 주문서 수정 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:edit:submit:")) {
    const msgId = interaction.customId.split(":")[3];
    const party = await getParty(msgId);

    if (!party) {
      await interaction.reply({ content: "DB에서 파티를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const ok = (interaction.user.id === party.owner_id) || isAdmin(interaction);
    if (!ok) {
      await interaction.reply({ content: "파티장 또는 운영진만 주문서를 수정할 수 있습니다.", ephemeral: true });
      return true;
    }

    const note = safeTrim(interaction.fields.getTextInputValue("note"));
    const modeRaw = safeTrim(interaction.fields.getTextInputValue("mode"));
    const timeRaw = safeTrim(interaction.fields.getTextInputValue("time"));

    const mode = parseMode(modeRaw);
    if (!mode) {
      await interaction.reply({ content: "시작 방식은 ASAP 또는 TIME만 가능합니다.", ephemeral: true });
      return true;
    }

    let startAtUnix = Number(party.start_at) || nowUnix();
    if (mode === "TIME") {
      const parsed = parseHHMM(timeRaw);
      if (!parsed || parsed.ok === false) {
        await interaction.reply({ content: `TIME 모드일 때 시작시간 오류: ${parsed?.reason ?? "HH:mm 형식 필요"}`, ephemeral: true });
        return true;
      }
      const dt = new Date();
      dt.setSeconds(0, 0);
      dt.setHours(parsed.hh, parsed.mm, 0, 0);
      startAtUnix = Math.floor(dt.getTime() / 1000);
    } else {
      // ASAP이면 시작시간을 “현재”로 리셋(원하면 유지로 바꿀 수 있음)
      startAtUnix = nowUnix();
    }

    await upsertParty({
      ...party,
      party_note: note,
      mode,
      start_at: startAtUnix,
    });

    await refreshMessageFromDb(guild, party.channel_id, msgId);

    await interaction.reply({ content: "✅ 파티 수정이 반영되었습니다.", ephemeral: true });
    await logEmbed(guild, {
      title: "✏️ 파티 수정",
      color: 0x3498db,
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("수정자", `<@${interaction.user.id}>`, true),
        field("모드", mode, true),
        field("시간", mode === "TIME" ? `<t:${startAtUnix}:t>` : "ASAP", true),
        field("특이사항", note || "(없음)"),
      ],
    });

    return true;
  }

  return false;
}

module.exports = { handleParty };
