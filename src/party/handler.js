// src/party/handler.js
const { InteractionType, EmbedBuilder } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID } = require("../config");
const { upsertParty, getParty, setMemberNote, removeMember, deleteParty } = require("../db");
const { logEmbed, field } = require("../log");
const { safeTrim } = require("../util");

const {
  partyBoardEmbed,
  partyBoardComponents,
  kindButtonsRow,
  cancelRow,
  createPartyModal,
  editPartyModal,
  joinNoteModal,
  waitModal,
  adminForceJoinModal,
  partyActionRows,
  endedActionRow,
  isUnlimitedKind,
  kindLabel,
  kindIcon,
} = require("./ui");

// =================== 에페메랄 정책(최소) ===================
const ERROR_EPHEMERAL_MS = 8000;
const OK_BLANK = "\u200b";

async function ackUpdate(interaction) {
  await interaction.deferUpdate().catch(() => {});
}

// ModalSubmit은 반드시 응답해야 하므로, “보이는 텍스트” 최소화
async function ackModal(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: OK_BLANK, ephemeral: true }).catch(() => {});
  }
}

async function ephemeralError(interaction, content) {
  try {
    // ModalSubmit이면 editReply로 처리
    if (interaction.type === InteractionType.ModalSubmit) {
      await ackModal(interaction);
      await interaction.editReply({ content }).catch(() => {});
      setTimeout(() => interaction.editReply({ content: OK_BLANK }).catch(() => {}), ERROR_EPHEMERAL_MS);
      return;
    }

    // 버튼/셀렉트 등
    if (interaction.deferred || interaction.replied) {
      const m = await interaction.followUp({ content, ephemeral: true }).catch(() => null);
      if (m?.delete) setTimeout(() => m.delete().catch(() => {}), ERROR_EPHEMERAL_MS);
      return;
    }

    await interaction.reply({ content, ephemeral: true }).catch(() => {});
    setTimeout(() => interaction.deleteReply().catch(() => {}), ERROR_EPHEMERAL_MS);
  } catch {}
}

function isAdmin(interaction) {
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  if (!ADMIN_ROLE_ID) return false;
  return !!interaction.member?.roles?.cache?.has?.(ADMIN_ROLE_ID);
}

// =================== 대기(줄서기) 저장 방식 ===================
// 유저에게 “대기”라는 단어 입력 강요 X
// note 앞에 숨김 접두어로만 저장
const WAIT_PREFIX = "__WAIT__:";

function isWaitingNote(note) {
  return (note ?? "").toString().startsWith(WAIT_PREFIX);
}

function waitingText(note) {
  const s = (note ?? "").toString();
  return isWaitingNote(s) ? s.slice(WAIT_PREFIX.length).trim() : "";
}

function clearWaitingPrefix(note) {
  const s = (note ?? "").toString();
  return isWaitingNote(s) ? s.slice(WAIT_PREFIX.length).trim() : s.trim();
}

function playingCount(party) {
  return (party.members ?? []).filter((m) => !isWaitingNote(m.note)).length;
}

// =================== 표시/임베드 ===================
function statusLabel(status) {
  if (status === "PLAYING") return "🟢 플레이중";
  if (status === "ENDED") return "⚫ 종료";
  return "🔴 모집중";
}

function timeDisplay(timeTextRaw) {
  const t = (timeTextRaw ?? "").toString().trim();
  if (!t) return "⚡ 모바시";
  return t;
}

