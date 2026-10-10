const test = require("node:test");
const assert = require("node:assert");
const cal = require("../lib/calendar");

test("마감 → 캘린더: 하루 종일·시각 있는 일정, 3일·1일 전 알림, 구글 캘린더 주소", () => {
  const ev = cal.eventOf({ id: "abc", title: "그래핀, 차폐재; 과제", program: "소재부품기술개발사업", stage: "사업계획서 제출", due: "2026-11-20" });
  const ics = cal.toIcs([ev, { ...ev, uid: "t", due: "2026-10-14 18:00" }], { now: new Date(Date.UTC(2026, 9, 10)) });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121/);
  assert.match(ics, /DTSTART:20261014T180000\r\nDTEND:20261014T183000/);
  const unfolded = ics.replace(/\r\n /g, ""); // 긴 줄은 접혀 있다 (ICS 규칙)
  assert.match(unfolded, /SUMMARY:\[마감\] 사업계획서 제출 · 그래핀\\, 차폐재\\; 과제\r\n/);
  assert.strictEqual((ics.match(/TRIGGER:-P3D/g) || []).length, 2);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  const url = new URL(cal.googleUrl({ ...ev, due: "2026-10-14 18:00" }, { timeZone: "Asia/Seoul" }));
  assert.strictEqual(url.searchParams.get("dates"), "20261014T180000/20261014T183000");
  assert.strictEqual(url.searchParams.get("ctz"), "Asia/Seoul");
  assert.strictEqual(new URL(cal.googleUrl(ev)).searchParams.get("dates"), "20261120/20261121");
  assert.throws(() => cal.parseDue("내일"), /형식/);
});
