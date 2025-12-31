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
  endedActionRow,
  joinNoteModal,
  kindLabel,
  kindIcon,
} = require("./ui");

const { upsertParty, getParty, setMemberNote, removeMember, deleteParty } = require("../db");

const ERROR_EPHEMERAL_MS = 8000;

function isAdmin(interaction) {
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  if (!ADMIN_ROLE_ID) return false;
  return !!interaction.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
}

/**
 * ✅ 영화/수다/노래 = 인원제한 없음
 */
function isUnlimitedKind(kind) {
  return kind === "MOVIE" || kind === "CHAT" || kind === "MUSIC";
}

/**
 * 버튼/셀렉트: 성공 시 메시지 남기지 않기
 */
async function ackUpdate(interaction) {
  await interaction.deferUpdate().catch(() => {});
}

/**
 * 모달 submit: 규칙상 응답이 필요하므로 ephemeral로 defer 후 끝나면 바로 삭제
 */
async function ackModal(interaction) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
}
async function doneModal(interaction) {
  await interaction.deleteReply().catch(() => {});
}

/**
 * 실패 안내는 잠깐만 에페메랄로 보여주고 자동 삭제
 */
async function ephemeralError(interaction, content) {
  try {
    if (interaction.type === InteractionType.ModalSubmit) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
      }
      await interaction.editReply({ content }).catch(() => {});
      setTimeout(() => interaction.deleteReply().catch(() => {}), ERROR_EPHEMERAL_MS);
      return;
    }

    if (interaction.deferred || interaction.replied) {
      const m = await interaction.followUp({ content, ephemeral: true }).catch(() => null);
      if (m?.delete) setTimeout(() => m.delete().catch(() => {}), ERROR_EPHEMERAL_MS);
      return;
    }

    await interaction.reply({ content, ephemeral: true }).catch(() => {});
    setTimeout(() => interaction.deleteReply().catch(() => {}), ERROR_EPHEMERAL_MS);
  } catch {
    // noop
  }
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

function parseMaxPlayers(maxRaw) {
  const n = Number(maxRaw);
  if (!Number.isInteger(n) || n < 2 || n > 20) return null;
  return n;
}

/**
 * ✅ 참가자 목록 렌더링
 * - GAME: 슬롯 고정 (1.,2.,3..)
 * - MOVIE/CHAT/MUSIC: 무제한 리스트 (• @user …)
 */
function buildParticipants(kind, maxPlayers, membersRows) {
  const members = Array.isArray(membersRows) ? membersRows : [];

  if (isUnlimitedKind(kind)) {
    if (members.length === 0) return "(참가자 없음)";
    return members
      .map((m) => `• <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`)
      .join("\n");
  }

  const lines = [];
  for (let i = 0; i < maxPlayers; i++) {
    const m = members[i];
    if (!m) lines.push(`${i + 1}.`);
    else lines.push(`${i + 1}. <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`);
  }
  return lines.join("\n");
}

function buildPartyEmbed(partyRow) {
  const note = (partyRow.party_note ?? "").toString().trim() || "(없음)";
  const kLabel = kindLabel(partyRow.kind);
  const icon = kindIcon(partyRow.kind);

  const titleText = (partyRow.title ?? "").toString().trim();
  const secondLine = titleText ? `${icon} ${kLabel} — ${titleText}` : `${icon} ${kLabel}`;

  // GAME만 슬롯 필요 → maxPlayers 계산
  const maxPlayers = isUnlimitedKind(partyRow.kind)
    ? 0
    : Number(partyRow.max_players) || 4;

  const peopleValue = isUnlimitedKind(partyRow.kind)
    ? "제한 없음"
    : `${maxPlayers}명`;

  return {
    color:
      partyRow.status === "PLAYING"
        ? 0x2ecc71
        : partyRow.status === "ENDED"
          ? 0x95a5a6
          : 0xe74c3c,
    title: `${statusLabel(partyRow.status)}\n${secondLine}`,
    fields: [
      { name: "특이사항", value: note, inline: false },
      { name: "시간", value: timeDisplay(partyRow.time_text), inline: false },
      { name: "인원", value: peopleValue, inline: true },
      {
        name: "참가자 목록",
        value: buildParticipants(partyRow.kind, maxPlayers, partyRow.members),
        inline: false,
      },
    ],
  };
}

