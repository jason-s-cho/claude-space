const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ocr = require("../lib/ocr");
const { extract } = require("../lib/extract");

const FIXTURE = path.join(__dirname, "fixtures", "scanned.pdf");

test("스캔 PDF 알아보기: 페이지에 비해 글자가 거의 없는 PDF", async () => {
  const x = await extract(FIXTURE);
  assert.strictEqual(x.pages, 2);
  assert.ok(ocr.needsOcr({ rel: "a/스캔.pdf", pages: x.pages, text: x.text }));
  assert.ok(!ocr.needsOcr({ rel: "a/보통.pdf", pages: 2, text: "가".repeat(100) }));
  assert.ok(!ocr.needsOcr({ rel: "a/스캔.hwp", pages: 2, text: "" }));
  assert.ok(!ocr.needsOcr({ rel: "a/깨진.pdf", pages: 2, text: "", error: "x" }));
});

test("OCR: 윈도우 전용, 언어 없음 안내, 결과는 문서 폴더에 남겨 다시 읽지 않는다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  const pdf = path.join(root, "공고문 스캔.pdf");
  fs.copyFileSync(FIXTURE, pdf);
  await assert.rejects(ocr.ocrPdf(pdf, { platform: "linux" }), /윈도우/);
  await assert.rejects(ocr.ocrPdf(pdf, { platform: "win32", run: async () => ({ ok: false, code: "nolang" }) }), /광학 문자 인식/);

  let calls = 0, seenEnv = null;
  const progress = [];
  const run = async (script, env, opts) => {
    calls++;
    seenEnv = env;
    opts.onLine({ page: 1, of: 2 });
    const n = Math.min(2, +env.DM_MAXPAGES);
    return { ok: true, total: 2, lang: "ko", pages: ["접수 마감 2026-11-20", "평가 기준"].slice(0, n) };
  };
  const r1 = await ocr.ocrWithCache(root, pdf, { platform: "win32", run, maxPages: 1, onProgress: (p) => progress.push(p) });
  assert.deepStrictEqual([r1.pages, r1.total, r1.fromCache, calls], [1, 2, false, 1]);
  assert.strictEqual(seenEnv.DM_SRC, pdf);
  assert.deepStrictEqual(progress, [{ page: 1, of: 2 }]);
  // 같은 범위는 남겨 둔 것을 쓴다
  const r2 = await ocr.ocrWithCache(root, pdf, { platform: "win32", run, maxPages: 1 });
  assert.deepStrictEqual([r2.fromCache, calls], [true, 1]);
  // 더 많이 읽어 달라면 다시 읽는다
  const r3 = await ocr.ocrWithCache(root, pdf, { platform: "win32", run, maxPages: 60 });
  assert.deepStrictEqual([r3.pages, r3.fromCache, calls], [2, false, 2]);
  assert.match(r3.text, /접수 마감 2026-11-20\n평가 기준/);
  // 이름을 바꾼 같은 파일도 남겨 둔 글자를 쓴다
  const moved = path.join(root, "다른 이름.pdf");
  fs.copyFileSync(pdf, moved);
  assert.match((await ocr.cachedText(root, moved)).text, /평가 기준/);
  assert.strictEqual(fs.readdirSync(path.join(root, ".docmanager", "ocr")).length, 1);
});

// 실제 윈도우 글자 인식 (윈도우 CI 에서만). 한국어가 없으면 이 PC 언어(영어)로 읽는다.
test("윈도우 글자 인식으로 스캔 PDF 읽기", { skip: process.platform !== "win32" && "윈도우 전용" }, async (t) => {
  let r;
  try {
    r = await ocr.ocrPdf(FIXTURE, { maxPages: 5 });
  } catch (e) {
    if (/언어가 없습니다|쓸 수 없습니다/.test(e.message)) return t.skip(e.message);
    throw e;
  }
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.pages.length, 2);
  assert.match(r.pages[0], /GRAPHENE/i);
  assert.match(r.pages[1], /SECOND/i);
});
