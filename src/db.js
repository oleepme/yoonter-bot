// src/discord/util.js
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function safeTrim(s) {
  return (s ?? "").toString().trim();
}

// 오늘 날짜를 Asia/Seoul 기준 YYYY-MM-DD로 반환
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
 * 한국시간(HH:mm)을 오늘(한국시간)에 붙여 Unix seconds로 변환
 * - 컨테이너가 UTC여도 안전
 */
function seoulUnixFromHHMM(hh, mm) {
  const ymd = seoulTodayYMD();
  const HH = String(hh).padStart(2, "0");
  const MM = String(mm).padStart(2, "0");
  const iso = `${ymd}T${HH}:${MM}:00+09:00`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${iso}`);
  return Math.floor(ms / 1000);
}

/**
 * 자연어 시간 입력을 KST 기준 Unix로 변환
 * - 빈 문자열이면 null 반환(=모바시)
 * 지원:
 *  - "15:55", "03:10"
 *  - "오전3시", "오후3시", "저녁3시", "밤11시", "새벽1시"
 *  - "오후3시10분", "밤 11시 30분"
 *  - "정오"(12:00), "자정"(00:00)
 */
function parseKoreanTimeToUnix(input) {
  const s0 = safeTrim(input);
  if (!s0) return null;

  const s = s0.replace(/\s+/g, "");

  if (s === "정오") return seoulUnixFromHHMM(12, 0);
  if (s === "자정") return seoulUnixFromHHMM(0, 0);

  // HH:mm
  const m1 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m1) {
    const hh = Number(m1[1]);
    const mm = Number(m1[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return { ok: false, reason: "시간 범위가 올바르지 않습니다. (00:00~23:59)" };
    return seoulUnixFromHHMM(hh, mm);
  }

  // (오전|오후|저녁|밤|새벽)?(\d{1,2})시( (\d{1,2})분 )?
  const m2 = s.match(/^(오전|오후|저녁|밤|새벽)?(\d{1,2})시(?:(\d{1,2})분)?$/);
  if (m2) {
    const tag = m2[1] || "";        // 오전/오후/저녁/밤/새벽 or ""
    let hh = Number(m2[2]);
    const mm = m2[3] ? Number(m2[3]) : 0;

    if (hh < 0 || hh > 12) return { ok: false, reason: "시(hour)는 1~12 범위로 입력하세요. 예: 오후3시, 밤11시" };
    if (mm < 0 || mm > 59) return { ok: false, reason: "분(minute)은 0~59 범위입니다." };

    // 오전/새벽: AM, 오후/저녁/밤: PM
    const isPM = (tag === "오후" || tag === "저녁" || tag === "밤");
    const isAM = (tag === "오전" || tag === "새벽");

    // 12시 처리: AM 12시는 0시, PM 12시는 12시
    if (isAM) {
      if (hh === 12) hh = 0;
    } else if (isPM) {
      if (hh !== 12) hh += 12;
    } else {
      // 태그 없으면: 0~23 입력 대신 “시”로 들어왔으니 애매함
      // 안전하게 그대로(3시=03:00)로 둔다. 사용자는 "오후"를 붙이면 됨.
      if (hh === 12) hh = 12;
    }

    return seoulUnixFromHHMM(hh, mm);
  }

  return { ok: false, reason: "시간 형식이 인식되지 않습니다. 예: 15:55 / 오후3시 / 저녁9시30분 / 정오 / 자정" };
}

module.exports = { nowUnix, safeTrim, seoulUnixFromHHMM, parseKoreanTimeToUnix };
