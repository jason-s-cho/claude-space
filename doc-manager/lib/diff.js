// 두 문서 본문 비교: 문단 단위로 같은/바뀐/추가/삭제를 찾고, 바뀐 문단은 낱말 단위로 어디가 달라졌는지 표시한다.
// Myers 차이 알고리즘(O((N+M)·D))을 쓴다.

/**
 * a, b 배열의 최소 편집 경로. 결과: [{ op: "eq" | "del" | "ins", a?, b? }] (a·b 는 원소 위치)
 */
function myers(a, b, eq = (x, y) => x === y) {
  const n = a.length, m = b.length;
  // 앞뒤 공통 부분은 먼저 떼어 낸다 (대부분의 문서 버전은 거의 같다)
  let start = 0;
  while (start < n && start < m && eq(a[start], b[start])) start++;
  let endA = n, endB = m;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) endA--, endB--;
  const A = a.slice(start, endA), B = b.slice(start, endB);
  const N = A.length, M = B.length;
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: "eq", a: i, b: i });
  if (N || M) {
    const off = N + M;
    const v = new Int32Array(2 * off + 2);
    const trace = [];
    let found = false;
    const budget = 4e7; // 되짚기용 기록이 너무 커지면(완전히 다른 큰 문서) 통째로 삭제+추가로 본다
    for (let d = 0; d <= N + M && !found; d++) {
      if (d * v.length > budget) {
        for (let i = 0; i < N; i++) ops.push({ op: "del", a: start + i });
        for (let j = 0; j < M; j++) ops.push({ op: "ins", b: start + j });
        for (let i = 0; i < n - endA; i++) ops.push({ op: "eq", a: endA + i, b: endB + i });
        return ops;
      }
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && eq(A[x], B[y])) x++, y++;
        v[off + k] = x;
        if (x >= N && y >= M) {
          found = true;
          break;
        }
      }
    }
    // 되짚어 가며 경로 복원
    const mid = [];
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
      const vv = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
      const prevX = vv[off + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) mid.push({ op: "eq", a: start + --x, b: start + --y });
      if (d > 0) {
        if (x === prevX) mid.push({ op: "ins", b: start + --y });
        else mid.push({ op: "del", a: start + --x });
      }
    }
    ops.push(...mid.reverse());
  }
  for (let i = 0; i < n - endA; i++) ops.push({ op: "eq", a: endA + i, b: endB + i });
  return ops;
}

// 문단으로 나누기: 빈 줄은 버리고 앞뒤 공백·연속 공백을 정리해 비교한다
function paragraphs(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean);
}

// 낱말 단위 (공백도 하나의 조각으로 남겨 그대로 다시 붙일 수 있게)
function words(s) {
  return s.match(/\s+|[0-9.,%]+|[A-Za-z]+|[가-힣]+|[^\sA-Za-z0-9가-힣]/g) || [];
}

// 바뀐 문단 한 쌍의 낱말 비교: [{ t: "eq"|"del"|"ins", s }]
function inlineDiff(a, b) {
  const wa = words(a), wb = words(b);
  const out = [];
  const push = (t, s) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };
  for (const o of myers(wa, wb)) push(o.op === "eq" ? "eq" : o.op, o.op === "ins" ? wb[o.b] : wa[o.a]);
  return out;
}

// 두 문단이 같은 문단을 고친 것으로 볼 만큼 비슷한지 (낱말 겹침 비율)
function similar(a, b) {
  const wa = words(a).filter((w) => w.trim()), wb = words(b).filter((w) => w.trim());
  if (!wa.length || !wb.length) return false;
  const set = new Map();
  for (const w of wa) set.set(w, (set.get(w) || 0) + 1);
  let common = 0;
  for (const w of wb) {
    const c = set.get(w);
    if (c) common++, set.set(w, c - 1);
  }
  return common / Math.max(wa.length, wb.length) >= 0.35;
}

/**
 * 결과: {
 *   blocks: [{ t: "eq", a, b } | { t: "del", a } | { t: "ins", b } | { t: "mod", a, b, inline }],
 *   stats: { same, changed, added, removed },
 *   numbers: [{ before, after }]  // 바뀐 문단에서 숫자가 달라진 곳 (수치 실수 잡기용)
 * }
 */
function compareTexts(textA, textB) {
  const A = paragraphs(textA), B = paragraphs(textB);
  const ops = myers(A, B);
  const blocks = [];
  // 연달아 지워지고 들어온 문단은 짝을 지어 '고침'으로 본다
  for (let i = 0; i < ops.length; ) {
    if (ops[i].op === "eq") {
      blocks.push({ t: "eq", a: A[ops[i].a], b: B[ops[i].b] });
      i++;
      continue;
    }
    const dels = [], ins = [];
    while (i < ops.length && ops[i].op !== "eq") {
      if (ops[i].op === "del") dels.push(A[ops[i].a]);
      else ins.push(B[ops[i].b]);
      i++;
    }
    let j = 0;
    for (const d of dels) {
      if (j < ins.length && similar(d, ins[j])) {
        blocks.push({ t: "mod", a: d, b: ins[j], inline: inlineDiff(d, ins[j]) });
        j++;
      } else blocks.push({ t: "del", a: d });
    }
    for (; j < ins.length; j++) blocks.push({ t: "ins", b: ins[j] });
  }
  const stats = { same: 0, changed: 0, added: 0, removed: 0 };
  const numbers = [];
  for (const bl of blocks) {
    if (bl.t === "eq") stats.same++;
    else if (bl.t === "ins") stats.added++;
    else if (bl.t === "del") stats.removed++;
    else {
      stats.changed++;
      // 낱말 비교에서 숫자 조각이 지워지고 바로 들어온 곳
      for (let k = 0; k + 1 < bl.inline.length; k++) {
        const x = bl.inline[k], y = bl.inline[k + 1];
        if (x.t === "del" && y.t === "ins" && /\d/.test(x.s + y.s)) numbers.push({ before: x.s.trim(), after: y.s.trim() });
      }
    }
  }
  return { blocks, stats, numbers };
}

module.exports = { myers, compareTexts, inlineDiff, paragraphs };
