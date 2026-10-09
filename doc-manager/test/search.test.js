const test = require("node:test");
const assert = require("node:assert");
const { parseQuery, matchView, snippet } = require("../lib/search");

function view(over = {}) {
  const text = over.text || "";
  return {
    name: "문서.docx", dir: "", title: "", note: "", tags: [], keywords: [], kind: "word", ext: "docx",
    years: ["2026"], catText: "국가과제 과제보고서", ...over, textNs: text.toLowerCase().replace(/\s+/g, ""),
  };
}
const hit = (v, q) => matchView(v, parseQuery(q)) > 0;

test("검색어 해석", () => {
  const p = parseQuery('그래핀 "전자파 차폐" a|b -초안 #KEIT 분류:보고서 연도:2025 형식:ppt 10:30');
  assert.deepStrictEqual(p.terms.map((t) => [t.alts, t.neg]), [[["그래핀"], false], [["전자파 차폐"], false], [["a", "b"], false], [["초안"], true], [["10:30"], false]]);
  assert.deepStrictEqual(p.filters.map((f) => [f.field, f.value]), [["tag", "keit"], ["cat", "보고서"], ["year", "2025"], ["kind", "ppt"]]);
  assert.ok(p.highlight.includes("전자파 차폐") && !p.highlight.includes("초안"));
});

test("모든 단어 · 구절(띄어쓰기 무시) · 또는 · 빼기", () => {
  const v = view({ text: "그래핀 센서와 전자파차폐 필름" });
  assert.ok(hit(v, "그래핀 센서"));
  assert.ok(hit(v, '"전자파 차폐"'));
  assert.ok(!hit(v, "그래핀 반도체"));
  assert.ok(hit(v, "반도체|필름"));
  assert.ok(!hit(v, "그래핀 -필름"));
});

test("조건 검색", () => {
  const v = view({ name: "결과보고서_최종.pptx", kind: "ppt", ext: "pptx", dir: "고객사/현대", tags: ["KEIT", "2025"], years: ["2025", "2026"], note: "제출 완료", keywords: ["그래핀 센서"] });
  for (const q of ["#keit", "태그:KEIT", "분류:보고서", "분류:국가과제", "연도:2025", "형식:ppt", "형식:파워포인트", "폴더:고객사", "이름:최종", "메모:제출", "키워드:그래핀"]) assert.ok(hit(v, q), q);
  for (const q of ["#TIPA", "분류:카탈로그", "연도:2024", "형식:pdf", "-형식:ppt", "-#KEIT"]) assert.ok(!hit(v, q), q);
});

test("파일 이름에 있으면 본문보다 점수가 높다", () => {
  const p = parseQuery("그래핀");
  assert.ok(matchView(view({ name: "그래핀 소개.pptx" }), p) > matchView(view({ text: "그래핀 그래핀" }), p));
});

test("미리보기 조각", () => {
  assert.match(snippet("앞부분 ".repeat(30) + "그래핀 센서 뒷부분", ["그래핀"]), /^….*그래핀 센서/);
  assert.strictEqual(snippet("아무것도", ["없음"]), "");
});
