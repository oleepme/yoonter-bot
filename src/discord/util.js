// src/discord/util.js
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function safeTrim(s) {
  return (s ?? "").toString().trim();
}

// 오늘 날짜를 Asia/Seoul 기준으로 YYYY-MM-DD로 가져오기
function seoulTodayYMD() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error("Failed to compute Seoul date parts");
  return `${y}-${m}-${d}`;
}

/**
 * 한국시간(HH:mm)을 "오늘(한국시간)"에 붙여서 Unix seconds 반환
 * - 컨테이너가 UTC여도 안전
 */
function seoulUnixFromHHMM(hh, mm) {
  const ymd = seoulTodayYMD();
  const HH = String(hh).padStart(2, "0");
  const MM = String(mm).padStart(2, "0");

  // +09:00 강제 부여 (KST)
  const iso = `${ymd}T${HH}:${MM}:00+09:00`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${iso}`);
  return Math.floor(ms / 1000);
}

module.exports = { nowUnix, safeTrim, seoulUnixFromHHMM };
