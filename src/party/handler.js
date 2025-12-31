// src/party/handler.js
const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID } = require("../config");
const { logEmbed, field } = require("../discord/log");
const { safeTrim, nowUnix, seoulUnixFromHHMM } = require("../discord/util");
const {
  createPartyModal,
  editPartyModal,
  hourSelectRow,
  minuteSelectRow,
  timeStepButtons,
  partyActionRow,
  joinNoteModal,
} = require("./ui");
const { upsertParty, getParty, setMemberNote, removeMember, deleteParty } = require("../db");

/**
 * 임시 입력 저장(메모리)
 * - DB 유실과 무관한 “진행 중 입력값”만 저장
 */
const createDraft = new Map(); // userId -> { game, note, max, hh? }
const editDraft = new Map();   // userId -> { msgId, game, note, max, hh? }

function isAdmin(interaction) {
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  if (!ADMIN_ROLE_ID) return false;
  return !!interaction.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
}

function statusLabel(status) {
  if (status === "PLAYING") return "🟢 플레이중";
  if (status === "ENDED") return "⚫ 종료";
  return "🔴 모집중";
}

function timeLabel(mode, startAtUnix) {
  // 모바시: “시간 선택 안 함”
  if (mode === "MOBASHI") return "⚡ 모바시";
  return `🕒 <t:${startAtUnix}:t> ( <t:${startAtUnix}:R> )`;
}

function buildParticipants(maxPlayers, membersRows) {
  const members = Array.isArray(membersRows) ? membersRows : [];
  const lines = [];
  for (let i = 0; i < maxPlayers; i++) {
    const m = members[i];
    if (!m) lines.push(`${i + 1}.`);
    else lines.push(`${i + 1}. <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`);
  }
  return lines.join("\n");
}

function buildPartyEmbed(partyRow) {
  const maxPlayers = Number(partyRow.max_players) || 4;
  const note = (partyRow.party_note ?? "").toString().trim() || "(없음)";

  return {
    color: partyRow.status === "PLAYING" ? 0x2ecc71 : partyRow.status === "ENDED" ? 0x95a5a6 : 0xe74c3c,
    title: `${statusLabel(partyRow.status)}\n🎮 ${partyRow.title}`,
    fields: [
      { name: "파티 특이사항", value: note, inline: false },
      { name: "시간", value: timeLabel(partyRow.mode, Number(partyRow.start_at)), inline: false },
      { name: "참가자 목록", value: buildParticipants(maxPlayers, partyRow.members), inline: false },
    ],
  };
}

