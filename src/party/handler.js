// src/party/handler.js
const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID } = require("../config");
const {
  upsertParty,
  getParty,
  setMemberNote,
  removeMember,
  deleteParty,
  listActiveParties, // index.js에서 쓰는 경우가 있어 유지
} = require("../db");

const { logEmbed, field } = require("../discord/log");
const { safeTrim } = require("../discord/util");

const {
  createPartyModal,
  editPartyModal,
  joinNoteModal,
  waitModal,
  adminForceJoinModal,
  partyActionRows,
  endedActionRow,
  kindLabel,
  kindIcon,
  isUnlimitedKind,
} = require("./ui");

const ERROR_EPHEMERAL_MS = 8000;
const OK_BLANK = "\u200b";
const WAIT_PREFIX = "__WAIT__:";

// ---------- 공용 ----------
function isAdmin(interaction) {
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  if (!ADMIN_ROLE_ID) return false;
  return !!interaction.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
}

async function ackUpdate(interaction) {
  await interaction.deferUpdate().catch(() => {});
}

async function ackModal(interaction) {
  // 모달 submit은 응답 강제 → 최소 응답으로 시작
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: OK_BLANK, ephemeral: true }).catch(() => {});
  }
}

async function doneModal(interaction) {
  // “빈 에페메랄” 잔상 최소화용
  try {
    await interaction.editReply({ content: OK_BLANK }).catch(() => {});
  } catch {}
}

