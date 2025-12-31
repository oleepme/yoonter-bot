// src/party/handler.js
const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID } = require("../config");
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

const {
  upsertParty,
  getParty,
  setMemberNote,
  removeMember,
  deleteParty,
} = require("../db");

/**
 * Draft: userId -> { kind, title, note, mode, hh, mm }
 * - 여기서는 “메시지 누적” 방지를 위해 reply 1회 + update/editReply 위주로 운영
 */
const draft = new Map();

function statusText(status) {
  if (status === "PLAYING") return "플레이중";
  if (status === "ENDED") return "종료";
  return "모집중";
}

function formatTimeField(mode, startAtUnix) {
  if (mode === "ASAP") return "⚡ 모이면 바로 시작";
  return `🕒 <t:${startAtUnix}:t> ( <t:${startAtUnix}:R> )`;
}

function buildParticipantsLines(maxPlayers, members) {
  const slots = [];
  const m = Array.isArray(members) ? members : [];

  for (let i = 0; i < maxPlayers; i++) {
    const mm = m[i];
    if (!mm) {
      slots.push(`${i + 1}.`);
      continue;
    }
    const note = (mm.note ?? "").trim();
    slots.push(`${i + 1}. <@${mm.user_id}>${note ? ` — ${note}` : ""}`);
  }
  return slots.join("\n");
}

/**
 * 요구된 “고정 레이아웃”에 맞춰 임베드를 새로 만든다.
 * - footer/meta 사용 안 함
 * - status/게임명/특이사항/시간/참가자 슬롯 고정
 */