async function refreshPartyMessage(guild, partyRow) {
  const ch = await guild.channels.fetch(partyRow.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;

  const msg = await ch.messages.fetch(partyRow.message_id).catch(() => null);
  if (!msg) return;

  const embed = buildPartyEmbed(partyRow);
  const components = partyRow.status === "ENDED" ? [endedActionRow()] : [partyActionRow()];
  await msg.edit({ embeds: [embed], components }).catch(() => {});
}

/**
 * 종료 정책:
 * 1) status ENDED
 * 2) 메시지 delete 시도
 *   - 성공: deleteParty()로 DB도 정리
 *   - 실패: 종료 고정 + 🗑 삭제 버튼
 */
async function endParty(guild, partyRow, reason, message) {
  await upsertParty({ ...partyRow, status: "ENDED", mode: "TEXT", start_at: 0 });

  if (message) {
    try {
      await message.delete();
      await deleteParty(partyRow.message_id);

      await logEmbed(guild, {
        title: "⚫ 파티 종료(메시지 삭제)",
        color: 0x95a5a6,
        fields: [field("파티 메시지 ID", partyRow.message_id, true), field("사유", reason)],
      });
      return;
    } catch {
      // fallthrough
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
      field("처리", "메시지 삭제 실패 → 종료 고정 + 🗑 삭제 버튼 제공"),
    ],
  });
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // 1) 생성 버튼 → 종류 선택(에페메랄)
  if (interaction.isButton() && interaction.customId === "party:create") {
    await interaction
      .reply({
        content: "파티 종류를 선택하세요.",
        components: [kindSelectRow("party:create:kind"), cancelRow("party:create:cancel")],
        ephemeral: true,
      })
      .catch(() => {});
    return true;
  }

  // 생성 취소: 흔적 0
  if (interaction.isButton() && interaction.customId === "party:create:cancel") {
    await ackUpdate(interaction);
    await interaction.deleteReply().catch(() => {});
    return true;
  }

  // 종류 선택 → 모달 + 에페메랄 즉시 삭제
  if (interaction.isStringSelectMenu() && interaction.customId === "party:create:kind") {
    const kind = interaction.values[0];
    await ackUpdate(interaction);
    await interaction.showModal(createPartyModal(kind)).catch(() => {});
    await interaction.deleteReply().catch(() => {});
    return true;
  }

  // 2) 생성 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:create:submit:")) {
    await ackModal(interaction);

    try {
      const kind = interaction.customId.split(":")[3];

      const note = safeTrim(interaction.fields.getTextInputValue("note"));
      const time = safeTrim(interaction.fields.getTextInputValue("time")) || "모바시";

      let title = "";
      if (kind === "GAME" || kind === "MOVIE") {
        title = safeTrim(interaction.fields.getTextInputValue("title"));
        if (!title) {
          await ephemeralError(interaction, "이름은 필수입니다.");
          return true;
        }
      }

      // ✅ GAME만 인원제한 필요, 나머지는 null
      let maxPlayers = null;
      if (!isUnlimitedKind(kind)) {
        const parsed = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));
        if (!parsed) {
          await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
          return true;
        }
        maxPlayers = parsed;
      }

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
      if (!board?.isTextBased()) {
        await ephemeralError(interaction, "게시판 채널을 찾지 못했습니다.");
        return true;
      }

      const msg = await board.send({ content: "파티 생성 중..." });

      await upsertParty({
        message_id: msg.id,
        channel_id: msg.channel.id,
        guild_id: guild.id,
        owner_id: interaction.user.id,
        kind,
        title,
        party_note: note,
        time_text: time,
        mode: "TEXT",
        start_at: 0,
        status: "RECRUIT",
        max_players: maxPlayers, // ✅ 무제한 kind는 null
      });

      // 파티장 자동 참가
      await setMemberNote(msg.id, interaction.user.id, "");

      const party = await getParty(msg.id);
      if (party) await refreshPartyMessage(guild, party);

      await logEmbed(guild, {
        title: "✅ 파티 생성",
        color: 0x2ecc71,
        fields: [
          field("파티 메시지 ID", msg.id, true),
          field("파티장", `<@${interaction.user.id}>`, true),
          field("종류", kindLabel(kind), true),
          field("이름", title || "(없음)", true),
          field("시간", timeDisplay(time), true),
          field("인원", isUnlimitedKind(kind) ? "제한 없음" : String(maxPlayers), true),
        ],
      });

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "파티 생성 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  // 3) 파티 메시지 버튼 처리
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msgId = interaction.message?.id;
    if (!msgId) {
      await ephemeralError(interaction, "메시지 정보를 찾지 못했습니다.");
      return true;
    }

    const party = await getParty(msgId);
    if (!party) {
      await ephemeralError(interaction, "DB에 등록된 파티가 아닙니다.");
      return true;
    }

    if (party.status === "ENDED" && interaction.customId !== "party:delete") {
      await ephemeralError(interaction, "이미 종료된 파티입니다.");
      return true;
    }

    // 참가/비고 모달
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msgId)).catch(() => {});
      return true;
    }

    // 나가기
    if (interaction.customId === "party:leave") {
      await ackUpdate(interaction);

      await removeMember(msgId, interaction.user.id);
      const after = await getParty(msgId);

      if (!after || (after.members?.length ?? 0) === 0) {
        await endParty(guild, party, "전원 이탈(자동종료)", interaction.message);
        return true;
      }

      await refreshPartyMessage(guild, after);
      return true;
    }

    // 수정 (종류 변경 불가)
    if (interaction.customId === "party:edit") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await ephemeralError(interaction, "파티장 또는 운영진만 수정할 수 있습니다.");
        return true;
      }
      await interaction.showModal(editPartyModal(msgId, party.kind, party)).catch(() => {});
      return true;
    }

    // 시작
    if (interaction.customId === "party:start") {
      await ackUpdate(interaction);
      await upsertParty({ ...party, status: "PLAYING", mode: "TEXT", start_at: 0 });
      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);
      return true;
    }

    // 종료
    if (interaction.customId === "party:end") {
      await ackUpdate(interaction);
      await endParty(guild, party, "수동 종료", interaction.message);
      return true;
    }

    // 삭제
    if (interaction.customId === "party:delete") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await ephemeralError(interaction, "파티장 또는 운영진만 삭제할 수 있습니다.");
        return true;
      }

      await ackUpdate(interaction);

      try {
        await interaction.message.delete();
        await deleteParty(msgId);
      } catch {
        await ephemeralError(interaction, "메시지 삭제에 실패했습니다. (봇에 '메시지 관리' 권한이 필요할 수 있어요)");
      }
      return true;
    }

    return false;
  }

  // 4) 참가 비고 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    await ackModal(interaction);

    try {
      const msgId = interaction.customId.split(":")[2];
      const party = await getParty(msgId);

      if (!party) {
        await ephemeralError(interaction, "DB에서 파티를 찾지 못했습니다.");
        return true;
      }
      if (party.status === "ENDED") {
        await ephemeralError(interaction, "이미 종료된 파티입니다.");
        return true;
      }

      const inputNote = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

      // ✅ GAME만 정원 체크
      if (!isUnlimitedKind(party.kind)) {
        const maxPlayers = Number(party.max_players) || 4;
        const exists = (party.members ?? []).some((m) => m.user_id === interaction.user.id);
        const count = party.members?.length ?? 0;
        if (!exists && count >= maxPlayers) {
          await ephemeralError(interaction, `이미 정원이 찼습니다. (최대 ${maxPlayers}명)`);
          return true;
        }
      }

      await setMemberNote(msgId, interaction.user.id, inputNote);
      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "참가/비고 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  // 5) 수정 모달 제출 (종류 고정, GAME만 인원제한)
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:edit:submit:")) {
    await ackModal(interaction);

    try {
      const parts = interaction.customId.split(":");
      const msgId = parts[3];

      const party = await getParty(msgId);
      if (!party) {
        await ephemeralError(interaction, "DB에서 파티를 찾지 못했습니다.");
        return true;
      }

      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await ephemeralError(interaction, "파티장 또는 운영진만 수정할 수 있습니다.");
        return true;
      }

      const kind = party.kind; // 종류 수정 불가
      const note = safeTrim(interaction.fields.getTextInputValue("note"));
      const time = safeTrim(interaction.fields.getTextInputValue("time")) || "모바시";

      let title = "";
      if (kind === "GAME" || kind === "MOVIE") {
        title = safeTrim(interaction.fields.getTextInputValue("title"));
        if (!title) {
          await ephemeralError(interaction, "이름은 필수입니다.");
          return true;
        }
      }

      // ✅ GAME만 인원제한 수정 가능, 나머지는 null 유지
      let maxPlayers = null;
      if (!isUnlimitedKind(kind)) {
        const parsed = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));
        if (!parsed) {
          await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
          return true;
        }

        const memberCount = party.members?.length ?? 0;
        if (parsed < memberCount) {
          await ephemeralError(
            interaction,
            `현재 참가자가 ${memberCount}명입니다. 인원제한을 ${memberCount} 미만으로 줄일 수 없습니다.`
          );
          return true;
        }
        maxPlayers = parsed;
      }

      await upsertParty({
        ...party,
        title,
        party_note: note,
        time_text: time,
        max_players: maxPlayers, // ✅ 무제한 kind는 null
        mode: "TEXT",
        start_at: 0,
      });

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "파티 수정 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  return false;
}

module.exports = { handleParty };