async function ephemeralError(interaction, content) {
  try {
    if (interaction.type === InteractionType.ModalSubmit) {
      await ackModal(interaction);
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
  } catch {}
}

function parseMaxPlayers(maxRaw) {
  const n = Number(maxRaw);
  if (!Number.isInteger(n) || n < 2 || n > 20) return null;
  return n;
}

function isWaiting(note) {
  return (note ?? "").toString().startsWith(WAIT_PREFIX);
}

function waitingText(note) {
  const s = (note ?? "").toString();
  return isWaiting(s) ? s.slice(WAIT_PREFIX.length).trim() : "";
}

function stripWaitPrefix(note) {
  const s = (note ?? "").toString();
  return isWaiting(s) ? s.slice(WAIT_PREFIX.length).trim() : s.trim();
}

function playingCount(party) {
  return (party.members ?? []).filter((m) => !isWaiting(m.note)).length;
}

function statusLabel(status) {
  if (status === "PLAYING") return "🟢 플레이중";
  if (status === "ENDED") return "⚫ 종료";
  return "🔴 모집중";
}

function timeDisplay(timeTextRaw) {
  const t = (timeTextRaw ?? "").toString().trim();
  return t ? t : "⚡ 모바시";
}

function buildParticipants(party) {
  const kind = party.kind;
  const members = Array.isArray(party.members) ? party.members : [];

  const waiting = [];
  const playing = [];
  for (const m of members) (isWaiting(m.note) ? waiting : playing).push(m);

  if (isUnlimitedKind(kind)) {
    const lines = [];
    if (playing.length === 0) lines.push("(참가자 없음)");
    else lines.push(playing.map((m) => `• <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`).join("\n"));

    if (waiting.length > 0) {
      lines.push("");
      lines.push("대기:");
      lines.push(
        waiting
          .map((m) => `• <@${m.user_id}>${waitingText(m.note) ? ` — ${waitingText(m.note)}` : ""}`)
          .join("\n")
      );
    }
    return lines.join("\n");
  }

  const maxPlayers = Number(party.max_players) || 4;
  const lines = [];

  for (let i = 0; i < maxPlayers; i++) {
    const m = playing[i];
    if (!m) lines.push(`${i + 1}.`);
    else lines.push(`${i + 1}. <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`);
  }

  if (waiting.length > 0) {
    lines.push("");
    lines.push("대기:");
    lines.push(
      waiting
        .map((m) => `• <@${m.user_id}>${waitingText(m.note) ? ` — ${waitingText(m.note)}` : ""}`)
        .join("\n")
    );
  }

  return lines.join("\n");
}

function buildPartyEmbed(party) {
  const icon = kindIcon(party.kind);
  const label = kindLabel(party.kind);

  const titleText = (party.title ?? "").toString().trim();
  const secondLine = titleText ? `${icon} ${label} — ${titleText}` : `${icon} ${label}`;

  return {
    color: party.status === "PLAYING" ? 0x2ecc71 : party.status === "ENDED" ? 0x95a5a6 : 0xe74c3c,
    title: `${statusLabel(party.status)}\n${secondLine}`,
    fields: [
      { name: "특이사항", value: (party.party_note ?? "").toString().trim() || "(없음)", inline: false },
      { name: "시간", value: timeDisplay(party.time_text), inline: false },
      { name: "참가자 목록", value: buildParticipants(party), inline: false },
    ],
  };
}

function buildCreatingEmbed(kind) {
  return {
    color: 0x95a5a6,
    title: `🛠️ 파티 생성 중...\n${kindIcon(kind)} ${kindLabel(kind)}`,
    description: OK_BLANK,
  };
}

async function refreshPartyMessage(guild, party) {
  const ch = await guild.channels.fetch(party.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;

  const msg = await ch.messages.fetch(party.message_id).catch(() => null);
  if (!msg) return;

  const embed = buildPartyEmbed(party);
  const components = party.status === "ENDED" ? [endedActionRow()] : partyActionRows();
  await msg.edit({ embeds: [embed], components }).catch(() => {});
}

async function endParty(guild, party, reason, message) {
  await upsertParty({ ...party, status: "ENDED", mode: "TEXT", start_at: 0 });

  if (message) {
    try {
      await message.delete();
      await deleteParty(party.message_id);
      await logEmbed(guild, {
        title: "⚫ 파티 종료(메시지 삭제)",
        color: 0x95a5a6,
        fields: [field("파티 메시지 ID", party.message_id, true), field("사유", reason)],
      });
      return;
    } catch {}
  }

  const ended = await getParty(party.message_id);
  if (ended) await refreshPartyMessage(guild, ended);

  await logEmbed(guild, {
    title: "⚫ 파티 종료(메시지 유지)",
    color: 0x95a5a6,
    fields: [
      field("파티 메시지 ID", party.message_id, true),
      field("사유", reason),
      field("처리", "메시지 삭제 실패 → 종료 고정 + 🗑 삭제 버튼 제공"),
    ],
  });
}

// ---------- 운영진 강제참가: “서버 별명” 기준 ----------
function splitTokens(text) {
  return (text ?? "")
    .toString()
    .split(/\n|,|，/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractIds(text) {
  const s = (text ?? "").toString();
  const ids = new Set();

  const mentionRe = /<@!?(\d{15,21})>/g;
  let m;
  while ((m = mentionRe.exec(s))) ids.add(m[1]);

  const rawRe = /\b(\d{15,21})\b/g;
  while ((m = rawRe.exec(s))) ids.add(m[1]);

  return [...ids];
}

async function resolveUserIds(guild, input) {
  const tokens = splitTokens(input);
  const resolved = new Set();
  const nameTokens = [];

  for (const t of tokens) {
    const ids = extractIds(t);
    if (ids.length) ids.forEach((id) => resolved.add(id));
    else nameTokens.push(t);
  }

  try {
    await guild.members.fetch();
  } catch {}

  const unresolved = [];

  for (const name of nameTokens) {
    const q = name.toLowerCase();
    const matches = guild.members.cache.filter((m) => (m.displayName ?? "").toLowerCase().includes(q));

    if (matches.size === 1) resolved.add(matches.first().id);
    else unresolved.push(name);
  }

  return { userIds: [...resolved], unresolved };
}

// ---------- 메인 ----------
async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  /**
   * 0) 현황판 버튼(게임/영화/수다/노래)
   * - 반드시 showModal을 “최우선”으로 실행해서 3초 상호작용 실패를 막는다.
   * - DB 조회 금지 (현황판 메시지는 DB에 party row가 없음)
   */
  if (interaction.isButton() && interaction.customId.startsWith("party:create:")) {
    const kind = interaction.customId.split(":")[2]; // GAME/MOVIE/CHAT/MUSIC
    await interaction.showModal(createPartyModal(kind)).catch(() => {});
    return true;
  }

  /**
   * 1) 생성 모달 제출
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:create:submit:")) {
    await ackModal(interaction);

    const kind = interaction.customId.split(":")[3];

    try {
      const note = safeTrim(interaction.fields.getTextInputValue("note"));
      const time = safeTrim(interaction.fields.getTextInputValue("time"));
      const title = safeTrim(interaction.fields.getTextInputValue("title"));

      if (!isUnlimitedKind(kind) && !title) {
        await ephemeralError(interaction, "제목은 필수입니다.");
        return true;
      }

      let maxPlayers = 0;
      if (!isUnlimitedKind(kind)) {
        const parsed = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));
        if (!parsed) {
          await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
          return true;
        }
        maxPlayers = parsed;
      } else {
        maxPlayers = 0; // 무제한은 0 고정
      }

      const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
      if (!board?.isTextBased()) {
        await ephemeralError(interaction, "게시판 채널을 찾지 못했습니다.");
        return true;
      }

      // embed-only 생성
      const msg = await board.send({ embeds: [buildCreatingEmbed(kind)], components: [] });

      await upsertParty({
        message_id: msg.id,
        channel_id: msg.channel.id,
        guild_id: guild.id,
        owner_id: interaction.user.id,
        kind,
        title: title || "(제목 없음)",
        party_note: note,
        time_text: time || "",
        mode: "TEXT",
        start_at: 0,
        status: "RECRUIT",
        max_players: maxPlayers,
      });

      // 파티장 자동 참가(플레이)
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
          field("시간", timeDisplay(time), true),
        ],
      });

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "파티 생성 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  /**
   * 2) 파티 주문서(파티 메시지) 버튼 처리
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

    // 종료된 파티는 delete만 허용
    if (party.status === "ENDED" && interaction.customId !== "party:delete") {
      await ephemeralError(interaction, "이미 종료된 파티입니다.");
      return true;
    }

    // 참가/비고
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msgId)).catch(() => {});
      return true;
    }

    // 대기(코멘트)
    if (interaction.customId === "party:wait") {
      await interaction.showModal(waitModal(msgId)).catch(() => {});
      return true;
    }

    // ✅ 대기 해지 = 줄에서 나가기 (참가 전환 아님)
    if (interaction.customId === "party:waitoff") {
      await ackUpdate(interaction);

      const me = (party.members ?? []).find((m) => m.user_id === interaction.user.id);
      if (!me || !isWaiting(me.note)) {
        await ephemeralError(interaction, "대기 상태가 아닙니다.");
        return true;
      }

      await removeMember(msgId, interaction.user.id);

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);
      return true;
    }

    // 나가기(대기/플레이 공통)
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

    // 수정(파티장/운영진)
    if (interaction.customId === "party:edit") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await ephemeralError(interaction, "파티장 또는 운영진만 수정할 수 있습니다.");
        return true;
      }
      await interaction.showModal(editPartyModal(msgId, party.kind, party)).catch(() => {});
      return true;
    }

    // 시작/종료(파티원/파티장/운영진)
    if (interaction.customId === "party:start" || interaction.customId === "party:end") {
      const isMember = (party.members ?? []).some((m) => m.user_id === interaction.user.id);
      const ok = isMember || interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await ephemeralError(interaction, "파티원/파티장/운영진만 가능합니다.");
        return true;
      }

      await ackUpdate(interaction);

      if (interaction.customId === "party:start") {
        await upsertParty({ ...party, status: "PLAYING", mode: "TEXT", start_at: 0 });
        const updated = await getParty(msgId);
        if (updated) await refreshPartyMessage(guild, updated);
        return true;
      }

      await endParty(guild, party, "수동 종료", interaction.message);
      return true;
    }

    // 운영진 강제참가(모달)
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
        await ephemeralError(interaction, "메시지 삭제에 실패했습니다. (봇 권한 확인)");
      }
      return true;
    }

    return false;
  }

  /**
   * 3) 참가/비고 모달 제출
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

      // GAME만 정원 체크(대기 제외)
      if (!isUnlimitedKind(party.kind)) {
        const maxPlayers = Number(party.max_players) || 4;
        const existsAsPlaying = (party.members ?? []).some((m) => m.user_id === interaction.user.id && !isWaiting(m.note));
        const count = playingCount(party);
        if (!existsAsPlaying && count >= maxPlayers) {
          await ephemeralError(interaction, `이미 정원이 찼습니다. (최대 ${maxPlayers}명)`);
          return true;
        }
      }

      // 대기중이면 접두어 제거하고 플레이 합류
      const me = (party.members ?? []).find((m) => m.user_id === interaction.user.id);
      const base = me?.note ? stripWaitPrefix(me.note) : "";
      const finalNote = inputNote || base || "";

      await setMemberNote(msgId, interaction.user.id, finalNote);

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "참가/비고 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  /**
   * 4) 대기 모달 제출
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:wait:submit:")) {
    await ackModal(interaction);

    try {
      const msgId = interaction.customId.split(":")[3];
      const party = await getParty(msgId);

      if (!party) {
        await ephemeralError(interaction, "DB에서 파티를 찾지 못했습니다.");
        return true;
      }
      if (party.status === "ENDED") {
        await ephemeralError(interaction, "이미 종료된 파티입니다.");
        return true;
      }

      const note = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 120);
      await setMemberNote(msgId, interaction.user.id, `${WAIT_PREFIX}${note}`);

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "대기 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  /**
   * 5) 수정 모달 제출
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:edit:submit:")) {
    await ackModal(interaction);

    try {
      const msgId = interaction.customId.split(":")[3];
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
      const time = safeTrim(interaction.fields.getTextInputValue("time"));
      const title = safeTrim(interaction.fields.getTextInputValue("title"));

      if (!isUnlimitedKind(kind) && !title) {
        await ephemeralError(interaction, "제목은 필수입니다.");
        return true;
      }

      let maxPlayers = 0;
      if (!isUnlimitedKind(kind)) {
        const parsed = parseMaxPlayers(safeTrim(interaction.fields.getTextInputValue("max")));
        if (!parsed) {
          await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
          return true;
        }

        const currentPlaying = playingCount(party);
        if (parsed < currentPlaying) {
          await ephemeralError(interaction, `현재 플레이 참가자가 ${currentPlaying}명입니다. 그 미만으로 줄일 수 없습니다.`);
          return true;
        }
        maxPlayers = parsed;
      } else {
        maxPlayers = 0;
      }

      await upsertParty({
        ...party,
        title: title || "(제목 없음)",
        party_note: note,
        time_text: time || "",
        max_players: maxPlayers,
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

  /**
   * 6) 운영진 강제참가 모달
   */
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:admin:forcejoin:")) {
    await ackModal(interaction);

    if (!isAdmin(interaction)) {
      await ephemeralError(interaction, "운영진만 사용할 수 있습니다.");
      return true;
    }

    try {
      const msgId = interaction.customId.split(":")[3];
      const party = await getParty(msgId);

      if (!party) {
        await ephemeralError(interaction, "DB에서 파티를 찾지 못했습니다.");
        return true;
      }
      if (party.status === "ENDED") {
        await ephemeralError(interaction, "이미 종료된 파티입니다.");
        return true;
      }

      const usersRaw = interaction.fields.getTextInputValue("users");
      const modeRaw = safeTrim(interaction.fields.getTextInputValue("mode")).toLowerCase();
      const mode = modeRaw === "replace" ? "replace" : "add";

      const { userIds, unresolved } = await resolveUserIds(guild, usersRaw);

      if (unresolved.length) {
        await ephemeralError(interaction, `이 별명들은 유일하게 매칭되지 않아 실패했습니다: ${unresolved.join(", ")}`);
        return true;
      }
      if (!userIds.length) {
        await ephemeralError(interaction, "유저를 찾지 못했습니다. 서버별명/멘션/ID로 입력하세요.");
        return true;
      }

      // replace면 기존 멤버 전부 제거
      if (mode === "replace") {
        for (const m of party.members ?? []) {
          await removeMember(msgId, m.user_id);
        }
      }

      // GAME 정원 체크(대기 제외 / 강제참가는 플레이로 넣음)
      if (!isUnlimitedKind(party.kind)) {
        const maxPlayers = Number(party.max_players) || 4;
        const afterBase = await getParty(msgId);
        const basePlaying = playingCount(afterBase || party);

        const existing = new Set((afterBase || party).members?.map((m) => m.user_id) ?? []);
        const addCount = mode === "replace" ? userIds.length : userIds.filter((id) => !existing.has(id)).length;

        if (basePlaying + addCount > maxPlayers) {
          await ephemeralError(interaction, `정원 초과입니다. (최대 ${maxPlayers}명)`);
          return true;
        }
      }

      for (const id of userIds) {
        await setMemberNote(msgId, id, ""); // 플레이 참가로 넣음
      }

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);

      await doneModal(interaction);
      return true;
    } catch {
      await ephemeralError(interaction, "운영진 강제참가 처리 중 오류가 발생했습니다.");
      return true;
    }
  }

  return false;
}

// ✅ index.js가 기대하는 export들
async function syncOrderMessage(guild, messageId) {
  const party = await getParty(messageId);
  if (!party) return;
  await refreshPartyMessage(guild, party);
}

async function runPartyTick(client) {
  // 필요 시 확장
  return;
}

module.exports = {
  handleParty,
  syncOrderMessage,
  runPartyTick,
};
