const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const indexer = require("../lib/indexer");

async function makeDocx(file, paragraphs) {
  const zip = new JSZip();
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

async function makePptx(file, slides) {
  const zip = new JSZip();
  slides.forEach((s, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:sld>`));
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("폴더를 훑어 분류하고, 내가 고친 내용은 파일을 옮겨도 남는다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-"));
  fs.mkdirSync(path.join(root, "과제"));
  await makeDocx(path.join(root, "과제", "결과 보고.docx"), ["최종보고서", "주관기관 &amp; 참여기관", "정부출연금"]);
  await makePptx(path.join(root, "deck.pptx"), ["투자유치 IR", "Series A"]);
  fs.writeFileSync(path.join(root, "~$임시.docx"), "x");
  fs.writeFileSync(path.join(root, "메모.txt"), "x");

  const index = indexer.emptyIndex(root);
  let r = await indexer.scan(index, {});
  assert.strictEqual(r.added, 2);
  const report = index.files["과제/결과 보고.docx"];
  assert.match(report.text, /주관기관 & 참여기관/);
  assert.strictEqual(indexer.effective(report).category, "gov_report");
  assert.strictEqual(indexer.effective(index.files["deck.pptx"]).category, "ir");

  // 직접 고치기
  report.userTags = ["중요"];
  report.hiddenTags = ["최종보고"];
  report.note = "제출 완료";

  // 바뀐 게 없으면 다시 읽지 않는다.
  r = await indexer.scan(index, {});
  assert.deepStrictEqual([r.added, r.updated, r.removed], [0, 0, 0]);

  // 파일을 옮겨도 메모·태그가 따라간다.
  fs.renameSync(path.join(root, "과제", "결과 보고.docx"), path.join(root, "옮긴 보고.docx"));
  r = await indexer.scan(index, {});
  assert.deepStrictEqual([r.added, r.removed], [1, 1]);
  const moved = index.files["옮긴 보고.docx"];
  assert.strictEqual(moved.note, "제출 완료");
  assert.ok(indexer.effective(moved).tags.includes("중요"));

  // 저장했다가 다시 불러오기
  const file = path.join(root, "index.json");
  indexer.saveIndex(file, index);
  assert.strictEqual(Object.keys(indexer.loadIndex(file, root).files).length, 2);
  assert.strictEqual(Object.keys(indexer.loadIndex(file, "/다른/폴더").files).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
