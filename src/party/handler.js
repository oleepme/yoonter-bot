// src/party/handler.js
const { InteractionType } = require("discord.js");

const { PARTY_BOARD_CHANNEL_ID } = require("../config");
const { upsertParty, getParty, setMemberNote, removeMember, deleteParty } = require("../db");

// 프로젝트에 이미 존재하는 유틸/로그 모듈 기준(없으면 해당 require만 맞춰서 수정)
const { logEmbed, field } = require("../discord/log");
const { safeTrim } = require("../discord/util");

const {
  createPartyModal,
  editPartyModal,
  joinNoteModal,
  adminForceJoinModal,
  partyActionRows,
  endedActionRow,
  kindLabel,
  kindIcon,
  isUnlimitedKind,
} = require("./ui");

const ERROR_EPHEMERAL_MS = 8000;
const OK_BLANK = "\u200b";

function isAdmin(interaction) {
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  if (!ADMIN_ROLE_ID) return false;
  return !!interaction.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
}

async function ackUpdate(interaction) {
  await interaction.deferUpdate().catch(() => {});
}

/**
 * ModalSubmit 은 showModal 이후 응답이 필요함.
 * - deferReply 후 deleteReply 하면 “삭제됨” 류 흔적이 뜰 수 있어서,
 * - 그냥 빈 에페메랄로 reply만 찍고(OK_BLANK) 이후 editReply로 에러 표시하는 방식.
 */
async function ackModal(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: OK_BLANK, ephemeral: true }).catch(() => {});
  }
}

