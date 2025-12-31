function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function safeTrim(s) {
  return (s ?? "").toString().trim();
}

module.exports = { nowUnix, safeTrim };