async function refreshPartyMessage(guild, partyRow) {
  const ch = await guild.channels.fetch(partyRow.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;

  const msg = await ch.messages.fetch(partyRow.message_id).catch(() => null);
  if (!msg) return;

  const embed = buildPartyEmbed(partyRow);
  const components = partyRow.status === "ENDED" ? [] : [partyActionRow()];
  await msg.edit({ embeds: [embed], components }).catch(() => {});
}

function parseMaxPlayers(maxRaw) {
  const n = Number(maxRaw);
  if (!Number.isInteger(n) || n < 2 || n > 20) return null;
  return n;
}

/**
 * 공통: 종료 처리 (메시지 삭제 X, 버튼 제거 + DB 정리)
 */
async function endParty(guild, partyRow, reason) {
  await upsertParty({ ...partyRow, status: "ENDED" });
  const ended = await getParty(partyRow.message_id);
  if (ended) await refreshPartyMessage(guild, ended);

  // 정책: 종료 후 DB 삭제(원하면 ENDED 보존으로 바꿀 수 있음)
  await deleteParty(partyRow.message_id);

  await logEmbed(guild, {
    title: "⚫ 파티 종료",
    color: 0x95a5a6,
    fields: [
      field("파티 메시지 ID", partyRow.message_id, true),
      field("사유", reason),
    ],
  });
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // 1) 새 파티 만들기 버튼 → 모달
  if (interaction.isButton() && interaction.customId === "party:create") {
    await interaction.showModal(createPartyModal());
    return true;
  }

  // 2) 생성 모달 제출 → 시간 선택 단계(드롭다운)
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:create:submit") {
    const game = safeTrim(interaction.fields.getTextInputValue("game"));
    const note = safeTrim(interaction.fields.getTextInputValue("note"));
    const max = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));

    if (!game) {
      await interaction.reply({ content: "게임 이름은 필수입니다.", ephemeral: true });
      return true;
    }
    if (!max) {
      await interaction.reply({ content: "파티 인원은 2~20 사이 숫자여야 합니다.", ephemeral: true });
      return true;
    }

    createDraft.set(interaction.user.id, { game, note, max });

    await interaction.reply({
      content: "시간을 선택하세요. (미선택시 모바시)",
      components: [
        hourSelectRow("party:create:hh"),
        timeStepButtons({ mobashiId: "party:create:mobashi", cancelId: "party:create:cancel" }),
      ],
      ephemeral: true,
    });
    return true;
  }

  // 2-1) 생성: 시 선택
  if (interaction.isStringSelectMenu() && interaction.customId === "party:create:hh") {
    const d = createDraft.get(interaction.user.id);
    if (!d) {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 생성해주세요.", components: [] }).catch(() => {});
      return true;
    }
    d.hh = Number(interaction.values[0]);
    createDraft.set(interaction.user.id, d);

    await interaction.update({
      content: "분을 선택하세요.",
      components: [
        minuteSelectRow("party:create:mm"),
        timeStepButtons({ mobashiId: "party:create:mobashi", cancelId: "party:create:cancel" }),
      ],
    });
    return true;
  }

  // 2-2) 생성: 분 선택 → 실제 파티 생성
  if (interaction.isStringSelectMenu() && interaction.customId === "party:create:mm") {
    const d = createDraft.get(interaction.user.id);
    if (!d || typeof d.hh !== "number") {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 생성해주세요.", components: [] }).catch(() => {});
      return true;
    }
    const mm = Number(interaction.values[0]);
    const startAtUnix = seoulUnixFromHHMM(d.hh, mm);

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.update({ content: "게시판 채널을 찾지 못했습니다.", components: [] }).catch(() => {});
      return true;
    }

    const msg = await board.send({ content: "파티 생성 중..." });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: "게임",
      title: d.game,
      party_note: d.note,
      mode: "TIME",
      start_at: startAtUnix,
      status: "RECRUIT",
      max_players: d.max,
    });

    await setMemberNote(msg.id, interaction.user.id, "");

    const party = await getParty(msg.id);
    if (party) await refreshPartyMessage(guild, party);

    createDraft.delete(interaction.user.id);

    await interaction.update({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", components: [] });

    await logEmbed(guild, {
      title: "✅ 파티 생성(시간)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("파티장", `<@${interaction.user.id}>`, true),
        field("게임", d.game),
        field("시간", `<t:${startAtUnix}:F>`),
        field("인원", String(d.max), true),
      ],
    });
    return true;
  }

  // 2-3) 생성: 모바시 버튼(시간 선택 안함)
  if (interaction.isButton() && interaction.customId === "party:create:mobashi") {
    const d = createDraft.get(interaction.user.id);
    if (!d) {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 생성해주세요.", components: [] }).catch(() => {});
      return true;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.update({ content: "게시판 채널을 찾지 못했습니다.", components: [] }).catch(() => {});
      return true;
    }

    const msg = await board.send({ content: "파티 생성 중..." });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: "게임",
      title: d.game,
      party_note: d.note,
      mode: "MOBASHI",
      start_at: nowUnix(),
      status: "RECRUIT",
      max_players: d.max,
    });

    await setMemberNote(msg.id, interaction.user.id, "");

    const party = await getParty(msg.id);
    if (party) await refreshPartyMessage(guild, party);

    createDraft.delete(interaction.user.id);

    await interaction.update({ content: "✅ 모바시 파티가 생성되었습니다. 게시판을 확인하세요.", components: [] });

    await logEmbed(guild, {
      title: "✅ 파티 생성(모바시)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("파티장", `<@${interaction.user.id}>`, true),
        field("게임", d.game),
        field("모드", "모바시", true),
        field("인원", String(d.max), true),
      ],
    });
    return true;
  }

  // 2-4) 생성: 취소
  if (interaction.isButton() && interaction.customId === "party:create:cancel") {
    createDraft.delete(interaction.user.id);
    await interaction.update({ content: "취소되었습니다.", components: [] }).catch(() => {});
    return true;
  }

  /**
   * 3) 파티 메시지 버튼들
   */
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msgId = interaction.message?.id;
    if (!msgId) {
      await interaction.reply({ content: "메시지 정보를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "DB에 등록된 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    // 이미 종료면 조작 불가
    if (party.status === "ENDED") {
      await interaction.reply({ content: "이미 종료된 파티입니다.", ephemeral: true });
      return true;
    }

    // 참가/비고
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msgId));
      return true;
    }

    // 나가기 → 0명 되면 자동 종료
    if (interaction.customId === "party:leave") {
      await removeMember(msgId, interaction.user.id);

      const after = await getParty(msgId);
      if (!after || (after.members?.length ?? 0) === 0) {
        await interaction.reply({ content: "➖ 나가기 완료 (전원 이탈로 자동 종료 처리)", ephemeral: true });
        await endParty(guild, party, "전원 이탈(자동종료)");
        return true;
      }

      await refreshPartyMessage(guild, after);
      await interaction.reply({ content: "➖ 나가기 완료", ephemeral: true });
      return true;
    }

    // 수정: 파티장/운영진만, 그리고 모든 항목 수정 가능
    if (interaction.customId === "party:edit") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await interaction.reply({ content: "파티장 또는 운영진만 수정할 수 있습니다.", ephemeral: true });
        return true;
      }
      await interaction.showModal(editPartyModal(msgId, party));
      return true;
    }

    // 시작: 파티원/운영진 허용(요구 정책)
    if (interaction.customId === "party:start") {
      const memberIds = (party.members ?? []).map(m => m.user_id);
      const ok = memberIds.includes(interaction.user.id) || isAdmin(interaction) || interaction.user.id === party.owner_id;
      if (!ok) {
        await interaction.reply({ content: "파티원 또는 운영진만 시작할 수 있습니다.", ephemeral: true });
        return true;
      }

      await upsertParty({ ...party, status: "PLAYING" });
      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      await interaction.reply({ content: "🟢 플레이중으로 변경했습니다.", ephemeral: true });
      return true;
    }

    // 종료: 파티원도 가능(요구) + 운영진 가능
    if (interaction.customId === "party:end") {
      const memberIds = (party.members ?? []).map(m => m.user_id);
      const ok = memberIds.includes(interaction.user.id) || isAdmin(interaction) || interaction.user.id === party.owner_id;
      if (!ok) {
        await interaction.reply({ content: "파티원/파티장/운영진만 종료할 수 있습니다.", ephemeral: true });
        return true;
      }

      await interaction.reply({ content: "⚫ 파티를 종료했습니다.", ephemeral: true });
      await endParty(guild, party, "수동 종료");
      return true;
    }

    return false;
  }

  /**
   * 4) 참가 비고 모달 제출
   */
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
    const count = party.members?.length ?? 0;
    if (!exists && count >= maxPlayers) {
      await interaction.reply({ content: `이미 정원이 찼습니다. (최대 ${maxPlayers}명)`, ephemeral: true });
      return true;
    }

    await setMemberNote(msgId, interaction.user.id, inputNote);

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    await interaction.reply({ content: "✅ 참가/비고가 반영되었습니다.", ephemeral: true });
    return true;
  }

  /**
   * 5) 수정 모달 제출 → 시간 선택 단계(드롭다운)
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:edit:submit:")) {
    const msgId = interaction.customId.split(":")[3];
    const party = await getParty(msgId);

    if (!party) {
      await interaction.reply({ content: "DB에서 파티를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
    if (!ok) {
      await interaction.reply({ content: "파티장 또는 운영진만 수정할 수 있습니다.", ephemeral: true });
      return true;
    }

    const game = safeTrim(interaction.fields.getTextInputValue("game"));
    const note = safeTrim(interaction.fields.getTextInputValue("note"));
    const max = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));

    if (!game) {
      await interaction.reply({ content: "게임 이름은 필수입니다.", ephemeral: true });
      return true;
    }
    if (!max) {
      await interaction.reply({ content: "파티 인원은 2~20 사이 숫자여야 합니다.", ephemeral: true });
      return true;
    }

    // 인원을 줄이려는데 현재 멤버 수가 더 많으면 거부(안전)
    const memberCount = party.members?.length ?? 0;
    if (max < memberCount) {
      await interaction.reply({ content: `현재 참가자가 ${memberCount}명입니다. 인원을 ${memberCount} 미만으로 줄일 수 없습니다.`, ephemeral: true });
      return true;
    }

    editDraft.set(interaction.user.id, { msgId, game, note, max });

    await interaction.reply({
      content: "수정할 시간을 선택하세요. (시간 선택 안 하면 모바시로 변경)",
      components: [
        hourSelectRow("party:edit:hh"),
        timeStepButtons({
          mobashiId: "party:edit:mobashi",
          cancelId: "party:edit:cancel",
          mobashiLabel: "⚡ 모바시로 변경",
        }),
      ],
      ephemeral: true,
    });
    return true;
  }

  // 5-1) 수정: 시 선택
  if (interaction.isStringSelectMenu() && interaction.customId === "party:edit:hh") {
    const d = editDraft.get(interaction.user.id);
    if (!d) {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 수정해주세요.", components: [] }).catch(() => {});
      return true;
    }
    d.hh = Number(interaction.values[0]);
    editDraft.set(interaction.user.id, d);

    await interaction.update({
      content: "분을 선택하세요.",
      components: [
        minuteSelectRow("party:edit:mm"),
        timeStepButtons({
          mobashiId: "party:edit:mobashi",
          cancelId: "party:edit:cancel",
          mobashiLabel: "⚡ 모바시로 변경",
        }),
      ],
    });
    return true;
  }

  // 5-2) 수정: 분 선택 → DB 업데이트
  if (interaction.isStringSelectMenu() && interaction.customId === "party:edit:mm") {
    const d = editDraft.get(interaction.user.id);
    if (!d || typeof d.hh !== "number") {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 수정해주세요.", components: [] }).catch(() => {});
      return true;
    }

    const mm = Number(interaction.values[0]);
    const startAtUnix = seoulUnixFromHHMM(d.hh, mm);

    const party = await getParty(d.msgId);
    if (!party) {
      await interaction.update({ content: "파티를 찾지 못했습니다.", components: [] }).catch(() => {});
      editDraft.delete(interaction.user.id);
      return true;
    }

    await upsertParty({
      ...party,
      title: d.game,
      party_note: d.note,
      max_players: d.max,
      mode: "TIME",
      start_at: startAtUnix,
    });

    const updated = await getParty(d.msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    editDraft.delete(interaction.user.id);

    await interaction.update({ content: "✅ 파티 수정이 반영되었습니다.", components: [] });
    return true;
  }

  // 5-3) 수정: 모바시로 변경
  if (interaction.isButton() && interaction.customId === "party:edit:mobashi") {
    const d = editDraft.get(interaction.user.id);
    if (!d) {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 수정해주세요.", components: [] }).catch(() => {});
      return true;
    }

    const party = await getParty(d.msgId);
    if (!party) {
      await interaction.update({ content: "파티를 찾지 못했습니다.", components: [] }).catch(() => {});
      editDraft.delete(interaction.user.id);
      return true;
    }

    await upsertParty({
      ...party,
      title: d.game,
      party_note: d.note,
      max_players: d.max,
      mode: "MOBASHI",
      start_at: nowUnix(),
    });

    const updated = await getParty(d.msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    editDraft.delete(interaction.user.id);

    await interaction.update({ content: "✅ 모바시로 변경 포함, 파티 수정이 반영되었습니다.", components: [] });
    return true;
  }

  // 5-4) 수정 취소
  if (interaction.isButton() && interaction.customId === "party:edit:cancel") {
    editDraft.delete(interaction.user.id);
    await interaction.update({ content: "취소되었습니다.", components: [] }).catch(() => {});
    return true;
  }

  return false;
}

module.exports = { handleParty };