function buildPartyEmbedFromDbRow(partyRow, membersRows) {
  const statusLine = `**상태: ${statusText(partyRow.status)}**`;
  const gameLine = `🎮 **${partyRow.title}**`; // title을 “게임 이름(카테고리2)”로 사용 중

  const partyNote = (partyRow.party_note ?? "").trim() || "(없음)";
  const timeLine = formatTimeField(partyRow.mode, Number(partyRow.start_at));

  const maxPlayers = Number(partyRow.max_players) || 4;
  const participants = buildParticipantsLines(maxPlayers, membersRows);

  // “1행(2칸) + 2행(1칸)” 느낌을 fields로 구현
  return {
    title: `${statusLine}\n${gameLine}`,
    fields: [
      { name: "주문서 특이사항", value: partyNote, inline: true },
      { name: "시간", value: timeLine, inline: true },
      { name: "참가자 목록", value: participants || "1.\n2.\n3.\n4.", inline: false },
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

  const embedData = buildPartyEmbedFromDbRow(party, party.members);

  // 종료 상태면 버튼 제거(components: [])
  const components = party.status === "ENDED" ? [] : [partyActionRow()];

  await msg.edit({
    embeds: [
      {
        color: party.status === "PLAYING" ? 0x2ecc71 : party.status === "ENDED" ? 0x95a5a6 : 0xe74c3c,
        title: embedData.title,
        fields: embedData.fields,
      },
    ],
    components,
  });

  return { msg, party };
}

function canEndParty(partyRow, userId, memberIsAdmin) {
  // 정책: 파티원도 종료 가능(요구사항)
  // DB에 파티원 목록이 있으니 “파티에 속한 유저”면 OK
  // 여기서는 memberIsAdmin true면 무조건 OK
  if (memberIsAdmin) return true;
  if (partyRow.owner_id === userId) return true;
  return false;
}

async function handleParty(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // (옵션) 운영진 권한: 환경변수로만 받는다(없으면 무시)
  const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";
  const memberIsAdmin =
    ADMIN_ROLE_ID &&
    interaction.member &&
    interaction.member.roles &&
    interaction.member.roles.cache &&
    interaction.member.roles.cache.has(ADMIN_ROLE_ID);

  // 1) 게시판 "새 파티 만들기"
  if (interaction.isButton() && interaction.customId === "party:create") {
    draft.set(interaction.user.id, {});
    await interaction.reply({
      content: "카테고리 1을 선택하세요.",
      components: [kindSelectRow()],
      ephemeral: true,
    });

    await logEmbed(guild, {
      title: "🧾 파티 생성 시작",
      fields: [field("유저", `<@${interaction.user.id}>`)],
    });
    return true;
  }

  // 2) 카테고리1 선택(SelectMenu) → 모달 오픈
  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:kind") {
    const d = draft.get(interaction.user.id) ?? {};
    d.kind = interaction.values[0];
    draft.set(interaction.user.id, d);

    // select 응답은 update로 깔끔하게 처리
    await interaction.update({ content: "정보 입력 모달을 띄웁니다.", components: [] });
    await interaction.showModal(detailsModal());
    return true;
  }

  // 3) 카테고리2/3 입력 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:draft:details") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 [새 파티 만들기]를 눌러주세요.", ephemeral: true });
      return true;
    }

    d.title = safeTrim(interaction.fields.getTextInputValue("title"));
    d.note = safeTrim(interaction.fields.getTextInputValue("note"));
    draft.set(interaction.user.id, d);

    // 모달 제출은 reply 1회, 이후는 버튼 update/editReply로 운영
    await interaction.reply({
      content: "카테고리 4: 시작 방식을 선택하세요.",
      components: [timeModeRow()],
      ephemeral: true,
    });
    return true;
  }

  // 4) 모이면 시작
  if (interaction.isButton() && interaction.customId === "party:draft:asap") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title) {
      await interaction.update?.({ content: "세션이 만료되었습니다. 다시 만들어주세요.", components: [] }).catch(() => {});
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true }).catch(() => {});
      return true;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.update?.({ content: "게시판 채널을 찾지 못했습니다.", components: [] }).catch(() => {});
      await interaction.reply({ content: "게시판 채널을 찾지 못했습니다.", ephemeral: true }).catch(() => {});
      return true;
    }

    const startAtUnix = nowUnix();
    const maxPlayers = 4; // 4순위에서 “최대 인원 선택” 추가 예정

    // 먼저 “빈 메시지” 하나 만들고 messageId 확보
    const tempMsg = await board.send({ content: "주문서 생성 중..." });

    // DB 저장(단일 진실)
    await upsertParty({
      message_id: tempMsg.id,
      channel_id: tempMsg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: d.kind,
      title: d.title,
      party_note: d.note,
      mode: "ASAP",
      start_at: startAtUnix,
      status: "RECRUIT",
      max_players: maxPlayers,
    });

    // 파티장은 자동 참가(1번 슬롯)
    await setMemberNote(tempMsg.id, interaction.user.id, "");

    // 메시지 갱신
    await refreshMessageFromDb(guild, tempMsg.channel.id, tempMsg.id);

    await interaction.update?.({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", components: [] }).catch(() => {});
    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true }).catch(() => {});

    await logEmbed(guild, {
      title: "✅ 파티 생성(ASAP)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", tempMsg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("종류", d.kind, true),
        field("게임/종류", d.title),
        field("모드", "ASAP", true),
        field("최대인원", String(maxPlayers), true),
      ],
    });

    draft.delete(interaction.user.id);
    return true;
  }

  // 4-2) 시간 지정 시작
  if (interaction.isButton() && interaction.customId === "party:draft:time") {
    await interaction.update?.({
      content: "시(시간)를 선택하세요.",
      components: [hourSelectRow("party:draft:hh")],
    }).catch(async () => {
      // update가 실패하면 reply로 fallback
      await interaction.reply({
        content: "시(시간)를 선택하세요.",
        components: [hourSelectRow("party:draft:hh")],
        ephemeral: true,
      });
    });
    return true;
  }

  // 시 선택
  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:hh") {
    const d = draft.get(interaction.user.id) ?? {};
    d.hh = Number(interaction.values[0]);
    draft.set(interaction.user.id, d);

    await interaction.update({
      content: "분(5분 단위)을 선택하세요.",
      components: [minuteSelectRow("party:draft:mm")],
    });
    return true;
  }

  // 분 선택 → 파티 생성
  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:mm") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title || typeof d.hh !== "number") {
      await interaction.update({ content: "세션이 만료되었습니다. 다시 만들어주세요.", components: [] }).catch(() => {});
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true }).catch(() => {});
      return true;
    }

    const mm = Number(interaction.values[0]);

    const start = new Date();
    start.setSeconds(0, 0);
    start.setHours(d.hh, mm, 0, 0);
    const startAtUnix = Math.floor(start.getTime() / 1000);

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID).catch(() => null);
    if (!board?.isTextBased()) {
      await interaction.update({ content: "게시판 채널을 찾지 못했습니다.", components: [] }).catch(() => {});
      await interaction.reply({ content: "게시판 채널을 찾지 못했습니다.", ephemeral: true }).catch(() => {});
      return true;
    }

    const maxPlayers = 4;

    const tempMsg = await board.send({ content: "주문서 생성 중..." });

    await upsertParty({
      message_id: tempMsg.id,
      channel_id: tempMsg.channel.id,
      guild_id: guild.id,
      owner_id: interaction.user.id,
      kind: d.kind,
      title: d.title,
      party_note: d.note,
      mode: "TIME",
      start_at: startAtUnix,
      status: "RECRUIT",
      max_players: maxPlayers,
    });

    await setMemberNote(tempMsg.id, interaction.user.id, "");

    await refreshMessageFromDb(guild, tempMsg.channel.id, tempMsg.id);

    await interaction.update({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", components: [] }).catch(() => {});
    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true }).catch(() => {});

    await logEmbed(guild, {
      title: "✅ 파티 생성(시간지정)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", tempMsg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("종류", d.kind, true),
        field("게임/종류", d.title),
        field("시작", `<t:${startAtUnix}:F>`),
        field("최대인원", String(maxPlayers), true),
      ],
    });

    draft.delete(interaction.user.id);
    return true;
  }

  /**
   * 5) 파티 메시지 버튼들(참가/나가기/시작/종료/시간변경)
   * - footer/meta 절대 사용하지 않고, message.id로 DB를 조회한다.
   */
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msg = interaction.message;
    const msgId = msg?.id;
    const chId = msg?.channel?.id;

    if (!msgId || !chId) {
      await interaction.reply({ content: "메시지 정보를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "이 메시지는 DB에 등록된 파티가 아닙니다.", ephemeral: true });
      return true;
    }

    // 종료된 파티는 조작 불가
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

      // 멤버 0명이면 자동 종료: ENDED로 표시하고 버튼 제거 후 DB 삭제
      const after = await getParty(msgId);
      if (!after || (after.members?.length ?? 0) === 0) {
        await upsertParty({ ...party, status: "ENDED" });
        await refreshMessageFromDb(guild, chId, msgId);

        // 종료 처리 후 DB 정리(원하면 ENDED 보존으로 변경 가능)
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

      await interaction.reply({ content: "➖ 나가기 처리 완료", ephemeral: true });

      await logEmbed(guild, {
        title: "➖ 파티 나가기",
        fields: [field("파티 메시지 ID", msgId, true), field("유저", `<@${interaction.user.id}>`, true)],
      });
      return true;
    }

    // 시작(일단 상태 PLAYING으로 전환)
    if (interaction.customId === "party:start") {
      await upsertParty({ ...party, status: "PLAYING" });
      await refreshMessageFromDb(guild, chId, msgId);

      await interaction.reply({ content: "🟢 파티 상태를 플레이중으로 변경했습니다.", ephemeral: true });

      await logEmbed(guild, {
        title: "🟢 파티 시작",
        color: 0x2ecc71,
        fields: [
          field("파티 메시지 ID", msgId, true),
          field("처리자", `<@${interaction.user.id}>`, true),
        ],
      });
      return true;
    }

    // 시간 변경(2순위 이후에 정리. 지금은 “다음 단계” 안내만)
    if (interaction.customId === "party:time") {
      await interaction.reply({ content: "시간 변경 UX는 다음 단계에서 모달로 정리합니다.", ephemeral: true });
      return true;
    }

    // 종료: 권한 없어서 삭제하지 않고 “종료 고정(버튼 제거)”로 처리
    if (interaction.customId === "party:end") {
      // 정책상 파티원도 종료 가능. DB 멤버인지 확인.
      const memberIds = (party.members ?? []).map(m => m.user_id);
      const isMember = memberIds.includes(interaction.user.id);

      if (!canEndParty(party, interaction.user.id, memberIsAdmin) && !isMember) {
        await interaction.reply({ content: "파티장/파티원/운영진만 종료할 수 있습니다.", ephemeral: true });
        return true;
      }

      await upsertParty({ ...party, status: "ENDED" });
      await refreshMessageFromDb(guild, chId, msgId);

      // DB는 삭제(원하면 ENDED 보존으로 변경 가능)
      await deleteParty(msgId);

      await interaction.reply({ content: "⚫ 파티를 종료했습니다. (메시지는 남고, 버튼은 제거됩니다)", ephemeral: true });

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

  /**
   * 6) 참가 비고 모달 제출
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

    // 최대 길이 제한(운영 안전)
    const inputNote = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    // 정원 체크(슬롯 고정은 4순위에서 강화하지만, 지금도 안전장치만 둠)
    const memberCount = party.members?.length ?? 0;
    const exists = party.members?.some(m => m.user_id === interaction.user.id);
    const maxPlayers = Number(party.max_players) || 4;

    if (!exists && memberCount >= maxPlayers) {
      await interaction.reply({ content: `이미 정원이 찼습니다. (최대 ${maxPlayers}명)`, ephemeral: true });
      return true;
    }

    await setMemberNote(msgId, interaction.user.id, inputNote);

    // 화면 반영
    await refreshMessageFromDb(guild, party.channel_id, msgId);

    await interaction.reply({ content: "➕ 참가/비고 반영 완료", ephemeral: true });

    await logEmbed(guild, {
      title: "➕ 파티 참가/비고",
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("비고", inputNote || "(없음)"),
      ],
    });
    return true;
  }

  return false;
}

module.exports = { handleParty };
