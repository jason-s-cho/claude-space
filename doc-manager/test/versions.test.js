const test = require("node:test");
const assert = require("node:assert");
const { familyKey, groupVersions } = require("../lib/versions");

test("버전 표시만 다른 이름은 같은 묶음", () => {
  const k = familyKey("엠씨케이테크_IR_260406.pptx");
  for (const n of ["엠씨케이테크_IR_초안.pptx", "엠씨케이테크_IR (2).pdf", "엠씨케이테크_IR_final.pptx", "엠씨케이테크_IR_v3.pptx", "엠씨케이테크_IR - 복사본.pptx", "엠씨케이테크_IR_2026-04-06.pptx"]) {
    assert.strictEqual(familyKey(n), k, n);
  }
});

test("연도가 다르거나 국문/영문처럼 내용이 다른 것은 따로", () => {
  assert.notStrictEqual(familyKey("2025 기술수요 조사.docx"), familyKey("2026 기술수요 조사.docx"));
  assert.notStrictEqual(familyKey("회사소개서_국문.pptx"), familyKey("회사소개서_영문.pptx"));
  assert.notStrictEqual(familyKey("수정사업계획서.hwp"), familyKey("사업계획서.hwp"));
});

test("묶음과 최신본", () => {
  const g = groupVersions([
    { rel: "a/IR자료_초안.pptx", base: "IR자료_초안.pptx", mtimeMs: 1 },
    { rel: "b/IR자료_최종.pptx", base: "IR자료_최종.pptx", mtimeMs: 3 },
    { rel: "IR자료_v2.pptx", base: "IR자료_v2.pptx", mtimeMs: 2 },
    { rel: "보고서_v1.docx", base: "보고서_v1.docx", mtimeMs: 1 },
    { rel: "보고서_v2.docx", base: "보고서_v2.docx", mtimeMs: 2 },
    { rel: "혼자.docx", base: "혼자.docx", mtimeMs: 1 },
  ]);
  const v = g.get("a/IR자료_초안.pptx");
  assert.strictEqual(v.size, 3);
  assert.strictEqual(v.latest, "b/IR자료_최종.pptx");
  assert.deepStrictEqual(v.order, ["b/IR자료_최종.pptx", "IR자료_v2.pptx", "a/IR자료_초안.pptx"]);
  assert.ok(!g.has("보고서_v1.docx")); // 너무 흔한 이름은 묶지 않음
  assert.ok(!g.has("혼자.docx"));
});