function buildParticipants(kind, maxPlayers, members) {
  const list = Array.isArray(members) ? members : [];

  const waiting = [];
  const playing = [];

  for (const m of list) {
    if (isWaitingNote(m.note)) waiting.push(m);
    else playing.push(m);
  }

  // 무제한
  if (isUnlimitedKind(kind)) {
    const lines = [];

    if (playing.length === 0) lines.push("(참가자 없음)");
    else {
      lines.push(
        playing
          .map((m) => `• <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`)
          .join("\n")
      );
    }

    if (waiting.length > 0) {
      lines.push("");
      lines.push(
        "대기:\n" +
          waiting
            .map((m) => {
              const w = waitingText(m.note);
              return `• <@${m.user_id}>${w ? ` — ${w}` : ""}`;
            })
            .join("\n")
      );
    }

    return lines.join("\n");
  }

  // GAME 슬롯 고정 (슬롯은 playing만 채움)
  const lines = [];
  for (let i = 0; i < maxPlayers; i++) {
    const m = playing[i];
    if (!m) lines.push(`${i + 1}.`);
    else lines.push(`${i + 1}. <@${m.user_id}>${m.note?.trim() ? ` — ${m.note.trim()}` : ""}`);
  }

  if (waiting.length > 0) {
    lines.push("");
    lines.push(
      "대기:\n" +
        waiting
          .map((m) => {
            const w = waitingText(m.note);
            return `• <@${m.user_id}>${w ? ` — ${w}` : ""}`;
          })
          .join("\n")
    );
  }

  return lines.join("\n");
}

function buildPartyEmbed(party) {
  const icon = kindIcon(party.kind);
  const label = kindLabel(party.kind);
  const titleText = safeTrim(party.title);
  const secondLine = titleText ? `${icon} ${label} — ${titleText}` : `${icon} ${label}`;

  const maxPlayers = isUnlimitedKind(party.kind) ? 0 : Number(party.max_players) || 4;

  const embed = new EmbedBuilder()
    .setColor(party.status === "PLAYING" ? 0x2ecc71 : party.status === "ENDED" ? 0x95a5a6 : 0xe74c3c)
    .setTitle(`${statusLabel(party.status)}\n${secondLine}`)
    .addFields(
      { name: "특이사항", value: safeTrim(party.party_note) || "(없음)", inline: false },
      { name: "시간", value: timeDisplay(party.time_text), inline: false },
      {
        name: "참가자 목록",
        value: buildParticipants(party.kind, maxPlayers, party.members),
        inline: false,
      }
    );

  return embed;
}

function buildCreatingEmbed(kind) {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`🛠️ 파티 생성 중...\n${kindIcon(kind)} ${kindLabel(kind)}`)
    .setDescription(OK_BLANK);
}

