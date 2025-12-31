const { InteractionType } = require("discord.js");
const { PARTY_BOARD_CHANNEL_ID, ROLE_NEWBIE_ID, ROLE_MEMBER_ID } = require("../../config");
const { logEmbed, field } = require("../../discord/log");
const { safeTrim, nowUnix } = require("../../discord/util");
const { parseMeta } = require("./meta");
const {
  kindSelectRow,
  detailsModal,
  timeModeRow,
  hourSelectRow,
  minuteSelectRow,
  partyActionRow,
  joinNoteModal,
  buildPartyEmbed
} = require("./ui");
const { clearTimer } = require("./scheduler");

const draft = new Map(); // userId -> { kind, title, note, mode, hh, mm }

function getOwnerRoleLabel(member) {
  if (ROLE_NEWBIE_ID && member.roles.cache.has(ROLE_NEWBIE_ID)) return "뉴비";
  if (ROLE_MEMBER_ID && member.roles.cache.has(ROLE_MEMBER_ID)) return "멤버";
  return ""; // 없으면 표기 생략
}

function parseMembersFromEmbed(embed) {
  const fields = embed.data?.fields ?? [];
  const membersField = fields.find(f => f.name === "참가자")?.value ?? "";
  return membersField
    .split("\n")
    .filter(l => l.startsWith("- <@"))
    .map(l => {
      const m = l.match(/- <@(\d+)>(?: — (.*))?/);
      if (!m) return null;
      return { userId: m[1], note: (m[2] ?? "").trim() };
    })
    .filter(Boolean);
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

  // 3) 카테고리2/3 입력
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "party:draft:details") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 [새 파티 만들기]를 눌러주세요.", ephemeral: true });
      return true;
    }
    d.title = safeTrim(interaction.fields.getTextInputValue("title"));
    d.note = safeTrim(interaction.fields.getTextInputValue("note"));
    draft.set(interaction.user.id, d);

    await interaction.reply({ content: "카테고리 4: 시작 방식 선택", components: [timeModeRow()], ephemeral: true });
    return true;
  }

  // 4) 모이면 시작
  if (interaction.isButton() && interaction.customId === "party:draft:asap") {
    const d = draft.get(interaction.user.id);
    if (!d?.kind || !d?.title) {
      await interaction.reply({ content: "세션이 만료되었습니다. 다시 만들어주세요.", ephemeral: true });
      return true;
    }

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const ownerMember = await guild.members.fetch(interaction.user.id);
    const roleLabel = getOwnerRoleLabel(ownerMember);

    const embed = buildPartyEmbed({
      ownerId: interaction.user.id,
      ownerRoleLabel: roleLabel,
      kind: d.kind,
      title: d.title,
      note: d.note,
      mode: "ASAP",
      startAtUnix: nowUnix(),
      status: "RECRUIT",
      members: [{ userId: interaction.user.id, note: "" }]
    });

    const msg = await board.send({ embeds: [embed], components: [partyActionRow()] });

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });
    await logEmbed(guild, {
      title: "✅ 파티 생성",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("역할표기", roleLabel || "(없음)", true),
        field("종류", d.kind, true),
        field("제목", d.title),
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

    const start = new Date();
    start.setSeconds(0, 0);
    start.setHours(d.hh, mm, 0, 0);
    const startAtUnix = Math.floor(start.getTime() / 1000);

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const ownerMember = await guild.members.fetch(interaction.user.id);
    const roleLabel = getOwnerRoleLabel(ownerMember);

    const embed = buildPartyEmbed({
      ownerId: interaction.user.id,
      ownerRoleLabel: roleLabel,
      kind: d.kind,
      title: d.title,
      note: d.note,
      mode: "TIME",
      startAtUnix,
      status: "RECRUIT",
      members: [{ userId: interaction.user.id, note: "" }]
    });

    const msg = await board.send({ embeds: [embed], components: [partyActionRow()] });

    await interaction.reply({ content: "✅ 파티가 생성되었습니다. 게시판을 확인하세요.", ephemeral: true });
    await logEmbed(guild, {
      title: "✅ 파티 생성(시간지정)",
      color: 0x2ecc71,
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("역할표기", roleLabel || "(없음)", true),
        field("종류", d.kind, true),
        field("제목", d.title),
        field("시작", `<t:${startAtUnix}:F>`)
      ]
    });

    draft.delete(interaction.user.id);
    return true;
  }

  // 5) 파티 메시지 버튼들
  if (interaction.isButton() && interaction.customId.startsWith("party:")) {
    const msg = interaction.message;
    const embed = msg.embeds?.[0];
    const meta = parseMeta(embed?.footer?.text);
    if (!meta) {
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
      const rebuilt = require("discord.js").EmbedBuilder.from(embed);
      const members = parseMembersFromEmbed(rebuilt).filter(m => m.userId !== interaction.user.id);

      const newEmbed = require("discord.js").EmbedBuilder.from(embed);
      // 참가자 필드만 갱신(간단 처리)
      const fields = newEmbed.data.fields ?? [];
      const idx = fields.findIndex(f => f.name === "참가자");
      const memberLines = members.length
        ? members.map(m => `- <@${m.userId}>${m.note ? ` — ${m.note}` : ""}`).join("\n")
        : "- (없음)";

      if (idx >= 0) fields[idx].value = memberLines;
      newEmbed.setFields(fields);

      await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
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

    // 종료(파티장만 하게 만들 수도 있지만, 지금은 “깔끔” 우선으로 owner만)
    if (interaction.customId === "party:end") {
      if (interaction.user.id !== meta.owner) {
        await interaction.reply({ content: "파티장만 종료할 수 있습니다.", ephemeral: true });
        await logEmbed(guild, {
          title: "🛑 종료 시도(거부)",
          color: 0xe67e22,
          fields: [
            field("파티 메시지 ID", msg.id, true),
            field("시도 유저", `<@${interaction.user.id}>`, true),
            field("파티장", `<@${meta.owner}>`, true)
          ]
        });
        return true;
      }

      clearTimer(msg.id);
      await interaction.reply({ content: "🛑 파티를 종료하고 주문서를 삭제합니다.", ephemeral: true });

      await logEmbed(guild, {
        title: "🛑 파티 종료",
        color: 0xe74c3c,
        fields: [
          field("파티 메시지 ID", msg.id, true),
          field("종료자", `<@${interaction.user.id}>`, true)
        ]
      });

      await msg.delete().catch(() => {});
      return true;
    }

    // 시작/시간변경/자동전환은 다음 단계에서 확장
    await interaction.reply({ content: "이 기능은 다음 단계에서 확장합니다.", ephemeral: true });
    return true;
  }

  // 6) 참가 비고 모달 제출
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("party:joinnote:")) {
    const msgId = interaction.customId.split(":")[2];

    const board = await guild.channels.fetch(PARTY_BOARD_CHANNEL_ID);
    const msg = await board.messages.fetch(msgId).catch(() => null);
    if (!msg) {
      await interaction.reply({ content: "주문서를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const embed = msg.embeds?.[0];
    const meta = parseMeta(embed?.footer?.text);
    if (!meta) {
      await interaction.reply({ content: "주문서 메타를 찾지 못했습니다.", ephemeral: true });
      return true;
    }

    const rebuilt = require("discord.js").EmbedBuilder.from(embed);
    const members = parseMembersFromEmbed(rebuilt);

    const inputNote = safeTrim(interaction.fields.getTextInputValue("note")).slice(0, 80);

    const idx = members.findIndex(m => m.userId === interaction.user.id);
    if (idx >= 0) members[idx].note = inputNote;
    else members.push({ userId: interaction.user.id, note: inputNote });

    // 참가자 필드만 갱신
    const newEmbed = require("discord.js").EmbedBuilder.from(embed);
    const fields = newEmbed.data.fields ?? [];
    const fidx = fields.findIndex(f => f.name === "참가자");
    const memberLines = members.map(m => `- <@${m.userId}>${m.note ? ` — ${m.note}` : ""}`).join("\n");
    if (fidx >= 0) fields[fidx].value = memberLines;
    newEmbed.setFields(fields);

    await msg.edit({ embeds: [newEmbed], components: [partyActionRow()] });
    await interaction.reply({ content: "➕ 참가/비고 반영 완료", ephemeral: true });

    await logEmbed(guild, {
      title: "➕ 파티 참가/비고",
      fields: [
        field("파티 메시지 ID", msg.id, true),
        field("유저", `<@${interaction.user.id}>`, true),
        field("비고", inputNote || "(없음)")
      ]
    });
    return true;
  }

  return false;
}

module.exports = { handleParty };
