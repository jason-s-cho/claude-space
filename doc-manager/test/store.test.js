const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../lib/store");
const indexer = require("../lib/indexer");

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));

test("예전 앱 데이터 폴더의 색인을 문서 폴더로 옮긴다", () => {
  const root = tmp("docmgr-root-");
  const ud = tmp("docmgr-ud-");
  const legacy = path.join(ud, "index.json");
  const old = indexer.emptyIndex(root);
  old.files["a.docx"] = { rel: "a.docx", note: "메모", userTags: ["중요"] };
  fs.writeFileSync(legacy, JSON.stringify(old));

  assert.strictEqual(store.migrateLegacyIndex(root, legacy), true);
  assert.ok(fs.existsSync(path.join(root, ".docmanager", "index.json")));
  assert.ok(fs.existsSync(path.join(root, ".docmanager", "README.txt")));
  assert.ok(!fs.existsSync(legacy) && fs.existsSync(legacy + ".moved")); // 예전 파일은 이름만 바꿔 둠
  const loaded = indexer.loadIndex(store.paths(root).index, root, { anyRoot: true });
  assert.strictEqual(loaded.files["a.docx"].note, "메모");

  // 이미 옮겼으면 다시 하지 않는다
  assert.strictEqual(store.migrateLegacyIndex(root, legacy), false);
  // 다른 폴더의 색인은 옮기지 않는다
  const other = tmp("docmgr-other-");
  fs.writeFileSync(legacy, JSON.stringify(indexer.emptyIndex("/다른/폴더")));
  assert.strictEqual(store.migrateLegacyIndex(other, legacy), false);
  for (const d of [root, ud, other]) fs.rmSync(d, { recursive: true, force: true });
});

test("폴더를 옮기거나 다른 PC에서 열어도 색인을 그대로 쓴다", () => {
  const a = tmp("docmgr-a-");
  const idx = indexer.emptyIndex(a);
  idx.files["x.docx"] = { rel: "x.docx", note: "따라감" };
  store.ensureDir(a);
  indexer.saveIndex(store.paths(a).index, idx);
  const b = a + "-moved";
  fs.renameSync(a, b);
  const loaded = indexer.loadIndex(store.paths(b).index, b, { anyRoot: true });
  assert.strictEqual(loaded.root, b);
  assert.strictEqual(loaded.files["x.docx"].note, "따라감");
  // 앱 데이터 폴더에 둔 색인(anyRoot 아님)은 폴더가 다르면 쓰지 않는다
  assert.deepStrictEqual(indexer.loadIndex(store.paths(b).index, "/엉뚱한/폴더").files, {});
  fs.rmSync(b, { recursive: true, force: true });
});

test("분류 규칙은 폴더를 따라가고, 테마 같은 PC 설정은 폴더에 쓰지 않는다", () => {
  const root = tmp("docmgr-root-");
  const pc = { root, theme: "dark", recentSearches: ["a"], partners: [{ name: "KCC", aliases: [] }], projects: [{ name: "과제A", aliases: [] }], techTags: false };
  let r = store.loadFolderSettings(root, pc);
  assert.strictEqual(r.fromFolder, false); // 아직 없으면 지금 PC 설정으로 시작
  assert.deepStrictEqual(r.values.partners, pc.partners);
  assert.ok(store.saveFolderSettings(root, pc));
  const saved = JSON.parse(fs.readFileSync(store.paths(root).settings, "utf8"));
  assert.ok(!("theme" in saved) && !("root" in saved) && !("recentSearches" in saved));
  // 다른 PC: 자기 설정이 달라도 폴더 설정이 이긴다
  r = store.loadFolderSettings(root, { partners: [], techTags: true });
  assert.strictEqual(r.fromFolder, true);
  assert.deepStrictEqual(r.values.projects, pc.projects);
  assert.strictEqual(r.values.techTags, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test(".docmanager 는 문서로 훑지 않고, 감시에서도 무시한다", async () => {
  const root = tmp("docmgr-root-");
  store.ensureDir(root);
  fs.writeFileSync(path.join(root, ".docmanager", "몰래.docx"), "x");
  const r = await indexer.scan(indexer.emptyIndex(root), {});
  assert.strictEqual(r.added, 0);
  assert.ok(store.isOwnFile(".docmanager/index.json"));
  assert.ok(store.isOwnFile(".docmanager\\index.json.tmp"));
  assert.ok(!store.isOwnFile("국가과제·지원사업/보고서.docx"));
  assert.ok(!store.isOwnFile(null));
  fs.rmSync(root, { recursive: true, force: true });
});

test("폴더에 쓸 수 없으면 앱 데이터 폴더를 쓴다", () => {
  // .docmanager 를 만들 수 없는 곳 (파일 아래)
  const dir = tmp("docmgr-ro-");
  const notADir = path.join(dir, "파일.txt");
  fs.writeFileSync(notADir, "x");
  const loc = store.indexLocation(notADir, path.join(dir, "fallback.json"));
  assert.deepStrictEqual(loc, { file: path.join(dir, "fallback.json"), inFolder: false });
  assert.strictEqual(store.saveFolderSettings(notADir, { partners: [] }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
