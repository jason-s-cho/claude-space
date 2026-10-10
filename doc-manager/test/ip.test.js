const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ip = require("../lib/ip");

test("지식재산 대장: 만들기·고치기·번호 맞추기·상태·문서 연결", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ip-"));
  const { id } = ip.update(root, { type: "create", fields: { title: "그래핀 투명 전자파 차폐 필름", appNo: "1020240123456", appDate: "2024.3.5", inventors: "홍길동, 김철수" } });
  let it = ip.load(root).items[0];
  assert.deepStrictEqual([it.right, it.appNo, it.appDate, it.status], ["특허", "10-2024-0123456", "2024-03-05", "출원"]);
  assert.throws(() => ip.update(root, { type: "create", fields: { appNo: "10-2024-0123456" } }), /이미 대장에/);
  assert.throws(() => ip.update(root, { type: "create", fields: {} }), /명칭이나/);
  assert.throws(() => ip.update(root, { type: "update", id, fields: { status: "심사중" } }), /상태는/);
  // 등록번호가 생기면 등록으로
  ip.update(root, { type: "update", id, fields: { regNo: "10 2654321", regDate: "2025년 1월 9일" } });
  it = ip.load(root).items[0];
  assert.deepStrictEqual([it.regNo, it.regDate, it.status], ["10-2654321", "2025-01-09", "등록"]);
  // 상표 번호면 상표로
  ip.update(root, { type: "create", fields: { title: "MCK", appNo: "40-2023-0098765" } });
  assert.strictEqual(ip.load(root).items[1].right, "상표");
  ip.update(root, { type: "link", id, rel: "지식재산/특허 등록/특허증.pdf" });
  ip.renameDocs(root, [{ from: "지식재산/특허 등록/특허증.pdf", to: "지식재산/특허 등록/특허증_그래핀.pdf" }]);
  assert.deepStrictEqual(ip.load(root).items[0].docs, ["지식재산/특허 등록/특허증_그래핀.pdf"]);
  assert.match(ip.toTsv(ip.load(root).items), /^구분\t명칭\t출원번호[\s\S]*\n특허\t그래핀 투명 전자파 차폐 필름\t10-2024-0123456\t2024-03-05\t10-2654321\t2025-01-09\t등록/);
});

test("이 문서 자신의 출원번호만: 이름·'출원번호'·(21) 칸, 없으면 첫머리", () => {
  assert.deepStrictEqual(ip.ownAppNos("(21) 출원번호 10-2013-0014862\n(56) 선행기술조사문헌\n10-2007-0100617 A", "공보.pdf"), ["10-2013-0014862"]);
  assert.deepStrictEqual(ip.ownAppNos("【출원번호】 10-2025-0001111\n특허문헌 1: 10-2011-0076577"), ["10-2025-0001111"]);
  assert.deepStrictEqual(ip.ownAppNos("특허증\n제 10-2654321 호\n출원번호 제10-2024-0123456호"), ["10-2024-0123456"]);
  assert.deepStrictEqual(ip.ownAppNos("x ".repeat(500) + "참고: 10-2012-0098957", "의견서.pdf"), []);
});

test("문서에서 번호 찾기 → 대장에 없는 것을 제안", () => {
  const text = "【발명의 명칭】 그래핀 기반 전파 흡수체 및 그 제조방법\n출원번호 10-2025-0011223\n출원일자 2025.02.14\n등록번호 제 10-2777888-0000 호\n등록일 2025. 9. 1.";
  const n = ip.readNumbers(text);
  assert.deepStrictEqual(n.appNos, ["10-2025-0011223"]);
  assert.deepStrictEqual(n.regNos, ["10-2777888"]);
  assert.strictEqual(n.title, "그래핀 기반 전파 흡수체 및 그 제조방법");
  assert.deepStrictEqual([n.appDate, n.regDate], ["2025-02-14", "2025-09-01"]);
  const data = { version: 1, items: [{ appNo: "10-2024-0123456", regNo: "" }] };
  const s = ip.suggestions(data, [
    { rel: "a/특허증.pdf", category: "ip_patent_reg", text },
    { rel: "a/출원서.hwp", category: "ip_patent_app", text: "출원번호 10-2024-0123456 (이미 있음)" },
    { rel: "a/상표출원서_40-2023-0098765.pdf", category: "ip_mark", text: "상표등록출원서" }, // 파일 이름의 번호
    { rel: "a/명세서.hwp", category: "ip_patent_app", text: "【발명의 명칭】 그래핀 필름\n" + "배경 기술 ".repeat(200) + "\n【선행기술문헌】 특허문헌 1: 한국공개특허 제10-2011-0003275호" }, // 선행기술 번호는 빼기
    { rel: "a/견적.pdf", category: "purchase", text: "10-2026-0000001" }, // 지식재산 문서가 아니면 보지 않는다
  ]);
  assert.deepStrictEqual(s.map((x) => [x.appNo, x.right, x.regNo, x.docs.join()]), [
    ["10-2025-0011223", "특허", "10-2777888", "a/특허증.pdf"],
    ["40-2023-0098765", "상표", "", "a/상표출원서_40-2023-0098765.pdf"],
  ]);
});