async function ephemeralError(interaction, content) {
  try {
    if (interaction.type === InteractionType.ModalSubmit) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({ content: OK_BLANK, ephemeral: true }).catch(() => {});
      }
      await interaction.editReply({ content }).catch(() => {});
      setTimeout(() => interaction.editReply({ content: OK_BLANK }).catch(() => {}), ERROR_EPHEMERAL_MS);
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

function parseMaxPlayers(maxRaw) {
  const n = Number(maxRaw);
  if (!Number.isInteger(n) || n < 2 || n > 20) return null;
  return n;
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

function buildParticipants(kind, maxPlayers, membersRows) {
  const members = Array.isArray(membersRows) ? membersRows : [];

  // 무제한 리스트
  if (isUnlimitedKind(kind)) {
    if (members.length === 0) return "(참가자 없음)";
    return members
      .map((m) => `• <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`)
      .join("\n");
  }

  // 슬롯 고정
  const lines = [];
  for (let i = 0; i < maxPlayers; i++) {
    const m = members[i];
    if (!m) lines.push(`${i + 1}.`);
    else lines.push(`${i + 1}. <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * ✅ "인원 5명" 같은 필드는 아예 넣지 않음
 * 정원은 참가자 슬롯(1~N) 자체가 표시
 */
function buildPartyEmbed(partyRow) {
  const note = (partyRow.party_note ?? "").toString().trim() || "(없음)";

  const label = kindLabel(partyRow.kind);
  const icon = kindIcon(partyRow.kind);

  const titleText = (partyRow.title ?? "").toString().trim();
  const secondLine = titleText ? `${icon} ${label} — ${titleText}` : `${icon} ${label}`;

  const maxPlayers = isUnlimitedKind(partyRow.kind) ? 0 : Number(partyRow.max_players) || 4;

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
      {
        name: "참가자 목록",
        value: buildParticipants(partyRow.kind, maxPlayers, partyRow.members),
        inline: false,
      },
    ],
  };
}

function buildCreatingEmbed(kind) {
  const label = kindLabel(kind);
  const icon = kindIcon(kind);
  return {
    color: 0x95a5a6,
    title: `🛠️ 파티 생성 중...\n${icon} ${label}`,
    description: OK_BLANK,
  };
}

async function refreshPartyMessage(guild, partyRow) {
  const ch = await guild.channels.fetch(partyRow.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;

  const msg = await ch.messages.fetch(partyRow.message_id).catch(() => null);
  if (!msg) return;

  const embed = buildPartyEmbed(partyRow);
  const components = partyRow.status === "ENDED" ? [endedActionRow()] : partyActionRows();
  await msg.edit({ embeds: [embed], components }).catch(() => {});
}

async function endParty(guild, partyRow, reason, message) {
  await upsertParty({ ...partyRow, status: "ENDED", mode: "TEXT", start_at: 0 });

  // 종료 시 메시지 삭제 시도 → 성공하면 DB도 삭제
  if (message) {
    try {
      await message.delete();
      await deleteParty(partyRow.message_id);

      if (logEmbed) {
        await logEmbed(guild, {
          title: "⚫ 파티 종료(메시지 삭제)",
          color: 0x95a5a6,
          fields: [field("파티 메시지 ID", partyRow.message_id, true), field("사유", reason)],
        });
      }
      return;
    } catch {
      // fallthrough
    }
  }

  // 삭제 실패면: 종료 고정 + 🗑 삭제 버튼만 남김
  const ended = await getParty(partyRow.message_id);
  if (ended) await refreshPartyMessage(guild, ended);

  if (logEmbed) {
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
}

function parseUserIds(text) {
  const s = (text ?? "").toString();
  const ids = new Set();

  // <@123>, <@!123>
  const mentionRe = /<@!?(\d{15,21})>/g;
  let m;
  while ((m = mentionRe.exec(s))) ids.add(m[1]);

  // raw 숫자 ID
  const rawRe = /\b(\d{15,21})\b/g;
  while ((m = rawRe.exec(s))) ids.add(m[1]);

  return [...ids];
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  /**
   * ✅ 현황판에서 종류별 생성 버튼 클릭 → 바로 모달
   * customId: party:create:GAME|MOVIE|CHAT|MUSIC
   */
  if (interaction.isButton() && interaction.customId.startsWith("party:create:")) {
    const kind = interaction.customId.split(":")[2];
    await interaction.showModal(createPartyModal(kind)).catch(() => {});
    return true;
  }

  /**
   * ✅ 생성 모달 제출
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:create:submit:")) {
    await ackModal(interaction);

    const kind = interaction.customId.split(":")[3];

    try {
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

      // ✅ 무제한 파티는 max_players=0 저장 (DB NOT NULL 대응)
      let maxPlayers = 0;
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

      // embed-only로 "생성 중" 메시지 먼저 만들고, 실패 시 삭제
      const msg = await board.send({ embeds: [buildCreatingEmbed(kind)], components: [] });

      try {
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
          max_players: maxPlayers,
        });

        // 파티장 자동 참가
        await setMemberNote(msg.id, interaction.user.id, "");

        const party = await getParty(msg.id);
        if (party) await refreshPartyMessage(guild, party);

        if (logEmbed) {
          await logEmbed(guild, {
            title: "✅ 파티 생성",
            color: 0x2ecc71,
            fields: [
              field("파티 메시지 ID", msg.id, true),
              field("파티장", `<@${interaction.user.id}>`, true),
              field("종류", kindLabel(kind), true),
              field("이름", title || "(없음)", true),
              field("시간", timeDisplay(time), true),
              field("인원제한", isUnlimitedKind(kind) ? "없음" : String(maxPlayers), true),
            ],
          });
        }

        return true;
      } catch {
        // 실패 시 찌꺼기 메시지 삭제
        await msg.delete().catch(() => {});
        await ephemeralError(interaction, "파티 생성 처리중 오류가 발생했습니다.");
        return true;
      }
    } catch {
      await ephemeralError(interaction, "파티 생성 처리중 오류가 발생했습니다.");
      return true;
    }
  }

  /**
   * ✅ 운영진: 강제참가 모달 제출
   */
  if (
    interaction.type === InteractionType.ModalSubmit &&
    interaction.customId.startsWith("party:admin:forcejoin:")
  ) {
    await ackModal(interaction);

    if (!isAdmin(interaction)) {
      await ephemeralError(interaction, "운영진만 사용할 수 있습니다.");
      return true;
    }

    const msgId = interaction.customId.split(":")[3];
    const party = await getParty(msgId);

    if (!party) {
      await ephemeralError(interaction, "파티를 찾지 못했습니다.");
      return true;
    }
    if (party.status === "ENDED") {
      await ephemeralError(interaction, "이미 종료된 파티입니다.");
      return true;
    }

    const usersRaw = interaction.fields.getTextInputValue("users");
    const modeRaw = (interaction.fields.getTextInputValue("mode") ?? "").trim().toLowerCase();
    const mode = modeRaw === "replace" ? "replace" : "add";

    const userIds = parseUserIds(usersRaw);
    if (userIds.length === 0) {
      await ephemeralError(interaction, "유저 멘션 또는 ID를 입력해 주세요.");
      return true;
    }

    const current = party.members ?? [];
    const unlimited = isUnlimitedKind(party.kind);
    const maxPlayers = unlimited ? 0 : (Number(party.max_players) || 4);

    // 정원 체크 (GAME만)
    if (!unlimited) {
      const existingSet = new Set(current.map((m) => m.user_id));
      const baseCount = mode === "replace" ? 0 : current.length;
      const addCount =
        mode === "replace" ? userIds.length : userIds.filter((id) => !existingSet.has(id)).length;

      if (baseCount + addCount > maxPlayers) {
        await ephemeralError(interaction, `정원 초과입니다. (최대 ${maxPlayers}명)`);
        return true;
      }
    }

    // replace면 기존 인원 전부 제거
    if (mode === "replace") {
      for (const m of current) {
        await removeMember(msgId, m.user_id);
      }
    }

    // 강제 참가 추가 (비고는 빈 문자열)
    for (const id of userIds) {
      await setMemberNote(msgId, id, "");
    }

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    if (logEmbed) {
      await logEmbed(guild, {
        title: "🛠️ 운영진 강제 참가",
        color: 0xf1c40f,
        fields: [
          field("파티 메시지 ID", msgId, true),
          field("모드", mode, true),
          field("대상", userIds.map((id) => `<@${id}>`).join(" "), false),
        ],
      });
    }

    return true;
  }

  /**
   * ✅ 파티 메시지 버튼들
   */
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

    // 참가/비고
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msgId)).catch(() => {});
      return true;
    }

    // 나가기
    if (interaction.customId === "party:leave") {
      await ackUpdate(interaction);

      await removeMember(msgId, interaction.user.id);
      const after = await getParty(msgId);

      // 전원 이탈 자동 종료
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

    // 운영진 관리(강제참가 모달)
    if (interaction.customId === "party:admin") {
      if (!isAdmin(interaction)) {
        await ephemeralError(interaction, "운영진만 사용할 수 있습니다.");
        return true;
      }
      await interaction.showModal(adminForceJoinModal(msgId)).catch(() => {});
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
        await ephemeralError(interaction, "메시지 삭제에 실패했습니다. (봇 권한 확인 필요)");
      }
      return true;
    }

    return false;
  }

  /**
   * ✅ 참가 비고 모달 제출
   */
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

      // GAME만 정원 체크
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

      return true;
    } catch {
      await ephemeralError(interaction, "참가/비고 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  /**
   * ✅ 수정 모달 제출
   */
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

      const kind = party.kind;
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

      // 무제한은 0 유지
      let maxPlayers = 0;
      if (!isUnlimitedKind(kind)) {
        const parsed = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));
        if (!parsed) {
          await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
          return true;
        }

        const memberCount = party.members?.length ?? 0;
        if (parsed < memberCount) {
          await ephemeralError(interaction, `현재 참가자가 ${memberCount}명입니다. 인원제한을 줄일 수 없습니다.`);
          return true;
        }

        maxPlayers = parsed;
      }

      await upsertParty({
        ...party,
        title,
        party_note: note,
        time_text: time,
        max_players: maxPlayers,
        mode: "TEXT",
        start_at: 0,
      });

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      return true;
    } catch {
      await ephemeralError(interaction, "파티 수정 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  return false;
}

module.exports = { handleParty };
