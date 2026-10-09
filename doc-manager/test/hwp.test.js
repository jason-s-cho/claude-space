const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const CFB = require("cfb");
const { extractHwp } = require("../lib/hwp");
const { extract } = require("../lib/extract");
const indexer = require("../lib/indexer");

// ---- 시험용 .hwp 만들기 (HWP 5.0 형식) ----
const PARA_TEXT = 67;
function record(tag, payload) {
  const big = payload.length >= 0xfff;
  const head = Buffer.alloc(big ? 8 : 4);
  head.writeUInt32LE(((tag & 0x3ff) | ((big ? 0xfff : payload.length) << 20)) >>> 0, 0);
  if (big) head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}
// 글자와 제어 문자 섞기: { ctrl: 코드 } 는 제어 문자 (8글자짜리는 뒤에 7글자 더 붙음)
function paraText(parts) {
  const units = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) units.push(ch.charCodeAt(0));
    else if ([0, 10, 13].includes(p.ctrl) || (p.ctrl >= 24 && p.ctrl <= 31)) units.push(p.ctrl);
    else units.push(p.ctrl, 0x7461, 0x6c62, 0, 0, 0, 0, p.ctrl); // 표 같은 개체 자리 (내용은 무시돼야 함)
  }
  const b = Buffer.alloc(units.length * 2);
  units.forEach((u, i) => b.writeUInt16LE(u, i * 2));
  return record(PARA_TEXT, b);
}
function makeHwp({ sections, preview = "", flags = 1 }) {
  const cfb = CFB.utils.cfb_new();
  const head = Buffer.alloc(256);
  head.write("HWP Document File", 0, "latin1");
  head.writeUInt32LE(0x05000300, 32);
  head.writeUInt32LE(flags, 36);
  CFB.utils.cfb_add(cfb, "/FileHeader", head);
  sections.forEach((recs, i) => {
    const body = Buffer.concat(recs.concat([record(66, Buffer.alloc(10))])); // 문단 머리 같은 다른 레코드도 섞음
    CFB.utils.cfb_add(cfb, `/BodyText/Section${i}`, flags & 1 ? zlib.deflateRawSync(body) : body);
  });
  CFB.utils.cfb_add(cfb, "/PrvText", Buffer.from(preview, "utf16le"));
  return Buffer.from(CFB.write(cfb, { type: "buffer" }));
}

test("본문 문단을 읽는다 (압축, 여러 구역, 제어 문자)", () => {
  const buf = makeHwp({
    sections: [
      [paraText(["2025년 소재부품기술개발 사업계획서", { ctrl: 13 }]), paraText(["주관기관", { ctrl: 9 }, "엠씨케이테크", { ctrl: 11 }, "표 뒤 글자", { ctrl: 13 }])],
      [paraText(["둘째 구역의 그래핀 스텔스", { ctrl: 10 }, "다음 줄", { ctrl: 13 }])],
    ],
    preview: "미리보기",
  });
  const r = extractHwp(buf);
  assert.strictEqual(r.protected, false);
  assert.match(r.text, /2025년 소재부품기술개발 사업계획서\n/);
  assert.match(r.text, /주관기관\t엠씨케이테크표 뒤 글자/); // 탭은 탭으로, 개체 자리(8글자)는 건너뜀
  assert.match(r.text, /둘째 구역의 그래핀 스텔스\n다음 줄/);
  assert.ok(!r.text.includes("미리보기")); // 본문이 있으면 미리보기를 쓰지 않음
});

test("긴 문단(크기 4095 이상)과 압축하지 않은 문서", () => {
  const long = "가".repeat(3000); // 6000 바이트 → 확장 크기 머리말
  const r = extractHwp(makeHwp({ sections: [[paraText([long, { ctrl: 13 }]), paraText(["끝", { ctrl: 13 }])]], flags: 0 }));
  assert.ok(r.text.startsWith(long + "\n끝"));
});

test("암호·배포용 문서는 미리보기 글자만", () => {
  for (const flags of [1 | 2, 1 | 4]) {
    const r = extractHwp(makeHwp({ sections: [[paraText(["암호화된 본문", { ctrl: 13 }])]], preview: "<과제명><그래핀 패널>\r\n", flags }));
    assert.strictEqual(r.protected, true);
    assert.match(r.text, /과제명 {2}그래핀 패널/);
    assert.ok(!r.text.includes("<"));
  }
});

test("한글 문서가 아니면 오류 (앱은 파일 이름으로만 분류)", () => {
  assert.throws(() => extractHwp(Buffer.from("HWP Document File V3.00 옛 형식")));
});

test("앱의 본문 추출·분류에 .hwp 가 들어간다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-hwp-"));
  const f = path.join(dir, "제출본.hwp");
  fs.writeFileSync(f, makeHwp({ sections: [[paraText(["연구개발계획서", { ctrl: 13 }]), paraText(["주관연구개발기관 정부지원연구개발비 연구개발 목표", { ctrl: 13 }])]] }));
  const x = await extract(f);
  assert.strictEqual(x.kind, "hwp");
  assert.match(x.text, /주관연구개발기관/);
  const index = indexer.emptyIndex(dir);
  await indexer.scan(index, {});
  assert.strictEqual(indexer.effective(index.files["제출본.hwp"]).category, "gov_plan");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("예전 버전이 본문 없이 색인한 .hwp 는 한 번 다시 읽는다 (직접 고친 것은 유지)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-hwp-"));
  const f = path.join(dir, "보고서.hwp");
  fs.writeFileSync(f, makeHwp({ sections: [[paraText(["최종보고서 본문입니다", { ctrl: 13 }])]] }));
  const st = fs.statSync(f);
  const old = indexer.emptyIndex(dir);
  old.files["보고서.hwp"] = { rel: "보고서.hwp", size: st.size, mtimeMs: Math.round(st.mtimeMs), text: "", kind: "hwp", note: "메모", userTags: ["중요"] };
  const file = path.join(dir, "index.json");
  indexer.saveIndex(file, old);
  const index = indexer.loadIndex(file, dir);
  const r = await indexer.scan(index, {});
  assert.strictEqual(r.updated, 1);
  const e = index.files["보고서.hwp"];
  assert.match(e.text, /최종보고서 본문/);
  assert.strictEqual(e.note, "메모");
  assert.deepStrictEqual(e.userTags, ["중요"]);
  // 다시 열면 또 읽지 않는다
  indexer.saveIndex(file, index);
  assert.strictEqual((await indexer.scan(indexer.loadIndex(file, dir), {})).updated, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
