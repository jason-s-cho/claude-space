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

test("사업명 띄어쓰기는 한 칸으로 맞춘다 (같은 사업으로 묶이게)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-sp-"));
  const { id } = apps.update(root, { type: "create", fields: { title: "x", program: " 국방반도체 R&D  사업 " } });
  assert.strictEqual(apps.load(root).items.find((a) => a.id === id).program, "국방반도체 R&D 사업");
});

test("사업 자료: 사업 전체·지원 건 하나에 붙이고, 종류를 바꾸고, 문서가 옮겨지면 따라가고, 사업명을 바꾸면 따라간다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-ref-"));
  const { id } = apps.update(root, { type: "create", fields: { title: "x", program: "암묵지 사업" } });
  assert.throws(() => apps.update(root, { type: "ref_link", program: "없는 사업", rel: "a.pdf" }), /지원 건이 없습니다/);
  apps.update(root, { type: "ref_link", program: "암묵지  사업", rel: "공고/공고문.pdf", kind: "공고문" });
  apps.update(root, { type: "ref_link", program: "암묵지 사업", rel: "공고/양식.hwpx", kind: "작성 양식" });
  apps.update(root, { type: "ref_link", program: "암묵지 사업", rel: "공고/양식.hwpx", kind: "평가 기준" }); // 같은 문서면 종류만 바뀜
  apps.update(root, { type: "ref_link", id, rel: "공고/RFP.pdf", kind: "RFP" });
  let d = apps.load(root);
  assert.deepStrictEqual(d.programs["암묵지 사업"].refs, [{ rel: "공고/공고문.pdf", kind: "공고문" }, { rel: "공고/양식.hwpx", kind: "평가 기준" }]);
  assert.deepStrictEqual(d.items[0].refs, [{ rel: "공고/RFP.pdf", kind: "RFP" }]);
  apps.renameDocs(root, [{ from: "공고/공고문.pdf", to: "새/공고문.pdf" }, { from: "공고/RFP.pdf", to: "새/RFP.pdf" }]);
  d = apps.load(root);
  assert.strictEqual(d.programs["암묵지 사업"].refs[0].rel, "새/공고문.pdf");
  assert.strictEqual(d.items[0].refs[0].rel, "새/RFP.pdf");
  apps.update(root, { type: "update", id, fields: { program: "암묵지 기반 AI 사업" } });
  d = apps.load(root);
  assert.ok(!d.programs["암묵지 사업"]);
  assert.strictEqual(d.programs["암묵지 기반 AI 사업"].refs.length, 2);
  apps.update(root, { type: "ref_unlink", program: "암묵지 기반 AI 사업", rel: "새/공고문.pdf" });
  apps.update(root, { type: "ref_unlink", program: "암묵지 기반 AI 사업", rel: "공고/양식.hwpx" });
  assert.ok(!apps.load(root).programs["암묵지 기반 AI 사업"]); // 비면 정리
});

test("마감: 단계에 적고, 남은 날을 세고, 결과가 나온 단계는 다가오는 마감에서 뺀다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apps-due-"));
  const { id } = apps.update(root, { type: "create", fields: { title: "x", program: "암묵지 사업" } });
  assert.throws(() => apps.update(root, { type: "stage", id, stage: "수요조사 제출", patch: { due: "10월 14일" } }), /YYYY-MM-DD/);
  apps.update(root, { type: "stage", id, stage: "수요조사 제출", patch: { due: "2026-10-14 9:30" } });
  apps.update(root, { type: "stage", id, stage: "사업계획서 제출", patch: { due: "2026-11-20" } });
  let d = apps.load(root);
  assert.strictEqual(d.items[0].stages[0].due, "2026-10-14 09:30");
  const now = new Date(2026, 9, 10, 23, 0);
  assert.strictEqual(apps.daysLeft("2026-10-14 09:30", now), 4);
  assert.strictEqual(apps.daysLeft("2026-10-09", now), -1);
  assert.deepStrictEqual(apps.upcoming(d, { now }).map((u) => [u.stage, u.daysLeft]), [["수요조사 제출", 4], ["사업계획서 제출", 41]]);
  apps.update(root, { type: "stage", id, stage: "수요조사 제출", patch: { status: "통과" } });
  d = apps.load(root);
  assert.deepStrictEqual(apps.upcoming(d, { now }).map((u) => u.stage), ["사업계획서 제출"]);
  assert.deepStrictEqual(apps.upcoming(d, { now, withinDays: 30 }), []);
  apps.update(root, { type: "stage", id, stage: "사업계획서 제출", patch: { due: "" } });
  assert.strictEqual(apps.load(root).items[0].stages[2].due, "");
});
