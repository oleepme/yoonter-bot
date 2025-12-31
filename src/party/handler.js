// src/party/handler.js
const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID } = require("../config");
const { logEmbed, field } = require("../discord/log");
const { safeTrim } = require("../discord/util");
const {
  kindSelectRow,
  cancelRow,
  createPartyModal,
  editPartyModal,
  partyActionRow,
  endedActionRow, // ✅ 종료 후 삭제 버튼 row (ui.js에 있어야 함)
  joinNoteModal,
  kindLabel,
  kindIcon,
} = require("./ui");

const { upsertParty, getParty, setMemberNote, removeMember, deleteParty } = require("../db");

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

function timeDisplay(timeTextRaw) {
  const t = (timeTextRaw ?? "").toString().trim();
  if (!t) return "⚡ 모바시";
  if (t === "모바시") return "⚡ 모바시";
  return t;
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

  const kLabel = kindLabel(partyRow.kind);
  const icon = kindIcon(partyRow.kind);

  // 수다/노래는 title이 비어있을 수 있음
  const titleText = (partyRow.title ?? "").toString().trim();
  const secondLine = titleText ? `${icon} ${kLabel} — ${titleText}` : `${icon} ${kLabel}`;

  return {
    color: partyRow.status === "PLAYING" ? 0x2ecc71 : partyRow.status === "ENDED" ? 0x95a5a6 : 0xe74c3c,
    title: `${statusLabel(partyRow.status)}\n${secondLine}`,
    fields: [
      { name: "특이사항", value: note, inline: false },
      { name: "시간", value: timeDisplay(partyRow.time_text), inline: false },
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

  // ✅ 종료면 버튼을 없애지 말고 "삭제 버튼"만 남김
  const components = partyRow.status === "ENDED" ? [endedActionRow()] : [partyActionRow()];

  await msg.edit({ embeds: [embed], components }).catch(() => {});
}

function parseMaxPlayers(maxRaw) {
  const n = Number(maxRaw);
  if (!Number.isInteger(n) || n < 2 || n > 20) return null;
  return n;
}

/**
 * 종료 처리 정책:
 * 1) 종료 시 메시지 delete()를 "시도"
 * 2) 성공하면: DB도 deleteParty로 정리
 * 3) 실패하면(권한 부족 등): 메시지는 종료 상태로 고정 + 🗑 삭제 버튼만 남김
 *    -> 이 경우 DB는 ENDED 상태로 남겨야 delete 버튼이 동작함
 */
async function endParty(guild, partyRow, reason, message) {
  // 종료 상태로 업데이트 (DB 기준 유지)
  await upsertParty({ ...partyRow, status: "ENDED", mode: "TEXT", start_at: 0 });

  // 메시지 삭제 시도
  if (message) {
    try {
      await message.delete();
      // 삭제 성공: DB까지 완전 정리
      await deleteParty(partyRow.message_id);

      await logEmbed(guild, {
        title: "⚫ 파티 종료(메시지 삭제)",
        color: 0x95a5a6,
        fields: [field("파티 메시지 ID", partyRow.message_id, true), field("사유", reason)],
      });
      return;
    } catch (e) {
      // 삭제 실패 → 아래에서 종료 고정 + 삭제 버튼 제공
    }
  }

  const ended = await getParty(partyRow.message_id);
  if (ended) await refreshPartyMessage(guild, ended);

  await logEmbed(guild, {
    title: "⚫ 파티 종료(메시지 유지)",
    color: 0x95a5a6,
    fields: [
      field("파티 메시지 ID", partyRow.message_id, true),
      field("사유", reason),
      field("처리", "메시지 삭제 실패(권한 부족 가능) → 종료 고정 + 🗑 삭제 버튼 제공"),
    ],
  });
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  /**
   * 1) 생성 버튼 → 종류 선택 드롭다운(에페메랄)
   */
  if (interaction.isButton() && interaction.customId === "party:create") {
    await interaction.reply({
      content: "파티 종류를 선택하세요.",
      components: [kindSelectRow("party:create:kind"), cancelRow("party:create:cancel")],
      ephemeral: true,
    });
    return true;
  }

  // 생성 취소
  if (interaction.isButton() && interaction.customId === "party:create:cancel") {
    await interaction.update({ content: "취소되었습니다.", components: [] }).catch(() => {});
    return true;
  }

  // 생성: 종류 선택 → 모달
  if (interaction.isStringSelectMenu() && interaction.customId === "party:create:kind") {
    const kind = interaction.values[0]; // GAME/MOVIE/CHAT/MUSIC
    await interaction.showModal(createPartyModal(kind));
    return true;
  }

  /**
   * 2) 생성 모달 제출 → 파티 생성
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:create:submit:")) {
    const kind = interaction.customId.split(":")[3];
    const note = safeTrim(interaction.fields.getTextInputValue("note"));
    const time = safeTrim(interaction.fields.getTextInputValue("time")) || "모바시";
    const max = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));

    let title = "";
    if (kind === "GAME" || kind === "MOVIE") {
      title = safeTrim(interaction.fields.getTextInputValue("title"));
      if (!title) {
        await interaction.reply({ content: "이름은 필수입니다.", ephemeral: true });
        return true;
      }
    }

    if (!max) {
      await interaction.reply({ content: "인원제한은 2~20 사이 숫자여야 합니다.", ephemeral: true });
      return true;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.reply({ content: "게시판 채널을 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    // NOTE: 지금은 '파티 생성 중...' 메시지로 먼저 만들고 edit하는 구조(추후 1메시지 UX로 개선 가능)
    const msg = await board.send({ content: "파티 생성 중..." });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind,
      title, // CHAT/MUSIC는 '' 가능
      party_note: note,
      time_text: time,
      mode: "TEXT",
      start_at: 0,
      status: "RECRUIT",
      max_players: max,
    });

    // 파티장 자동 참가
    await setMemberNote(msg.id, interaction.user.id, "");

    const party = await getParty(msg.id);
    if (party) await refreshPartyMessage(guild, party);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("파티장", `<@${interaction.user.id}>`, true),
        field("종류", kindLabel(kind), true),
        field("이름", title || "(없음)", true),
        field("시간", timeDisplay(time), true),
        field("인원", String(max), true),
      ],
    });

    return true;
  }

  /**
   * 3) 파티 메시지 버튼 처리
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

    // ✅ 종료된 파티는 "삭제"만 허용
    if (party.status === "ENDED") {
      if (interaction.customId !== "party:delete") {
        await interaction.reply({ content: "이미 종료된 파티입니다.", ephemeral: true });
        return true;
      }
      // 아래 delete 로직으로 계속
    }

    /**
     * 참가/비고
     */
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msgId));
      return true;
    }

    /**
     * 나가기 → 0명이면 자동 종료(+ 삭제 시도)
     */
    if (interaction.customId === "party:leave") {
      await removeMember(msgId, interaction.user.id);

      const after = await getParty(msgId);
      if (!after || (after.members?.length ?? 0) === 0) {
        await interaction.reply({ content: "➖ 나가기 완료 (전원 이탈로 자동 종료)", ephemeral: true });
        await endParty(guild, party, "전원 이탈(자동종료)", interaction.message);
        return true;
      }

      await refreshPartyMessage(guild, after);
      await interaction.reply({ content: "➖ 나가기 완료", ephemeral: true });
      return true;
    }

    /**
     * 수정: ✅ 종류 변경 불가
     * - 드롭다운 단계 제거
     * - 바로 모달 오픈 (현재 kind 기반)
     */
    if (interaction.customId === "party:edit") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await interaction.reply({ content: "파티장 또는 운영진만 수정할 수 있습니다.", ephemeral: true });
        return true;
      }

      await interaction.showModal(editPartyModal(msgId, party.kind, party));
      return true;
    }

    /**
     * 시작
     */
    if (interaction.customId === "party:start") {
      await upsertParty({ ...party, status: "PLAYING", mode: "TEXT", start_at: 0 });
      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);
      await interaction.reply({ content: "🟢 플레이중으로 변경했습니다.", ephemeral: true });
      return true;
    }

    /**
     * 종료: 종료 시 메시지 삭제 시도
     */
    if (interaction.customId === "party:end") {
      await interaction.reply({ content: "⚫ 파티를 종료했습니다.", ephemeral: true });
      await endParty(guild, party, "수동 종료", interaction.message);
      return true;
    }

    /**
     * 삭제 버튼(종료 상태에서 노출)
     * - 파티장/운영진만
     * - delete 성공 시 DB 삭제
     */
    if (interaction.customId === "party:delete") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await interaction.reply({ content: "파티장 또는 운영진만 삭제할 수 있습니다.", ephemeral: true });
        return true;
      }

      try {
        await interaction.message.delete();
        await deleteParty(msgId);
        await interaction.reply({ content: "🗑 삭제 완료", ephemeral: true });
      } catch (e) {
        await interaction.reply({
          content: "메시지 삭제에 실패했습니다. (봇에 '메시지 관리' 권한이 필요할 수 있어요)",
          ephemeral: true,
        });
      }
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
    const exists = (party.members ?? []).some((m) => m.user_id === interaction.user.id);
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
   * 5) 수정 모달 제출 (✅ kind는 고정: customId에 들어오는 kind를 무시하고 party.kind 사용)
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:edit:submit:")) {
    const parts = interaction.customId.split(":");
    const msgId = parts[3];

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

    const kind = party.kind; // ✅ 종류 수정 불가
    const note = safeTrim(interaction.fields.getTextInputValue("note"));
    const time = safeTrim(interaction.fields.getTextInputValue("time")) || "모바시";
    const max = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));

    let title = "";
    if (kind === "GAME" || kind === "MOVIE") {
      title = safeTrim(interaction.fields.getTextInputValue("title"));
      if (!title) {
        await interaction.reply({ content: "이름은 필수입니다.", ephemeral: true });
        return true;
      }
    }

    if (!max) {
      await interaction.reply({ content: "인원제한은 2~20 사이 숫자여야 합니다.", ephemeral: true });
      return true;
    }

    // 인원 감소 안전장치
    const memberCount = party.members?.length ?? 0;
    if (max < memberCount) {
      await interaction.reply({
        content: `현재 참가자가 ${memberCount}명입니다. 인원제한을 ${memberCount} 미만으로 줄일 수 없습니다.`,
        ephemeral: true,
      });
      return true;
    }

    await upsertParty({
      ...party,
      // kind는 그대로
      title,
      party_note: note,
      time_text: time,
      max_players: max,
      mode: "TEXT",
      start_at: 0,
    });

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    await interaction.reply({ content: "✅ 파티 수정이 반영되었습니다.", ephemeral: true });
    return true;
  }

  return false;
}

module.exports = { handleParty };
