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

test("본문은 이 PC의 캐시에, 문서 폴더의 색인에는 나머지만 (다른 PC에서는 본문만 다시 읽는다)", async () => {
  const store = require("../lib/store");
  const { Library } = require("../lib/library");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-tc-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-tc-ud-"));
  fs.mkdirSync(path.join(root, "보고서"));
  await makeDocx(path.join(root, "보고서", "그래핀 최종보고서.docx"), ["최종보고서", "스텔스 패널 흡수율 95% 달성"]);
  const index = indexer.emptyIndex(root);
  await indexer.scan(index, {});
  index.files["보고서/그래핀 최종보고서.docx"].userTags = ["중요"];
  store.ensureDir(root);
  const file = store.paths(root).index;
  const textFile = store.textCacheFile(ud, root);
  indexer.saveIndex(file, index, { textFile });
  // 문서 폴더 색인에는 본문이 없다
  const slim = JSON.parse(fs.readFileSync(file, "utf8")).files["보고서/그래핀 최종보고서.docx"];
  assert.strictEqual(slim.text, undefined);
  assert.strictEqual(slim.terms, undefined);
  assert.deepStrictEqual(slim.userTags, ["중요"]);
  assert.ok(fs.readFileSync(textFile, "utf8").includes("흡수율"));
  // 같은 PC: 캐시에서 본문을 다시 붙인다
  let loaded = indexer.loadIndex(file, root, { anyRoot: true, textFile });
  assert.match(loaded.files["보고서/그래핀 최종보고서.docx"].text, /흡수율 95%/);
  assert.strictEqual((await indexer.scan(loaded, {})).updated, 0);
  // Claude 커넥터도 캐시의 본문으로 검색한다
  fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ root }));
  const found = new Library({ userDataDir: ud }).search("흡수율");
  assert.deepStrictEqual(found.results.map((r) => r.path), ["보고서/그래핀 최종보고서.docx"]);
  // 다른 PC (캐시 없음): 본문만 다시 읽고, 태그는 그대로
  const other = path.join(ud, "다른PC.json");
  loaded = indexer.loadIndex(file, root, { anyRoot: true, textFile: other });
  assert.ok(loaded.files["보고서/그래핀 최종보고서.docx"].needsText);
  const r = await indexer.scan(loaded, {});
  assert.strictEqual(r.updated, 1);
  assert.match(loaded.files["보고서/그래핀 최종보고서.docx"].text, /흡수율/);
  assert.deepStrictEqual(loaded.files["보고서/그래핀 최종보고서.docx"].userTags, ["중요"]);
  indexer.saveIndex(file, loaded, { textFile: other });
  assert.ok(fs.existsSync(other));
  // 태그만 바꿔 저장하면 본문 캐시는 다시 쓰지 않는다
  const before = fs.statSync(other).mtimeMs;
  await new Promise((res) => setTimeout(res, 20));
  loaded.files["보고서/그래핀 최종보고서.docx"].note = "메모";
  indexer.saveIndex(file, loaded, { textFile: other });
  assert.strictEqual(fs.statSync(other).mtimeMs, before);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
});

test("본문이 들어 있던 예전 색인은 처음 저장할 때 캐시로 옮긴다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-tc2-"));
  await makeDocx(path.join(root, "a.docx"), ["예전 색인 본문"]);
  const index = indexer.emptyIndex(root);
  await indexer.scan(index, {});
  const file = path.join(root, "index.json");
  indexer.saveIndex(file, index); // 예전 방식 (본문 포함)
  assert.ok(fs.readFileSync(file, "utf8").includes("예전 색인 본문"));
  const textFile = path.join(root, "cache", "t.json");
  const loaded = indexer.loadIndex(file, root, { textFile });
  assert.ok(loaded.textDirty);
  indexer.saveIndex(file, loaded, { textFile });
  assert.ok(!fs.readFileSync(file, "utf8").includes("예전 색인 본문"));
  assert.ok(fs.readFileSync(textFile, "utf8").includes("예전 색인 본문"));
  fs.rmSync(root, { recursive: true, force: true });
});
