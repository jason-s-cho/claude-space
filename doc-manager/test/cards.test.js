const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cards = require("../lib/cards");

test("주제·사업 카드와 작성 가이드: 양식, 저장, 목록, 사용자 메모 보호, 기록", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cards-"));
  assert.throws(() => cards.read(root, "topic", " "), /이름/);
  assert.throws(() => cards.read(root, "etc", "x"), /종류/);
  const empty = cards.read(root, "program", "국방반도체 R&D  사업");
  assert.strictEqual(empty.exists, false);
  assert.strictEqual(empty.name, "국방반도체 R&D 사업");
  assert.match(cards.template("program", empty.name), /^# 사업 카드: 국방반도체 R&D 사업/);

  const body = cards.template("topic", "그래핀/스텔스 패널").replace("(무엇을, 어떻게 해서, 무엇이 좋아지는 기술인지 한 문장)", "광학투명 전자파 흡수 패널");
  const r = cards.save(root, "topic", "그래핀/스텔스 패널", body.replace("(여기는 사용자가 직접 쓰는 곳입니다. Claude 는 이 부분을 고치지 않습니다.)", "투과율은 70% 로 통일"));
  assert.strictEqual(r.rel, "Claude 지식/주제/그래핀_스텔스 패널.md"); // 파일 이름에 못 쓰는 글자는 바꾼다
  // Claude 가 사용자 메모를 빠뜨려도 지킨다, 이전 내용은 기록으로
  const r2 = cards.save(root, "topic", "그래핀/스텔스 패널", "# 주제 카드: 그래핀/스텔스 패널\n\n## 1. 한 줄 정의\n새 정의\n", { protectUserSection: true });
  assert.ok(r2.keptUserSection && r2.backup);
  assert.match(fs.readFileSync(r2.path, "utf8"), /투과율은 70% 로 통일/);
  assert.match(path.basename(r2.backup), /^주제 카드_그래핀_스텔스 패널_/);

  cards.save(root, "program", "소재부품기술개발사업", cards.template("program", "소재부품기술개발사업"));
  // 작성 가이드는 문서 종류마다: 수요조사서와 사업계획서는 양식이 다르다
  assert.throws(() => cards.read(root, "guide"), /문서 종류/);
  assert.match(cards.template("guide", "수요조사서"), /RFP/);
  assert.match(cards.template("guide", "사업계획서"), /연구비/);
  cards.save(root, "guide", "수요조사서", cards.template("guide", "수요조사서"));
  const list = cards.list(root);
  assert.deepStrictEqual(list.map((c) => [c.kind, c.name]), [["topic", "그래핀/스텔스 패널"], ["program", "소재부품기술개발사업"], ["guide", "수요조사서"]]);
  assert.strictEqual(cards.read(root, "guide", "수요조사서").rel, "Claude 지식/작성 가이드/수요조사서.md");
});

test("예전 한 장짜리 작성 가이드는 사업계획서 가이드로 옮긴다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cards-old-"));
  fs.mkdirSync(path.join(root, "Claude 지식"));
  fs.writeFileSync(path.join(root, "Claude 지식", "작성 가이드.md"), "# 작성 가이드\n\n## 공통 원칙\n개조식\n");
  const g = cards.read(root, "guide", "사업계획서");
  assert.ok(g.exists);
  assert.match(g.content, /^# 작성 가이드: 사업계획서\n[\s\S]*개조식/);
  assert.ok(!fs.existsSync(path.join(root, "Claude 지식", "작성 가이드.md")));
  assert.deepStrictEqual(cards.list(root).map((c) => [c.kind, c.name]), [["guide", "사업계획서"]]);
});

test("카드 이름이 조금 달라도 찾는다 (띄어쓰기·제목 뒤 설명)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cards-loose-"));
  fs.mkdirSync(path.join(root, "Claude 지식", "사업"), { recursive: true });
  // Claude 가 '소재부품기술개발 사업' 으로 저장하고 제목 뒤에 설명을 붙였다
  fs.writeFileSync(path.join(root, "Claude 지식", "사업", "소재부품기술개발 사업.md"), "# 사업 카드: 소재부품기술개발 사업 (KEIT, 2027)\n\n## 1. 사업 개요\nx\n");
  const c = cards.read(root, "program", "소재부품기술개발사업");
  assert.ok(c.exists);
  assert.strictEqual(c.rel, "Claude 지식/사업/소재부품기술개발 사업.md");
  assert.deepStrictEqual(cards.list(root).map((x) => x.name), ["소재부품기술개발 사업"]); // 제목 뒤 설명은 이름이 아니다
  // 저장해도 새 파일을 만들지 않고 그 파일을 고친다
  cards.save(root, "program", "소재부품기술개발사업", "# 사업 카드: 소재부품기술개발사업\n\n## 1. 사업 개요\ny\n");
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "Claude 지식", "사업")), ["소재부품기술개발 사업.md"]);
});
