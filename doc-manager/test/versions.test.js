const test = require("node:test");
const assert = require("node:assert");
const { familyKey, groupVersions } = require("../lib/versions");

test("버전 표시만 다른 이름은 같은 묶음", () => {
  const k = familyKey("엠씨케이테크_IR_260406.pptx");
  for (const n of ["엠씨케이테크_IR_초안.pptx", "엠씨케이테크_IR (2).pptx", "엠씨케이테크_IR_final.pptx", "엠씨케이테크_IR_v3.pptx", "엠씨케이테크_IR - 복사본.pptx", "엠씨케이테크_IR_2026-04-06.pptx"]) {
    assert.strictEqual(familyKey(n), k, n);
  }
});

test("PDF 로 내보낸 사본은 원본의 버전이 아니다 (hwp↔hwpx, doc↔docx 는 같은 문서)", () => {
  assert.notStrictEqual(familyKey("commercial invoice_Nitinol Sheet.pdf"), familyKey("commercial invoice_Nitinol Sheet.doc"));
  assert.strictEqual(familyKey("2027 수요조사서 양식.hwp"), familyKey("2027 수요조사서 양식.hwpx"));
  assert.strictEqual(familyKey("견적서_중앙대.doc"), familyKey("견적서_중앙대_v2.docx"));
  assert.notStrictEqual(familyKey("엠씨케이테크_견적.xlsx"), familyKey("엠씨케이테크_견적.docx"));
  const g = groupVersions([
    { rel: "a/commercial invoice_Nitinol Sheet.doc", base: "commercial invoice_Nitinol Sheet.doc", mtimeMs: 1 },
    { rel: "a/commercial invoice_Nitinol Sheet.pdf", base: "commercial invoice_Nitinol Sheet.pdf", mtimeMs: 2 },
  ]);
  assert.strictEqual(g.size, 0);
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

test("새 버전 이름: 번호 · 날짜 · 없으면 _v2", () => {
  const { nextVersionName } = require("../lib/versions");
  const now = new Date(2026, 9, 9);
  assert.strictEqual(nextVersionName("보고서_v01.docx", [], now), "보고서_v02.docx");
  assert.strictEqual(nextVersionName("보고서_v01.docx", ["보고서_v05.docx"], now), "보고서_v06.docx"); // 묶음에서 가장 큰 번호 다음
  assert.strictEqual(nextVersionName("보고서 ver.2.docx", [], now), "보고서 ver.3.docx");
  assert.strictEqual(nextVersionName("엠씨케이테크_IR_260406.pptx", [], now), "엠씨케이테크_IR_261009.pptx");
  assert.strictEqual(nextVersionName("메모_20250508.docx", [], now), "메모_20261009.docx");
  assert.strictEqual(nextVersionName("IR_261009.pptx", [], now), "IR_261009_v2.pptx"); // 이미 오늘 날짜
  assert.strictEqual(nextVersionName("회사소개서_국문.pptx", [], now), "회사소개서_국문_v2.pptx");
  assert.strictEqual(nextVersionName("엠씨케이테크_IR (2).pptx", ["엠씨케이테크_IR_v3.pptx"], now), "엠씨케이테크_IR_v4.pptx");
  assert.strictEqual(nextVersionName("계획서 - 복사본.hwp", [], now), "계획서_v2.hwp");
  assert.strictEqual(nextVersionName("2025 기술수요 조사.docx", [], now), "2025 기술수요 조사_v2.docx"); // 연도는 날짜가 아님
});

test("새 버전 이름이 겹치면 번호만 올린다 (날짜는 그대로)", () => {
  const { uniqueVersionName, familyKey } = require("../lib/versions");
  const taken = new Set(["IR_261009.pptx", "IR_261009_v2.pptx"]);
  assert.strictEqual(uniqueVersionName("IR_261009.pptx", (n) => taken.has(n)), "IR_261009_v3.pptx");
  assert.strictEqual(uniqueVersionName("새것.docx", () => false), "새것.docx");
  // 새로 만든 이름도 같은 묶음으로 들어간다
  assert.strictEqual(familyKey("회사소개서_국문_v2.pptx"), familyKey("회사소개서_국문.pptx"));
  assert.strictEqual(familyKey("엠씨케이테크_IR_261009.pptx"), familyKey("엠씨케이테크_IR_260406.pptx"));
});
