const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const indexer = require("../lib/indexer");
const { importFiles, ensureCategoryFolders, moveToFolder, folderFor } = require("../lib/importer");

async function makeDocx(file, paragraphs) {
  const zip = new JSZip();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<w:document><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test("분류별 폴더를 만든다 (고객사 폴더 포함)", () => {
  const root = tmp("docmgr-root-");
  const made = ensureCategoryFolders(root, [{ name: "현대모비스" }], [{ name: "2024 K-방산", aliases: [] }]);
  for (const d of ["국가과제·지원사업/1 공고·수요조사", "국가과제·지원사업/6 정산·증빙", "국가과제·지원사업/2024 K-방산/5 보고서",
    "회사소개/IR·투자", "홍보/카탈로그·브로셔", "기술·시장 분석", "구매·견적", "고객사·협력사/현대모비스", "미분류"]) {
    assert.ok(fs.statSync(path.join(root, ...d.split("/"))).isDirectory(), d);
  }
  assert.ok(made >= 10);
  assert.strictEqual(ensureCategoryFolders(root, [{ name: "현대모비스" }], [{ name: "2024 K-방산", aliases: [] }]), 0); // 두 번째는 만들 것이 없다
  assert.strictEqual(folderFor("request", ["A/B:C"], ["A/B:C"]), "고객사·협력사/A B C");
  assert.strictEqual(folderFor("gov_report", ["과제X"], [], ["과제X"]), "국가과제·지원사업/과제X/5 보고서");
  assert.strictEqual(folderFor("gov_report", [], [], ["과제X"]), "국가과제·지원사업/5 보고서");
  fs.rmSync(root, { recursive: true, force: true });
});

test("끌어다 놓은 파일을 분류 폴더에 복사하고, 같은 파일은 다시 넣지 않는다", async () => {
  const root = tmp("docmgr-root-");
  const src = tmp("docmgr-src-");
  const report = path.join(src, "센서 결과보고서.docx");
  await makeDocx(report, ["최종보고서", "주관기관 참여기관 정부출연금"]);
  const other = path.join(src, "센서 결과보고서 수정.docx");
  fs.writeFileSync(path.join(src, "그림.png"), "x");
  const old = new Date("2024-05-01T00:00:00Z");
  fs.utimesSync(report, old, old);

  const index = indexer.emptyIndex(root);
  const opts = { layout: "category", options: {} };
  let r = await importFiles(index, [report, path.join(src, "그림.png")], opts);
  assert.strictEqual(r.imported.length, 1);
  assert.strictEqual(r.imported[0].rel, "국가과제·지원사업/5 보고서/센서 결과보고서.docx");
  assert.strictEqual(r.imported[0].category, "gov_report");
  assert.deepStrictEqual(r.skipped.map((x) => x.reason), ["지원하지 않는 형식"]);
  assert.ok(fs.existsSync(report)); // 원본은 그대로
  assert.strictEqual(Math.round(fs.statSync(path.join(root, "국가과제·지원사업", "5 보고서", "센서 결과보고서.docx")).mtimeMs), old.getTime());

  // 같은 파일을 또 놓으면 복사하지 않는다
  r = await importFiles(index, [report], opts);
  assert.deepStrictEqual([r.imported.length, r.existing.length], [0, 1]);

  // 이름은 같은데 내용이 다르면 "(2)"
  await makeDocx(other, ["최종보고서", "다른 내용", "주관기관"]);
  fs.renameSync(other, path.join(src, "x.docx"));
  const dir2 = tmp("docmgr-src2-");
  const same = path.join(dir2, "센서 결과보고서.docx");
  fs.renameSync(path.join(src, "x.docx"), same);
  r = await importFiles(index, [dir2], opts); // 폴더째 놓기
  assert.strictEqual(r.imported[0].rel, "국가과제·지원사업/5 보고서/센서 결과보고서 (2).docx");

  // 다시 훑어도 바뀐 것이 없다
  const s = await indexer.scan(index, {});
  assert.deepStrictEqual([s.added, s.updated, s.removed], [0, 0, 0]);
  for (const d of [root, src, dir2]) fs.rmSync(d, { recursive: true, force: true });
});

test("최상위 폴더 방식 · 분류 폴더로 옮기기", async () => {
  const root = tmp("docmgr-root-");
  const src = tmp("docmgr-src-");
  const f = path.join(src, "2026 제품 카탈로그.docx");
  await makeDocx(f, ["카탈로그"]);
  const index = indexer.emptyIndex(root);
  const r = await importFiles(index, [f], { layout: "root", options: {} });
  assert.strictEqual(r.imported[0].rel, "2026 제품 카탈로그.docx");
  index.files[r.imported[0].rel].note = "메모";
  const newRel = await moveToFolder(index, r.imported[0].rel, "홍보/카탈로그·브로셔");
  assert.strictEqual(newRel, "홍보/카탈로그·브로셔/2026 제품 카탈로그.docx");
  assert.ok(fs.existsSync(path.join(root, "홍보", "카탈로그·브로셔", "2026 제품 카탈로그.docx")));
  assert.strictEqual(index.files[newRel].note, "메모");
  await assert.rejects(moveToFolder(index, newRel, "../밖"));
  for (const d of [root, src]) fs.rmSync(d, { recursive: true, force: true });
});

test("원래 폴더 이름(고객사 이름)도 분류 단서로 쓴다", async () => {
  const root = tmp("docmgr-root-");
  const src = tmp("docmgr-src-");
  fs.mkdirSync(path.join(src, "현대모비스"));
  const f = path.join(src, "현대모비스", "단가표.docx");
  await makeDocx(f, ["품목 단가"]);
  const index = indexer.emptyIndex(root);
  const r = await importFiles(index, [f], { layout: "category", options: { partners: [{ name: "현대모비스", aliases: [] }] } });
  assert.strictEqual(r.imported[0].rel, "고객사·협력사/현대모비스/단가표.docx");
  assert.strictEqual(r.imported[0].category, "request");
  for (const d of [root, src]) fs.rmSync(d, { recursive: true, force: true });
});

test("예전 버전이 만든 빈 분류 폴더만 지운다", async () => {
  const { removeLegacyFolders } = require("../lib/importer");
  const root = tmp("docmgr-root-");
  for (const d of ["국가과제/수요조사서", "국가과제/과제보고서", "대외/고객사·협력사 요청자료/현대모비스", "홍보/카탈로그"]) fs.mkdirSync(path.join(root, ...d.split("/")), { recursive: true });
  fs.writeFileSync(path.join(root, "국가과제", "과제보고서", "보고서.docx"), "x"); // 파일이 있는 폴더
  removeLegacyFolders(root);
  assert.ok(!fs.existsSync(path.join(root, "국가과제", "수요조사서")));
  assert.ok(fs.existsSync(path.join(root, "국가과제", "과제보고서", "보고서.docx"))); // 파일은 그대로
  assert.ok(!fs.existsSync(path.join(root, "대외")));
  assert.ok(!fs.existsSync(path.join(root, "홍보", "카탈로그")));
  assert.ok(fs.existsSync(path.join(root, "홍보"))); // 새 버전도 쓰는 폴더는 남김
  fs.rmSync(root, { recursive: true, force: true });
});

test("제자리 판정과 여러 개 한꺼번에 옮기기", async () => {
  const { isInPlace, moveManyToFolders } = require("../lib/importer");
  assert.ok(isInPlace("구매·견적", "구매·견적"));
  assert.ok(isInPlace("구매·견적/2026 중앙대", "구매·견적")); // 직접 나눈 하위 폴더는 제자리
  assert.ok(!isInPlace("홍보/홈페이지", "구매·견적"));
  assert.ok(!isInPlace("구매·견적2", "구매·견적"));
  assert.ok(isInPlace("아무 곳", ""));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-mm-"));
  fs.mkdirSync(path.join(root, "홍보", "홈페이지"), { recursive: true });
  fs.mkdirSync(path.join(root, "구매·견적"), { recursive: true });
  fs.writeFileSync(path.join(root, "홍보", "홈페이지", "전자세금계산서_A.pdf"), "a");
  fs.writeFileSync(path.join(root, "홍보", "홈페이지", "전자세금계산서_B.pdf"), "b");
  fs.writeFileSync(path.join(root, "구매·견적", "전자세금계산서_B.pdf"), "b"); // 같은 내용이 이미 있음
  const index = { root, files: {} };
  for (const rel of ["홍보/홈페이지/전자세금계산서_A.pdf", "홍보/홈페이지/전자세금계산서_B.pdf", "구매·견적/전자세금계산서_B.pdf"])
    index.files[rel] = { rel, note: rel.endsWith("A.pdf") ? "메모" : "" };
  const r = await moveManyToFolders(index, Object.keys(index.files).concat(["없는/파일.pdf"]), () => "구매·견적");
  assert.deepStrictEqual(r.moved, [{ from: "홍보/홈페이지/전자세금계산서_A.pdf", to: "구매·견적/전자세금계산서_A.pdf" }]);
  assert.strictEqual(r.failed.length, 2); // 같은 파일이 이미 있는 것, 없는 파일
  assert.strictEqual(index.files["구매·견적/전자세금계산서_A.pdf"].note, "메모");
  assert.ok(fs.existsSync(path.join(root, "구매·견적", "전자세금계산서_A.pdf")));
  assert.ok(fs.existsSync(path.join(root, "홍보", "홈페이지", "전자세금계산서_B.pdf"))); // 지우지 않는다
  fs.rmSync(root, { recursive: true, force: true });
});
