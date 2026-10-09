const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("../lib/classify");

const cat = (doc, opts) => classify(doc, opts).category;

test("국가과제 문서는 파일 이름으로 세부 종류를 가른다", () => {
  assert.strictEqual(cat({ name: "2025 소재부품 연구개발계획서_v3", dir: "국가과제" }), "gov_plan");
  assert.strictEqual(cat({ name: "그래핀 센서 최종보고서", dir: "" }), "gov_report");
  assert.strictEqual(cat({ name: "2026 기술수요조사서", dir: "" }), "gov_demand");
});

test("본문만으로도 분류한다", () => {
  const text = "과제번호 RS-2025-01\n주관연구개발기관 에이비씨\n정부지원연구개발비\n중간보고서\n연구개발 결과";
  assert.strictEqual(cat({ name: "제출본", dir: "", text }), "gov_report");
});

test("'보고서' 한 단어만으로는 국가과제로 보지 않는다", () => {
  assert.notStrictEqual(cat({ name: "월간 영업 보고서", dir: "" }), "gov_report");
});

test("IR · 회사소개 · 홈페이지 · 카탈로그", () => {
  assert.strictEqual(cat({ name: "ABC_IR deck_2026 final" }), "ir");
  assert.strictEqual(cat({ name: "회사소개서_국문" }), "company");
  assert.strictEqual(cat({ name: "홈페이지 메뉴구조 v2" }), "website");
  assert.strictEqual(cat({ name: "2024 제품 카탈로그" }), "catalog");
});

test("영문 약어는 단어 단위로만 찾는다 (IR ≠ IRB, first)", () => {
  assert.strictEqual(cat({ name: "IRB 승인 first draft" }), "other");
});

test("고객사 이름이 경로에 있으면 요청자료, 본문에만 있으면 태그만", () => {
  const opts = { partners: [{ name: "현대모비스", aliases: ["모비스"] }] };
  const r1 = classify({ name: "단가표", dir: "고객/모비스" }, opts);
  assert.strictEqual(r1.category, "request");
  assert.ok(r1.tags.includes("현대모비스"));
  const r2 = classify({ name: "회사소개서", dir: "", text: "주요 고객사: 현대모비스" }, opts);
  assert.strictEqual(r2.category, "company");
  assert.ok(r2.tags.includes("현대모비스"));
});

test("태그: 연도 · 기관 · 버전 · 내 규칙", () => {
  const r = classify(
    { name: "25년 KEIT 사업계획서 최종본", dir: "", text: "산업통상자원부 그래핀 소재" },
    { tagRules: [{ tag: "그래핀", keywords: ["그래핀", "graphene"] }, { tag: "센서", keywords: [] }] }
  );
  for (const t of ["2025", "KEIT", "산업통상자원부", "최종본", "그래핀"]) assert.ok(r.tags.includes(t), t);
  assert.ok(!r.tags.includes("센서"));
});

test("단서가 없으면 미분류", () => {
  const r = classify({ name: "메모", dir: "", text: "회의록" });
  assert.strictEqual(r.category, "other");
  assert.deepStrictEqual(r.reasons, []);
});
