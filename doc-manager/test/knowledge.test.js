const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const knowledge = require("../lib/knowledge");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-kn-"));

test("지식 카드: 저장하면 문서 폴더/Claude 지식 에 두고, 바꿀 때마다 이전 내용을 남긴다", () => {
  const root = tmp();
  assert.strictEqual(knowledge.read(root).exists, false);
  knowledge.save(root, "# 카드\n첫 내용\n");
  const k = knowledge.read(root);
  assert.ok(k.exists);
  assert.strictEqual(k.path, path.join(root, "Claude 지식", "회사 지식 카드.md"));
  const r = knowledge.save(root, "# 카드\n둘째 내용\n", { now: new Date(2026, 9, 9, 10, 0, 0) });
  assert.ok(r.backup && fs.readFileSync(r.backup, "utf8").includes("첫 내용"));
  assert.match(path.basename(r.backup), /^회사 지식 카드_261009-100000\.md$/);
  assert.deepStrictEqual(knowledge.history(root), [r.backup]);
  // 같은 내용이면 기록을 늘리지 않는다
  assert.strictEqual(knowledge.save(root, "# 카드\n둘째 내용\n").backup, null);
  assert.throws(() => knowledge.save(root, "  "), /빈 내용/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("지식 카드: Claude 가 저장할 때 사용자 메모는 이전 것을 그대로 둔다", () => {
  const root = tmp();
  knowledge.save(root, "# 카드\n## 1. 회사 개요\n옛 개요\n\n## 사용자 메모\n- 대표 직함은 '대표이사'로 $& 표기\n");
  // 빠뜨린 경우
  let r = knowledge.save(root, "# 카드\n## 1. 회사 개요\n새 개요\n", { protectUserSection: true });
  assert.ok(r.keptUserSection);
  let c = knowledge.read(root).content;
  assert.ok(c.includes("새 개요"));
  assert.ok(c.includes("- 대표 직함은 '대표이사'로 $& 표기"));
  // 고친 경우에도 사용자 것으로 되돌린다
  r = knowledge.save(root, "# 카드\n## 1. 회사 개요\n새 개요\n\n## 사용자 메모\n(비움)\n", { protectUserSection: true });
  c = knowledge.read(root).content;
  assert.ok(c.includes("$& 표기") && !c.includes("(비움)"));
  // 사용자가 앱에서 직접 고칠 때는 그대로 저장
  knowledge.save(root, "# 카드\n\n## 사용자 메모\n- 바꾼 메모\n");
  assert.ok(knowledge.read(root).content.includes("- 바꾼 메모"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("지식 카드 양식에는 사용자 메모 칸이 있다", () => {
  assert.ok(knowledge.userSection(knowledge.TEMPLATE).startsWith("## 사용자 메모"));
});
