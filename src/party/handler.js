// src/party/handler.js
const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID, ROLE_NEWBIE_ID, ROLE_MEMBER_ID, SECRET_LOG_CHANNEL_ID } = require("../config");
const { logEmbed, field } = require("../discord/log");
const { safeTrim, nowUnix } = require("../discord/util");

const { parseMeta } = require("./meta"); // (임시 호환용)
const {
  createPartyModal,
  joinNoteModal,
  timeChangeModal,
  partyActionRow,
  buildPartyEmbedFromDb
} = require("./ui");

const {
  upsertParty,
  getParty,
  setPartyStatus,
  updatePartyTime,
  setMemberNote,
  removeMember,
  deleteParty,
  listDueParties,
} = require("../db");

// ---- KST HH:mm -> UTC unix seconds ----
function kstUnixSecondsFromHHMM(hhmm) {
  const t = (hhmm || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = Number(parts.find(p => p.type === "year").value);
  const mo = Number(parts.find(p => p.type === "month").value);
  const d = Number(parts.find(p => p.type === "day").value);

  const ms = Date.UTC(y, mo - 1, d, hh - 9, mm, 0); // KST=UTC+9
  return Math.floor(ms / 1000);
}

function getOwnerRoleLabel(member) {
  if (ROLE_NEWBIE_ID && member.roles.cache.has(ROLE_NEWBIE_ID)) return "뉴비";
  if (ROLE_MEMBER_ID && member.roles.cache.has(ROLE_MEMBER_ID)) return "멤버";
  return "";
}

// (임시 호환) 예전 주문서(DDG footer 기반)를 DB로 끌어오는 함수
async function tryAdoptLegacyOrder(message) {
  const embed = message.embeds?.[0];
  const meta = parseMeta(embed?.footer?.text);
  if (!meta) return null;

  // 최소 정보만 DB에 등록해서 버튼이 동작하게 만들기
  const titleField = embed?.data?.description || "";
  const title = titleField.replace(/^🎯\s*\*\*|\*\*$/g, "").trim() || "Unknown";

  const mode = meta.mode === "ASAP" ? "ASAP" : "TIME";
  const startAt = Number(meta.startAt || nowUnix());
  const status = meta.status === "PLAYING" ? "PLAYING" : "RECRUIT";

  await upsertParty({
    message_id: message.id,
    channel_id: message.channel.id,
    guild_id: message.guild.id,
    owner_id: meta.owner,
    kind: meta.kind || "게임",
    title,
    party_note: "",
    mode,
    start_at: startAt,
    status,
    max_players: 4,
  });

  // 멤버 목록도 예전 embed에서 대충이라도 복원
  // (완벽하진 않아도 버튼이 “주문서 아닙니다”로 막히는 것보단 낫다)
  const fields = embed?.data?.fields || [];
  const memField = fields.find(f => f.name === "참가자")?.value || "";
  const ids = [...memField.matchAll(/<@(\d+)>/g)].map(x => x[1]);
  for (const uid of ids.slice(0, 4)) {
    await setMemberNote(message.id, uid, "");
  }

  return await getParty(message.id);
}

async function syncOrderMessage(guild, messageId) {
  const party = await getParty(messageId);
  if (!party) return null;

  const ch = await guild.channels.fetch(party.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return null;

  const msg = await ch.messages.fetch(party.message_id).catch(() => null);
  if (!msg) return null;

  const embed = buildPartyEmbedFromDb(party);
  await msg.edit({ embeds: [embed], components: [partyActionRow()] });
  return party;
}

// 30초마다 돌릴 “자동 상태 전환”
async function runPartyTick(client) {
  const now = nowUnix();
  const due = await listDueParties(now);
  for (const messageId of due) {
    const party = await getParty(messageId);
    if (!party) continue;

    await setPartyStatus(messageId, "PLAYING");

    const guild = await client.guilds.fetch(party.guild_id).catch(() => null);
    if (!guild) continue;

    await syncOrderMessage(guild, messageId);

    await logEmbed(guild, {
      title: "⏱️ 자동 상태 전환",
      fields: [
        field("파티 메시지 ID", messageId, true),
        field("변경", "모집중 → 플레이중", true),
        field("시각", `<t:${Number(party.start_at)}:F>`, true),
      ],
    });
  }
}

async function handleParty(interaction) {
  const guild = interaction.guild;

  // 1) 새 파티 만들기: 버튼 누르면 “모달 1개”만 띄운다 (메시지 누적 제거)
  if (interaction.isButton() && interaction.customId === "party:create") {
    await interaction.showModal(createPartyModal());
    return true;
  }

  // 2) 새 파티 만들기 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:create:modal") {
    const title = safeTrim(interaction.fields.getTextInputValue("title"));
    const partyNote = safeTrim(interaction.fields.getTextInputValue("party_note"));
    const hhmm = safeTrim(interaction.fields.getTextInputValue("start_hhmm"));
    const maxRaw = safeTrim(interaction.fields.getTextInputValue("max_players"));

    const maxPlayers = (() => {
      const n = Number(maxRaw || "4");
      if (!Number.isFinite(n) || n < 2 || n > 10) return 4;
      return Math.floor(n);
    })();

    // 시간 입력이 비어있으면 모바시(ASAP)
    let mode = "ASAP";
    let startAt = nowUnix();
    if (hhmm) {
      const unix = kstUnixSecondsFromHHMM(hhmm);
      if (!unix) {
        await interaction.reply({ content: "시간 형식이 올바르지 않습니다. 예: 14:05", ephemeral: true });
        return true;
      }
      mode = "TIME";
      startAt = unix;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.reply({ content: "파티 게시판 채널을 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    // 먼저 메시지를 만들고, 그 message.id를 DB 키로 저장
    const tempEmbed = buildPartyEmbedFromDb({
      status: "RECRUIT",
      title,
      party_note: partyNote,
      mode,
      start_at: startAt,
      max_players: maxPlayers,
      members: [{ user_id: interaction.user.id, note: "" }],
    });

    const msg = await board.send({ embeds: [tempEmbed], components: [partyActionRow()] });

    await upsertParty({
      message_id: msg.id,
      channel_id: msg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: "게임",
      title,
      party_note: partyNote || "",
      mode,
      start_at: startAt,
      status: "RECRUIT",
      max_players: maxPlayers,
    });

    // 파티장 자동 참가
    await setMemberNote(msg.id, interaction.user.id, "");

    // DB 기준으로 다시 렌더(edit)
    await syncOrderMessage(guild, msg.id);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성",
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("파티장", `<@${interaction.user.id}>`, true),
        field("게임", title),
        field("모드", mode, true),
        field("시작", mode === "TIME" ? `<t:${startAt}:F>` : "모바시", true),
      ],
    });

    return true;
  }

  // 3) 파티 버튼들: 이제는 “DB에서 message.id로 찾기”
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msg = interaction.message;

    let party = await getParty(msg.id);
    if (!party) {
      // 예전 주문서 호환(임시)
      party = await tryAdoptLegacyOrder(msg);
    }
    if (!party) {
      await interaction.reply({ content: "이 메시지는 파티 주문서가 아닙니다.", ephemeral: true });
      return true;
    }

    // 참가/비고
    if (interaction.customId === "party:join") {
      await interaction.showModal(joinNoteModal(msg.id));
      return true;
    }

    // 나가기
    if (interaction.customId === "party:leave") {
      await removeMember(msg.id, interaction.user.id);

      const after = await getParty(msg.id);
      const left = after?.members?.length ?? 0;

      if (left === 0) {
        await deleteParty(msg.id);
        await msg.delete().catch(() => {});
        await interaction.reply({ content: "🧾 전원 이탈로 파티가 자동 종료되었습니다.", ephemeral: true });

        await logEmbed(guild, {
          title: "🧾 파티 자동 종료(전원 이탈)",
          fields: [field("파티 메시지 ID", msg.id, true)],
        });
        return true;
      }

      await syncOrderMessage(guild, msg.id);
      await interaction.reply({ content: "➖ 나가기 처리 완료", ephemeral: true });
      return true;
    }

    // 시간 변경: 파티장만
    if (interaction.customId === "party:time") {
      if (interaction.user.id !== party.owner_id) {
        await interaction.reply({ content: "파티장만 시간 변경이 가능합니다.", ephemeral: true });
        return true;
      }
      await interaction.showModal(timeChangeModal(msg.id));
      return true;
    }

    // 시작: 파티원도 가능(요구사항)
    if (interaction.customId === "party:start") {
      await setPartyStatus(msg.id, "PLAYING");
      await syncOrderMessage(guild, msg.id);
      await interaction.reply({ content: "🟢 플레이중으로 전환했습니다.", ephemeral: true });
      return true;
    }

    // 종료: 파티원도 가능(요구사항)
    if (interaction.customId === "party:end") {
      await setPartyStatus(msg.id, "ENDED");
      await deleteParty(msg.id);
      await msg.delete().catch(() => {});
      await interaction.reply({ content: "🛑 파티를 종료하고 주문서를 삭제했습니다.", ephemeral: true });
      return true;
    }

    await interaction.reply({ content: "처리되지 않은 버튼입니다.", ephemeral: true });
    return true;
  }

  // 4) 참가 비고 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    const msgId = interaction.customId.split(":")[2];
    const party = await getParty(msgId);

    if (!party) {
      await interaction.reply({ content: "주문서를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const note = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    // 정원 체크 (신규 참가 시)
    const already = (party.members || []).some(m => m.user_id === interaction.user.id);
    if (!already) {
      const max = Number(party.max_players || 4);
      const count = (party.members || []).length;
      if (count >= max) {
        await interaction.reply({ content: "⛔ 파티 정원이 가득 찼습니다.", ephemeral: true });
        return true;
      }
    }

    await setMemberNote(msgId, interaction.user.id, note);
    await syncOrderMessage(guild, msgId);

    await interaction.reply({ content: "✅ 참가/비고 반영 완료", ephemeral: true });
    return true;
  }

  // 5) 시간 변경 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:timechange:")) {
    const msgId = interaction.customId.split(":")[2];
    const party = await getParty(msgId);

    if (!party) {
      await interaction.reply({ content: "주문서를 찾지 못했습니다.", ephemeral: true });
      return true;
    }
    if (interaction.user.id !== party.owner_id) {
      await interaction.reply({ content: "파티장만 시간 변경이 가능합니다.", ephemeral: true });
      return true;
    }

    const hhmm = safeTrim(interaction.fields.getTextInputValue("start_hhmm"));
    const unix = kstUnixSecondsFromHHMM(hhmm);
    if (!unix) {
      await interaction.reply({ content: "시간 형식이 올바르지 않습니다. 예: 14:05", ephemeral: true });
      return true;
    }

    await updatePartyTime(msgId, unix);
    await syncOrderMessage(guild, msgId);
    await interaction.reply({ content: "🕒 시간 변경 완료", ephemeral: true });
    return true;
  }

  return false;
}

module.exports = {
  handleParty,
  runPartyTick,
  syncOrderMessage,
};
