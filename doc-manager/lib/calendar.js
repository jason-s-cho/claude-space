// 마감을 캘린더로: .ics 파일(아웃룩·윈도우 일정·구글 캘린더 가져오기)과 구글 캘린더 '일정 추가' 주소.
// 마감 시각이 없으면 하루 종일 일정, 있으면 그 시각에 30분짜리 일정. 3일 전·1일 전 알림을 붙인다.

const pad = (n) => String(n).padStart(2, "0");

// "2026-10-14" / "2026-10-14 18:00" → { y, m, d, hh, mm, allDay }
function parseDue(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(String(due || ""));
  if (!m) throw new Error("마감 날짜 형식이 아닙니다: " + due);
  return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] === undefined ? null : +m[4], mm: m[5] === undefined ? null : +m[5], allDay: m[4] === undefined };
}

const ymd = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
const ymdhms = (dt) => `${ymd(dt)}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;

// 일정의 시작·끝 (로컬 시각)
function span(due) {
  const p = parseDue(due);
  if (p.allDay) {
    const start = new Date(p.y, p.m - 1, p.d);
    return { allDay: true, start, end: new Date(p.y, p.m - 1, p.d + 1) };
  }
  const start = new Date(p.y, p.m - 1, p.d, p.hh, p.mm);
  return { allDay: false, start, end: new Date(start.getTime() + 30 * 60000) };
}

// ICS 글자 이스케이프와 75바이트 줄 접기
const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 73) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}

/**
 * events: [{ uid, title, description, due }] → .ics 내용
 */
function toIcs(events, { now = new Date() } = {}) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//docmanager//워크데스크//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  for (const e of events) {
    const s = span(e.due);
    lines.push("BEGIN:VEVENT", `UID:${e.uid}@docmanager`, `DTSTAMP:${stamp}`);
    if (s.allDay) lines.push(`DTSTART;VALUE=DATE:${ymd(s.start)}`, `DTEND;VALUE=DATE:${ymd(s.end)}`);
    else lines.push(`DTSTART:${ymdhms(s.start)}`, `DTEND:${ymdhms(s.end)}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    for (const before of ["-P3D", "-P1D"])
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:${before}`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// 구글 캘린더 '일정 추가' 화면 주소 (브라우저로 열면 저장 버튼만 누르면 된다)
function googleUrl(e, { timeZone } = {}) {
  const s = span(e.due);
  const dates = s.allDay ? `${ymd(s.start)}/${ymd(s.end)}` : `${ymdhms(s.start)}/${ymdhms(s.end)}`;
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates, details: e.description || "" });
  if (!s.allDay && timeZone) q.set("ctz", timeZone);
  return "https://calendar.google.com/calendar/render?" + q.toString();
}

// 지원 건 마감 하나 → 일정
function eventOf(u) {
  return {
    uid: `${u.id}-${Buffer.from(u.stage).toString("hex").slice(0, 24)}`,
    title: `[마감] ${u.stage} · ${u.title}`,
    description: [u.program && `사업: ${u.program}`, `지원 건: ${u.title}`, `단계: ${u.stage}`, `마감: ${u.due}`, "워크데스크에서 만든 일정"].filter(Boolean).join("\n"),
    due: u.due,
  };
}

module.exports = { parseDue, toIcs, googleUrl, eventOf };
