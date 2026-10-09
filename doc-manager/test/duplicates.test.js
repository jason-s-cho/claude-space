const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findDuplicates, suggestKeep, mergeInto } = require("../lib/duplicates");

function library(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-dup-"));
  const index = { root, files: {} };
  let t = 1000;
  for (const [rel, content, extra] of files) {
    const full = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    index.files[rel] = { rel, size: Buffer.byteLength(content), mtimeMs: t, birthtimeMs: t, ...(extra || {}) };
    t += 1000;
  }
  return index;
}

test("내용이 같은 파일만 묶고, 계산한 지문은 다시 쓰지 않는다", async () => {
  const index = library([
    ["홍보/홈페이지/세금계산서.pdf", "AAAA"],
    ["구매·견적/세금계산서.pdf", "AAAA"],
    ["구매·견적/세금계산서 (2).pdf", "AAAA"],
    ["구매·견적/다른 견적.pdf", "BBBB"], // 크기는 같지만 내용이 다름
    ["회사소개/IR.pptx", "CCCCCC"],
  ]);
  let calls = 0;
  const counting = async (f) => {
    calls++;
    return require("../lib/duplicates").hashFile(f);
  };
  const r = await findDuplicates(index, { hash: counting });
  assert.deepStrictEqual(r.groups, [["구매·견적/세금계산서 (2).pdf", "구매·견적/세금계산서.pdf", "홍보/홈페이지/세금계산서.pdf"]]);
  assert.strictEqual(calls, 4); // 크기가 혼자인 IR.pptx 는 읽지 않는다
  const again = await findDuplicates(index, { hash: counting });
  assert.strictEqual(again.hashed, 0);
  assert.strictEqual(calls, 4);
  // 파일이 바뀌면(수정 시각) 다시 계산한다
  index.files["구매·견적/다른 견적.pdf"].mtimeMs = 99999;
  assert.strictEqual((await findDuplicates(index, { hash: counting })).hashed, 1);
  fs.rmSync(index.root, { recursive: true, force: true });
});

test("남길 파일 추천: 제자리 → 태그·메모 → 먼저 만든 것", () => {
  const index = { files: {
    "홍보/홈페이지/a.pdf": { birthtimeMs: 1 },
    "구매·견적/a.pdf": { birthtimeMs: 5 },
    "구매·견적/a (2).pdf": { birthtimeMs: 3, note: "메모" },
  } };
  const rels = Object.keys(index.files);
  const inPlace = (r) => r.startsWith("구매·견적/");
  assert.strictEqual(suggestKeep(index, rels, inPlace), "구매·견적/a (2).pdf");
  delete index.files["구매·견적/a (2).pdf"].note;
  assert.strictEqual(suggestKeep(index, rels, inPlace), "구매·견적/a (2).pdf"); // 먼저 만든 것
  assert.strictEqual(suggestKeep(index, rels), "홍보/홈페이지/a.pdf");
});

test("같은 문서의 버전들이 내용까지 같으면 최신 버전 이름을 남긴다", () => {
  const index = { files: { "IR_초안.pptx": { birthtimeMs: 1 }, "IR_v2.pptx": { birthtimeMs: 2 }, "IR_v3.pptx": { birthtimeMs: 3 } } };
  const order = ["IR_v3.pptx", "IR_v2.pptx", "IR_초안.pptx"];
  assert.strictEqual(suggestKeep(index, Object.keys(index.files), () => true, (r) => order.indexOf(r)), "IR_v3.pptx");
});

test("지울 사본의 태그·메모를 남길 파일에 합친다", () => {
  const keep = { userTags: ["중앙대학교"], note: "원본 메모" };
  mergeInto(keep, [{ userTags: ["중앙대학교", "GoPET"], note: "사본 메모", starred: true, userCategory: "purchase" }, { note: "원본 메모" }]);
  assert.deepStrictEqual(keep.userTags, ["중앙대학교", "GoPET"]);
  assert.strictEqual(keep.note, "원본 메모\n사본 메모");
  assert.ok(keep.starred);
  assert.strictEqual(keep.userCategory, "purchase");
});
