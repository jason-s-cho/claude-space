const test = require("node:test");
const assert = require("node:assert");
const certs = require("../lib/certs");

test("증빙 종류: 파일 이름 먼저, 없으면 본문 앞부분", () => {
  assert.strictEqual(certs.kindOf("사업자등록증_엠씨케이테크", ""), "사업자등록증");
  assert.strictEqual(certs.kindOf("등기사항전부증명서(말소사항포함)", ""), "법인등기부등본");
  assert.strictEqual(certs.kindOf("스캔_0012", "벤처기업확인서\n기업명 엠씨케이테크"), "벤처기업확인서");
  assert.strictEqual(certs.kindOf("인정서", "기업부설연구소 인정서"), "기업부설연구소 인정서");
  assert.strictEqual(certs.kindOf("ISO 14001 인증서", ""), "ISO 14001 인증서");
  assert.strictEqual(certs.kindOf("국세 완납증명", ""), "국세완납증명서"); // 띄어쓰기는 상관없다
  assert.strictEqual(certs.kindOf("인증서 사본", ""), "");
  assert.strictEqual(certs.kindOf("국세완납증명서", ""), "국세완납증명서");
});

test("발급일·유효기간을 본문에서 찾는다", () => {
  assert.deepStrictEqual(certs.datesOf("벤처기업확인서\n유효기간 : 2024. 3. 2. ~ 2027. 3. 1.\n발급일자: 2024.03.02"), { issued: "2024-03-02", validUntil: "2027-03-01" });
  assert.deepStrictEqual(certs.datesOf("납세증명서\n유효기간 2025년 10월 30일까지\n\n2025년 10월 1일\n○○세무서장"), { issued: "2025-10-01", validUntil: "2025-10-30" });
  assert.deepStrictEqual(certs.datesOf("사업자등록증\n개업연월일 2019년 5월 2일\n\n2019년 05월 10일\n○○세무서장"), { issued: "2019-05-10", validUntil: "" });
  assert.deepStrictEqual(certs.datesOf(""), { issued: "", validUntil: "" });
});

test("같은 종류는 발급일이 가장 늦은 것이 최신본, 직접 적은 날짜가 먼저", () => {
  const info = certs.analyze([
    { rel: "a/납세증명서_2025-09.pdf", name: "납세증명서_2025-09", category: "cert_perf", text: "납세증명서\n발급일자 2025.09.01\n유효기간 2025.09.30까지" },
    { rel: "a/납세증명서_2025-10.pdf", name: "납세증명서_2025-10", category: "cert_perf", text: "납세증명서\n발급일자 2025.10.01" },
    { rel: "a/벤처.pdf", name: "벤처기업확인서", category: "cert_auth", text: "", issuedAt: "2024-03-02", validUntil: "2027-03-01", mtimeMs: 0 },
    { rel: "a/견적.pdf", name: "견적서", category: "purchase", text: "" },
  ]);
  assert.strictEqual(info.size, 3);
  assert.deepStrictEqual([info.get("a/납세증명서_2025-09.pdf").latest, info.get("a/납세증명서_2025-10.pdf").latest], [false, true]);
  assert.strictEqual(info.get("a/납세증명서_2025-09.pdf").latestRel, "a/납세증명서_2025-10.pdf");
  assert.deepStrictEqual([info.get("a/벤처.pdf").validUntil, info.get("a/벤처.pdf").validAuto], ["2027-03-01", false]);
  assert.deepStrictEqual(certs.latestByKind(info).map((x) => x.kind), ["벤처기업확인서", "국세완납증명서"]);
});

test("유효기간이 없는 서류는 본문의 '~까지'를 만료일로 보지 않고, '유효기간 없음'을 고르면 만료일이 없다", () => {
  const info = certs.analyze([
    { rel: "a/표준재무제표.pdf", name: "25년 표준재무제표", category: "cert_perf", text: "표준재무상태표\n사업연도 2025.01.01부터 2025.12.31까지" },
    { rel: "a/납세.pdf", name: "납세증명서", category: "cert_perf", text: "납세증명서\n유효기간 2025.10.30까지", validUntil: "none" },
    { rel: "a/재무_직접.pdf", name: "재무제표", category: "cert_perf", text: "", validUntil: "2026-01-01" },
  ]);
  assert.deepStrictEqual([info.get("a/표준재무제표.pdf").validUntil, info.get("a/표준재무제표.pdf").validAuto], ["", false]);
  assert.deepStrictEqual([info.get("a/납세.pdf").validUntil, info.get("a/납세.pdf").noExpiry], ["", true]);
  assert.strictEqual(info.get("a/재무_직접.pdf").validUntil, "2026-01-01");
  assert.strictEqual(certs.latestByKind(info).find((x) => x.kind === "국세완납증명서").daysLeft, null);
});
