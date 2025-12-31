const { PermissionsBitField, InteractionType } = require("discord.js");
const { logEmbed, field } = require("../../discord/log");
const { safeTrim } = require("../../discord/util");
const { buildNicknameModal } = require("./ui");

async function handleNickname(interaction) {
  // 버튼 → 모달 오픈
  if (interaction.isButton() && interaction.customId === "nick:open") {
    await interaction.showModal(buildNicknameModal());
    return true;
  }

  // 모달 제출 → 닉네임 변경 + 로그
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "nick:submit") {
    const raw = safeTrim(interaction.fields.getTextInputValue("nick:value"));
    const guild = interaction.guild;

    const before = interaction.member?.nickname ?? interaction.user.username;

    // 봇 권한 체크(필수)
    const botMember = guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
      await interaction.reply({ content: "봇에 Manage Nicknames 권한이 없어 닉네임 변경이 불가합니다.", ephemeral: true });
      await logEmbed(guild, {
        title: "🪪 닉네임 변경 실패",
        color: 0xe74c3c,
        fields: [
          field("유저", `<@${interaction.user.id}>`),
          field("이전", before, true),
          field("시도", raw, true),
          field("사유", "봇 권한 부족(Manage Nicknames)")
        ]
      });
      return true;
    }

    try {
      await interaction.member.setNickname(raw);
      await interaction.reply({ content: `✅ 닉네임이 **${raw}**(으)로 변경되었습니다.`, ephemeral: true });

      await logEmbed(guild, {
        title: "🪪 닉네임 변경",
        color: 0x2ecc71,
        fields: [
          field("유저", `<@${interaction.user.id}>`),
          field("이전 → 이후", `${before} → ${raw}`),
          field("결과", "성공")
        ]
      });
    } catch (e) {
      await interaction.reply({ content: "⚠️ 닉네임 변경에 실패했습니다. (역할 위치/권한 가능성)", ephemeral: true });

      await logEmbed(guild, {
        title: "🪪 닉네임 변경 실패",
        color: 0xe74c3c,
        fields: [
          field("유저", `<@${interaction.user.id}>`),
          field("이전", before, true),
          field("시도", raw, true),
          field("사유", e?.message ?? "unknown")
        ]
      });
    }
    return true;
  }

  return false;
}

module.exports = { handleNickname };


