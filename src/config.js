function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function opt(name, fallback = "") {
  return process.env[name] ?? fallback;
}

module.exports = {
  DISCORD_TOKEN: req("DISCORD_TOKEN"),
  CLIENT_ID: req("CLIENT_ID"),
  GUILD_ID: req("GUILD_ID"),

  PARTY_BOARD_CHANNEL_ID: req("PARTY_BOARD_CHANNEL_ID"),
  SECRET_LOG_CHANNEL_ID: req("SECRET_LOG_CHANNEL_ID"),

  // 역할 표기용 (둘 중 하나 없으면 표기 생략 가능하게 opt)
  ROLE_NEWBIE_ID: opt("ROLE_NEWBIE_ID"),
  ROLE_MEMBER_ID: opt("ROLE_MEMBER_ID"),

  // 닉네임 도움 메시지 채널(선택)
  NICK_HELP_CHANNEL_ID: opt("NICK_HELP_CHANNEL_ID"),

  ENABLE_NICK: (opt("ENABLE_NICK", "true") === "true"),
  ENABLE_PARTY: (opt("ENABLE_PARTY", "true") === "true")
};
