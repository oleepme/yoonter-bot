// src/party/handler.js
const { InteractionType } = require("discord.js");
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
  buildPartyEmbedFromDb
} = require("./ui");

const { clearTimer } = require("./scheduler");

// ✅ DB를 이제 진짜로 사용
const { upsertParty, getParty, setMemberNote, removeMember, deleteParty, setPartyStatus } = require("../db");

const draft = new Map(); // userId -> { kind, title, note, mode, hh, mm }

// ---- (시간) KST HH:mm -> UTC unix seconds (디스코드 <t:...>에 넣으면 KST로 예쁘게 보임) ----
function kstUnixSecondsFromHHMM(hh, mm) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = Number(parts.find(p => p.type === "year").value);
  const mo = Number(parts.find(p => p.type === "month").value);
  const d = Number(parts.find(p => p.type === "day").value);

  // KST=UTC+9 => UTC로 만들려면 9시간 빼기
  const ms = Date.UTC(y, mo - 1, d, hh - 9, mm, 0);
  return Math.floor(ms / 1000);
}

function getOwnerRoleLabel(member) {
  if (ROLE_NEWBIE_ID && member.roles.cache.has(ROLE_NEWBIE_ID)) return "뉴비";
  if (ROLE_MEMBER_ID && member.roles.cache.has(ROLE_MEMBER_ID)) return "멤버";
  return "";
}

async function syncMessageFromDb(guild, messageId) {
  const p = await getParty(messageId);
  if (!p) return null;

  const board = await guild.channels.fetch(p.channel_id);
  const msg = await board.messages.fetch(p.message_id).catch(() => null);
  if (!msg) return null;

  const embed = buildPartyEmbedFromDb(p);
  await msg.edit({ embeds: [embed], components: [partyActionRow()] });
  return { party: p, msg };
}