async function refreshPartyMessage(guild, party) {
  const ch = await guild.channels.fetch(party.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;

  const msg = await ch.messages.fetch(party.message_id).catch(() => null);
  if (!msg) return;

  const embed = buildPartyEmbed(party);
  const components = party.status === "ENDED" ? endedActionRow() : partyActionRows();
  await msg.edit({ embeds: [embed], components }).catch(() => {});
}

async function endParty(guild, party, reason, messageObj) {
  // 종료 시 메시지 삭제 시도
  if (messageObj) {
    try {
      await messageObj.delete();
      await deleteParty(party.message_id);

      await logEmbed(guild, {
        title: "⚫ 파티 종료(메시지 삭제)",
        color: 0x95a5a6,
        fields: [field("파티 메시지 ID", party.message_id, true), field("사유", reason)],
      });

      return;
    } catch {
      // 삭제 실패: DB에는 ENDED로 고정 + 삭제 버튼만 남김
    }
  }

  await upsertParty({ ...party, status: "ENDED" });
  const updated = await getParty(party.message_id);
  if (updated) await refreshPartyMessage(guild, updated);

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

// =================== 운영진 강제참가: 별명/멘션/ID 파싱 ===================
function parseUserIds(text) {
  const s = (text ?? "").toString();
  const ids = new Set();

  const mentionRe = /<@!?(\d{15,21})>/g;
  let m;
  while ((m = mentionRe.exec(s))) ids.add(m[1]);

  const rawRe = /\b(\d{15,21})\b/g;
  while ((m = rawRe.exec(s))) ids.add(m[1]);

  return [...ids];
}

function splitUserTokens(text) {
  return (text ?? "")
    .toString()
    .split(/\n|,|，/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeName(s) {
  return (s ?? "").toString().trim().toLowerCase();
}

async function resolveUserIdsFromInput(guild, input) {
  const tokens = splitUserTokens(input);
  const resolved = new Set();
  const unresolved = [];

  // 1) 멘션/ID 우선
  for (const t of tokens) {
    const ids = parseUserIds(t);
    if (ids.length) ids.forEach((id) => resolved.add(id));
    else unresolved.push(t);
  }

  // 2) 캐시 보강(가능하면)
  try {
    if (guild.members.cache.size < 50) {
      await guild.members.fetch();
    }
  } catch {}

  // 3) 별명/유저명 매칭 (유일 후보만 자동 선택)
  for (const raw of unresolved.slice()) {
    const q = normalizeName(raw);
    if (!q) continue;

    const matches = guild.members.cache.filter((m) => {
      const dn = normalizeName(m.displayName);
      const un = normalizeName(m.user?.username);
      return dn === q || un === q || dn.includes(q) || un.includes(q);
    });

    if (matches.size === 1) {
      resolved.add(matches.first().id);
      unresolved.splice(unresolved.indexOf(raw), 1);
    }
  }

  return { userIds: [...resolved], unresolved };
}

// =================== 메인 핸들러 ===================
async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // 0) 현황판 설치(필요 시). 여기서는 자동 설치 안 함.
  // 필요하면 별도 커맨드/스크립트에서 partyBoardEmbed + components를 보내면 됨.

  // 1) 현황판: 새 파티 만들기 버튼
  if (interaction.isButton() && interaction.customId === "party:create") {
    // kind 선택을 에페메랄로 띄움(채널 메시지 쌓임 방지)
    // 버튼 클릭은 update로 처리 (성공 메시지 남기지 않음)
    await interaction.reply({
      content: "파티 종류를 선택하세요.",
      components: [kindButtonsRow(), cancelRow("party:create:cancel")],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  // 2) 현황판: 취소
  if (interaction.isButton() && interaction.customId === "party:create:cancel") {
    await interaction.update({ content: OK_BLANK, components: [] }).catch(() => {});
    return true;
  }

  // 3) 현황판: 종류 버튼 → 생성 모달
  if (interaction.isButton() && interaction.customId.startsWith("party:create:kindbtn:")) {
    const kind = interaction.customId.split(":")[3]; // GAME/MOVIE/CHAT/MUSIC
    // 이 버튼 상호작용은 update로 즉시 정리
    await interaction.update({ content: OK_BLANK, components: [] }).catch(() => {});
    await interaction.showModal(createPartyModal(kind)).catch(() => {});
    return true;
  }

  // 4) 파티 생성 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:create:modal:")) {
    await ackModal(interaction);

    const kind = interaction.customId.split(":")[3];
    const title = safeTrim(interaction.fields.getTextInputValue("title"));
    const note = safeTrim(interaction.fields.getTextInputValue("party_note"));
    const timeText = safeTrim(interaction.fields.getTextInputValue("time_text"));

    if (!isUnlimitedKind(kind) && !title) {
      await ephemeralError(interaction, "제목은 필수입니다.");
      return true;
    }

    let maxPlayers = 4;
    if (!isUnlimitedKind(kind)) {
      const raw = safeTrim(interaction.fields.getTextInputValue("max_players"));
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 2 || n > 20) {
        await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
        return true;
      }
      maxPlayers = n;
    } else {
      // 무제한은 max_players를 0으로 저장
      maxPlayers = 0;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await ephemeralError(interaction, "게시판 채널을 찾지 못했습니다.");
      return true;
    }

    // ✅ embed-only로 생성 중 메시지 먼저 생성
    const msg = await board.send({ embeds: [buildCreatingEmbed(kind)], components: [] });

    try {
      await upsertParty({
        message_id: msg.id,
        channel_id: msg.channel.id,
        guild_id: guild.id,
        owner_id: interaction.user.id,
        kind,
        title: title || "(제목 없음)",
        party_note: note,
        mode: timeText ? "TIME" : "ASAP",
        start_at: 0,
        status: "RECRUIT",
        max_players: maxPlayers,
        time_text: timeText,
      });

      // 파티장 자동 참가(플레이 슬롯)
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
          field("시간", timeDisplay(timeText), true),
        ],
      });

      return true;
    } catch (e) {
      await msg.delete().catch(() => {});
      await ephemeralError(interaction, "파티 생성 처리중 오류가 발생했습니다.");
      return true;
    }
  }

  // 5) 운영진 강제참가 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:admin:forcejoin:")) {
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
    const modeRaw = safeTrim(interaction.fields.getTextInputValue("mode")).toLowerCase();
    const mode = modeRaw === "replace" ? "replace" : "add";

    const { userIds, unresolved } = await resolveUserIdsFromInput(guild, usersRaw);
    if (userIds.length === 0) {
      await ephemeralError(interaction, "유저를 찾지 못했습니다. 멘션/ID/서버별명으로 입력해 주세요.");
      return true;
    }
    if (unresolved.length > 0) {
      await ephemeralError(interaction, `일부 유저는 유일하게 매칭되지 않아 제외되었습니다: ${unresolved.join(", ")}`);
      return true;
    }

    // 무제한은 제한 없음
    const unlimited = isUnlimitedKind(party.kind);
    const maxPlayers = unlimited ? 0 : (Number(party.max_players) || 4);

    // replace면 기존 전원 제거(대기 포함)
    if (mode === "replace") {
      for (const m of party.members ?? []) {
        await removeMember(msgId, m.user_id);
      }
    }

    // add/replace 모두 “플레이 참가”로 넣음 (대기는 운영진이 별도 버튼/모달로 할 수 있게 확장 가능)
    // 정원 체크는 플레이 인원 기준
    if (!unlimited) {
      const afterParty = await getParty(msgId);
      const base = mode === "replace" ? 0 : playingCount(afterParty || party);

      // 새로 추가될 플레이 인원(중복 제외)
      const existing = new Set((afterParty || party).members?.map(m => m.user_id) ?? []);
      const addCount =
        mode === "replace" ? userIds.length : userIds.filter(id => !existing.has(id)).length;

      if (base + addCount > maxPlayers) {
        await ephemeralError(interaction, `정원 초과입니다. (최대 ${maxPlayers}명)`);
        return true;
      }
    }

    for (const id of userIds) {
      await setMemberNote(msgId, id, "");
    }

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    await logEmbed(guild, {
      title: "🛠️ 운영진 강제 참가",
      color: 0xf1c40f,
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("모드", mode, true),
        field("대상", userIds.map((id) => `<@${id}>`).join(" "), false),
      ],
    });

    return true;
  }

  // 6) 파티 메시지 버튼들
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

    // 대기(버튼 → 모달)
    if (interaction.customId === "party:wait") {
      await interaction.showModal(waitModal(msgId)).catch(() => {});
      return true;
    }

    // 대기 해지
    if (interaction.customId === "party:waitoff") {
      await ackUpdate(interaction);

      const me = (party.members ?? []).find((m) => m.user_id === interaction.user.id);
      if (!me || !isWaitingNote(me.note)) {
        await ephemeralError(interaction, "대기 상태가 아닙니다.");
        return true;
      }

      await setMemberNote(msgId, interaction.user.id, clearWaitingPrefix(me.note));

      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);
      return true;
    }

    // 나가기 (대기/플레이 공통)
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

    // 수정 (파티장/운영진)
    if (interaction.customId === "party:edit") {
      const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
      if (!ok) {
        await ephemeralError(interaction, "파티장 또는 운영진만 수정할 수 있습니다.");
        return true;
      }
      await interaction.showModal(editPartyModal(msgId, party.kind, party)).catch(() => {});
      return true;
    }

    // 시작 (파티원도 가능하게 하려면 여기서 ok 조건 완화하면 됨)
    if (interaction.customId === "party:start") {
      await ackUpdate(interaction);
      await upsertParty({ ...party, status: "PLAYING" });
      const updated = await getParty(msgId);
      if (updated) await refreshPartyMessage(guild, updated);
      return true;
    }

    // 종료 (파티원도 가능하게 하려면 여기서 ok 조건 완화하면 됨)
    if (interaction.customId === "party:end") {
      await ackUpdate(interaction);
      await endParty(guild, party, "수동 종료", interaction.message);
      return true;
    }

    // 운영진 관리(강제참가)
    if (interaction.customId === "party:admin") {
      if (!isAdmin(interaction)) {
        await ephemeralError(interaction, "운영진만 사용할 수 있습니다.");
        return true;
      }
      await interaction.showModal(adminForceJoinModal(msgId)).catch(() => {});
      return true;
    }

    // 삭제 (파티장/운영진)
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

  // 7) 참가/비고 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    await ackModal(interaction);

    const msgId = interaction.customId.split(":")[2];
    const party = await getParty(msgId);
    if (!party) {
      await ephemeralError(interaction, "파티를 찾지 못했습니다.");
      return true;
    }
    if (party.status === "ENDED") {
      await ephemeralError(interaction, "이미 종료된 파티입니다.");
      return true;
    }

    const note = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    const unlimited = isUnlimitedKind(party.kind);
    const maxPlayers = unlimited ? 0 : (Number(party.max_players) || 4);

    // ✅ join은 플레이 슬롯 합류 시도: 대기자는 정원에 포함 X
    if (!unlimited) {
      const existsAsPlaying = (party.members ?? []).some(
        (m) => m.user_id === interaction.user.id && !isWaitingNote(m.note)
      );

      if (!existsAsPlaying) {
        const count = playingCount(party);
        if (count >= maxPlayers) {
          await ephemeralError(interaction, `이미 정원이 찼습니다. (최대 ${maxPlayers}명)`);
          return true;
        }
      }
    }

    // 대기중이었다면 접두어 제거 후 플레이 노트로 전환
    const me = (party.members ?? []).find((m) => m.user_id === interaction.user.id);
    const base = me?.note ? clearWaitingPrefix(me.note) : "";
    const finalNote = note || base || "";

    await setMemberNote(msgId, interaction.user.id, finalNote);

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    await logEmbed(guild, {
      title: "➕ 참가/비고",
      color: 0x3498db,
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("비고", finalNote || "(없음)"),
      ],
    });

    return true;
  }

  // 8) 대기 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:wait:modal:")) {
    await ackModal(interaction);

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

    const note = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 120);

    // ✅ 대기는 슬롯 꽉 차도 허용(정원 체크 없음)
    await setMemberNote(msgId, interaction.user.id, `${WAIT_PREFIX}${note}`);

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    await logEmbed(guild, {
      title: "🕒 대기 등록",
      color: 0x9b59b6,
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("대기 코멘트", note || "(없음)"),
      ],
    });

    return true;
  }

  // 9) 파티 수정 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:edit:modal:")) {
    await ackModal(interaction);

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

    const ok = interaction.user.id === party.owner_id || isAdmin(interaction);
    if (!ok) {
      await ephemeralError(interaction, "파티장 또는 운영진만 수정할 수 있습니다.");
      return true;
    }

    const title = safeTrim(interaction.fields.getTextInputValue("title"));
    const note = safeTrim(interaction.fields.getTextInputValue("party_note"));
    const timeText = safeTrim(interaction.fields.getTextInputValue("time_text"));

    if (!isUnlimitedKind(party.kind) && !title) {
      await ephemeralError(interaction, "제목은 필수입니다.");
      return true;
    }

    let maxPlayers = party.max_players;
    if (!isUnlimitedKind(party.kind)) {
      const raw = safeTrim(interaction.fields.getTextInputValue("max_players"));
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 2 || n > 20) {
        await ephemeralError(interaction, "인원제한은 2~20 사이 숫자여야 합니다.");
        return true;
      }

      // 플레이 인원(대기 제외)보다 줄일 수 없음
      const currentPlaying = playingCount(party);
      if (n < currentPlaying) {
        await ephemeralError(interaction, `현재 플레이 참가자가 ${currentPlaying}명입니다. 그 미만으로 줄일 수 없습니다.`);
        return true;
      }

      maxPlayers = n;
    } else {
      maxPlayers = 0;
    }

    await upsertParty({
      ...party,
      title: title || "(제목 없음)",
      party_note: note,
      time_text: timeText,
      mode: timeText ? "TIME" : "ASAP",
      start_at: 0,
      max_players: maxPlayers,
    });

    const updated = await getParty(msgId);
    if (updated) await refreshPartyMessage(guild, updated);

    await logEmbed(guild, {
      title: "✏️ 파티 수정",
      color: 0x1abc9c,
      fields: [field("파티 메시지 ID", msgId, true), field("수정자", `<@${interaction.user.id}>`, true)],
    });

    return true;
  }

  return false;
}

module.exports = { handleParty };
