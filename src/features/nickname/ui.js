const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

function nicknameBoardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("nick:open").setLabel("닉네임 설정").setStyle(ButtonStyle.Primary)
    )
  ];
}

function buildNicknameModal() {
  const modal = new ModalBuilder().setCustomId("nick:submit").setTitle("닉네임 설정");
  const input = new TextInputBuilder()
    .setCustomId("nick:value")
    .setLabel("변경할 닉네임")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

module.exports = { nicknameBoardComponents, buildNicknameModal };