async function handleParty(interaction) {
  const guild = interaction.guild;

  // 1) 게시판에서 "새 파티 만들기"
  if (interaction.isButton() && interaction.customId === "party:create") {
    draft.set(interaction.user.id, {});
    await interaction.reply({ content: "카테고리 1을 선택하세요.", components: [kindSelectRow()], ephemeral: true });

    await logEmbed(guild, {
      title: "🧾 파티 생성 시작",
      fields: [field("유저", `<@${interaction.user.id}>`)]
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

  // 3) 게임명/특이사항 입력
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:draft:details") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 [새 파티 만들기]를 눌러주세요.", ephemeral: true });
      return true;
    }

    d.title = safeTrim(interaction.fields.getTextInputValue("title"));
    d.note = safeTrim(interaction.fields.getTextInputValue("note"));
    draft.set(interaction.user.id, d);

    await interaction.reply({ content: "시작 방식을 선택하세요.", components: [timeModeRow()], ephemeral: true });
    return true;
  }

  // 4) 모이면 시작(ASAP)
  if (interaction.isButton() && interaction.customId === "party:draft:asap") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true });
      return true;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const ownerMember = await guild.members.fetch(interaction.user.id);
    const roleLabel = getOwnerRoleLabel(ownerMember);

    const msg = await board.send({
      embeds: [
        // 임시로 비워둔 embed(곧 DB 기준으로 sync함)
        buildPartyEmbedFromDb({
          status: "RECRUIT",
          title: d.title,
          party_note: d.note || "",
          mode: "ASAP",
          start_at: nowUnix(),
          max_players: 4,
          members: [{ user_id: interaction.user.id, note: "" }]
        })
      ],
      components: [partyActionRow()]
    });

    // ✅ DB 저장 (messageId가 주문서의 “키”)
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
      max_players: 4
    });

    // 파티장 자동 참가(1번 슬롯)
    await setMemberNote(msg.id, interaction.user.id, "");

    // DB 기준으로 다시 렌더링해서 edit (항상 한 규칙으로 출력되게)
    await syncMessageFromDb(guild, msg.id);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("역할표기", roleLabel || "(없음)", true),
        field("종류", d.kind, true),
        field("게임", d.title),
        field("모드", "ASAP", true)
      ]
    });

    draft.delete(interaction.user.id);
    return true;
  }

  // 4-2) 시간 지정 시작
  if (interaction.isButton() && interaction.customId === "party:draft:time") {
    await interaction.reply({ content: "시(시간)를 선택하세요.", components: [hourSelectRow("party:draft:hh")], ephemeral: true });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:hh") {
    const d = draft.get(interaction.user.id) ?? {};
    d.hh = Number(interaction.values[0]);
    draft.set(interaction.user.id, d);

    await interaction.reply({ content: "분(5분 단위)을 선택하세요.", components: [minuteSelectRow("party:draft:mm")], ephemeral: true });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "party:draft:mm") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title || typeof d.hh !== "number") {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true });
      return true;
    }

    const mm = Number(interaction.values[0]);

    // ✅ KST 입력을 UTC unix seconds로 변환 (9시간 버그 해결)
    const startAtUnix = kstUnixSecondsFromHHMM(d.hh, mm);

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const ownerMember = await guild.members.fetch(interaction.user.id);
    const roleLabel = getOwnerRoleLabel(ownerMember);

    const msg = await board.send({
      embeds: [
        buildPartyEmbedFromDb({
          status: "RECRUIT",
          title: d.title,
          party_note: d.note || "",
          mode: "TIME",
          start_at: startAtUnix,
          max_players: 4,
          members: [{ user_id: interaction.user.id, note: "" }]
        })
      ],
      components: [partyActionRow()]
    });

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
      max_players: 4
    });

    await setMemberNote(msg.id, interaction.user.id, "");
    await syncMessageFromDb(guild, msg.id);

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });

    await logEmbed(guild, {
      title: "✅ 파티 생성(시간지정)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("역할표기", roleLabel || "(없음)", true),
        field("종류", d.kind, true),
        field("게임", d.title),
        field("시작", `<t:${startAtUnix}:F>`)
      ]
    });

    draft.delete(interaction.user.id);
    return true;
  }

  // 5) 파티 메시지 버튼들 (DB 기준)
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msg = interaction.message;

    // ✅ 이 메시지ID로 DB에서 파티를 찾는다 (footer/meta 절대 안 봄)
    const party = await getParty(msg.id);
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
      const leftCount = after?.members?.length ?? 0;

      // ✅ 전원 이탈 시 자동 종료(주문서 삭제 + DB 삭제)
      if (leftCount === 0) {
        clearTimer(msg.id);

        await deleteParty(msg.id);
        await msg.delete().catch(() => {});

        await interaction.reply({ content: "🧾 전원 이탈로 파티가 자동 종료되었습니다.", ephemeral: true });

        await logEmbed(guild, {
          title: "🧾 파티 자동 종료(전원 이탈)",
          color: 0xe74c3c,
          fields: [field("파티 메시지 ID", msg.id, true)]
        });
        return true;
      }

      // 남아있으면 DB 기준으로 edit
      await syncMessageFromDb(guild, msg.id);
      await interaction.reply({ content: "➖ 나가기 처리 완료", ephemeral: true });

      await logEmbed(guild, {
        title: "➖ 파티 나가기",
        fields: [
          field("파티 메시지 ID", msg.id, true),
          field("유저", `<@${interaction.user.id}>`, true)
        ]
      });
      return true;
    }

    // 종료 (지금은 파티장만)
    if (interaction.customId === "party:end") {
      if (interaction.user.id !== party.owner_id) {
        await interaction.reply({ content: "파티장만 종료할 수 있습니다.", ephemeral: true });
        await logEmbed(guild, {
          title: "🛑 종료 시도(거부)",
          color: 0xe67e22,
          fields: [
            field("파티 메시지 ID", msg.id, true),
            field("시도 유저", `<@${interaction.user.id}>`, true),
            field("파티장", `<@${party.owner_id}>`, true)
          ]
        });
        return true;
      }

      clearTimer(msg.id);

      await setPartyStatus(msg.id, "ENDED");
      await deleteParty(msg.id);
      await msg.delete().catch(() => {});

      await interaction.reply({ content: "🛑 파티를 종료하고 주문서를 삭제했습니다.", ephemeral: true });

      await logEmbed(guild, {
        title: "🛑 파티 종료",
        color: 0xe74c3c,
        fields: [
          field("파티 메시지 ID", msg.id, true),
          field("종료자", `<@${interaction.user.id}>`, true)
        ]
      });
      return true;
    }

    // 시작/시간변경은 다음 단계(정책/권한/자동전환 포함해서 확장)
    await interaction.reply({ content: "이 기능은 다음 단계에서 확장합니다.", ephemeral: true });
    return true;
  }

  // 6) 참가 비고 모달 제출 (DB 기준)
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    const msgId = interaction.customId.split(":")[2];

    const party = await getParty(msgId);
    if (!party) {
      await interaction.reply({ content: "주문서를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const inputNote = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    // ✅ 정원 체크 (새로 참가하는 경우에만)
    const already = (party.members || []).some(m => m.user_id === interaction.user.id);
    if (!already) {
      const max = party.max_players || 4;
      const count = (party.members || []).length;
      if (count >= max) {
        await interaction.reply({ content: "⛔ 파티 정원이 가득 찼습니다.", ephemeral: true });
        return true;
      }
    }

    await setMemberNote(msgId, interaction.user.id, inputNote);

    // DB 기준으로 edit
    await syncMessageFromDb(guild, msgId);

    await interaction.reply({ content: "➕ 참가/비고 반영 완료", ephemeral: true });

    await logEmbed(guild, {
      title: "➕ 파티 참가/비고",
      fields: [
        field("파티 메시지 ID", msgId, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("비고", inputNote || "(없음)")
      ]
    });
    return true;
  }

  return false;
}

module.exports = { handleParty };
