const test = require("node:test");
const assert = require("node:assert");
const { myers, compareTexts } = require("../lib/diff");

// 가장 긴 공통 부분 길이 (검산용, 작은 입력만)
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

test("myers: 경로로 두 배열을 그대로 다시 만들 수 있고, 같은 부분이 최대다", () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rand(12) }, () => "abcd"[rand(4)]);
    const b = Array.from({ length: rand(12) }, () => "abcd"[rand(4)]);
    const ops = myers(a, b);
    assert.deepStrictEqual(ops.filter((o) => o.op !== "ins").map((o) => a[o.a]), a);
    assert.deepStrictEqual(ops.filter((o) => o.op !== "del").map((o) => b[o.b]), b);
    for (const o of ops) if (o.op === "eq") assert.strictEqual(a[o.a], b[o.b]);
    assert.strictEqual(ops.filter((o) => o.op === "eq").length, lcs(a, b), JSON.stringify([a, b]));
  }
});

test("문서 비교: 고친 문단·추가·삭제와 바뀐 숫자", () => {
  const before = "1. 개요\n그래핀 300mm급 무손상 전사 기술을 개발한다.\n\n시장 규모는 2025년 1.2조 원이다.\n참고 문헌";
  const after = "1. 개요\n그래핀 200mm급 무손상 전사 기술을 개발한다.\n시장 규모는 2025년 1.2조 원이다.\n새 문단: 국내 표준 동향을 추가한다.";
  const r = compareTexts(before, after);
  assert.deepStrictEqual(r.stats, { same: 2, changed: 1, added: 1, removed: 1 });
  const mod = r.blocks.find((b) => b.t === "mod");
  assert.deepStrictEqual(mod.inline.filter((x) => x.t !== "eq"), [{ t: "del", s: "300" }, { t: "ins", s: "200" }]);
  assert.deepStrictEqual(r.numbers, [{ before: "300", after: "200" }]);
  assert.deepStrictEqual(r.blocks.map((b) => b.t), ["eq", "mod", "eq", "del", "ins"]);
  // 전혀 다른 문단은 '고침'이 아니라 삭제+추가로
  assert.deepStrictEqual(compareTexts("가나다 라마", "XYZ 123").blocks.map((b) => b.t), ["del", "ins"]);
  assert.deepStrictEqual(compareTexts("같음", "같음").stats, { same: 1, changed: 0, added: 0, removed: 0 });
});

test("문서 비교: 큰 문서도 빨리 (앞뒤가 같은 경우)", () => {
  const base = Array.from({ length: 20000 }, (_, i) => `문단 ${i} 내용`).join("\n");
  const changed = base.replace("문단 10000 내용", "문단 10000 고친 내용");
  const t = Date.now();
  const r = compareTexts(base, changed);
  assert.ok(Date.now() - t < 2000);
  assert.strictEqual(r.stats.changed, 1);
});

test("문서 비교: 완전히 다른 큰 문서는 통째로 삭제+추가 (메모리 폭주 없이)", () => {
  const a = Array.from({ length: 6000 }, (_, i) => `가${i}`).join("\n");
  const b = Array.from({ length: 6000 }, (_, i) => `나${i}`).join("\n");
  const t = Date.now();
  const r = compareTexts(a, b);
  assert.ok(Date.now() - t < 5000);
  assert.strictEqual(r.stats.removed + r.stats.changed, 6000);
});
