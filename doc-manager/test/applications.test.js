const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const apps = require("../lib/applications");

test("지원 건: 단계 틀로 만들고, 단계 결과·문서를 기록하고, 단계 목록을 바꾼다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-apps-"));
  const { id } = apps.update(root, { type: "create", fields: { title: "광학투명 스텔스 패널", topic: "그래핀 스텔스", program: "소재부품기술개발", year: 2027 }, template: "국가 R&D (수요조사부터)" });
  let a = apps.load(root).items[0];
  assert.deepStrictEqual(a.stages.map((s) => s.name), ["수요조사 제출", "RFP 반영", "사업계획서 제출", "서류평가", "발표평가", "선정·협약"]);
  assert.deepStrictEqual(apps.progress(a), { state: "준비", stage: "수요조사 제출" });
  apps.update(root, { type: "stage", id, stage: "수요조사 제출", patch: { status: "통과", date: "2026-09-11" } });
  apps.update(root, { type: "link", id, stage: "수요조사 제출", rel: "국가과제·지원사업/1 공고·수요조사/수요조사서.hwpx" });
  a = apps.load(root).items[0];
  assert.deepStrictEqual(apps.progress(a), { state: "진행 중", stage: "RFP 반영" });
  apps.update(root, { type: "stage", id, stage: "RFP 반영", patch: { status: "탈락", note: "다른 수요와 통합됨" } });
  a = apps.load(root).items[0];
  assert.deepStrictEqual(apps.progress(a), { state: "탈락", stage: "RFP 반영" });
  assert.match(a.stages[1].date, /^\d{4}-\d{2}-\d{2}$/); // 결과를 적으면 날짜가 없을 때 오늘로
  // 단계 목록 바꾸기 (요건 검토 추가, 이름 바꾸기) — 기록은 그대로
  apps.update(root, { type: "stages", id, stages: [a.stages[0], a.stages[1], { name: "요건 검토" }, ...a.stages.slice(2)] });
  assert.strictEqual(apps.load(root).items[0].stages[2].name, "요건 검토");
  assert.throws(() => apps.update(root, { type: "stages", id, stages: [{ name: "a" }, { name: "a" }] }), /겹칩니다/);
  assert.throws(() => apps.update(root, { type: "stage", id, stage: "없는 단계", patch: { status: "통과" } }), /단계가 없습니다/);
  // 문서가 옮겨지면 연결도 따라간다
  apps.renameDocs(root, [{ from: "국가과제·지원사업/1 공고·수요조사/수요조사서.hwpx", to: "새 폴더/수요조사서.hwpx" }]);
  assert.deepStrictEqual(apps.load(root).items[0].stages[0].docs, ["새 폴더/수요조사서.hwpx"]);
  // 단계 틀 바꾸기
  apps.update(root, { type: "templates", templates: [{ name: "바우처", stages: ["신청", "선정"] }] });
  assert.deepStrictEqual(apps.load(root).templates, [{ name: "바우처", stages: ["신청", "선정"] }]);
  fs.rmSync(root, { recursive: true, force: true });
});
