// 같은 문서의 여러 버전을 묶는다.
// "엠씨케이테크_IR_260406.pptx", "엠씨케이테크_IR_초안.pptx", "엠씨케이테크_IR (2).pdf" 처럼
// 버전 표시(초안·최종·v01·날짜·(2)·사본)만 다른 파일은 같은 묶음으로 보고, 가장 최근에 고친 것을 최신본으로 한다.

// 이름에서 지울 버전 표시들
const VERSION_PATTERNS = [
  /\(\s*\d+\s*\)/g, // (2)
  /[-_ ]?(?:복사본|사본)(?:\s*\(\d+\))?/g,
  /(?<![A-Za-z])(?:copy\s*of|copy)(?![A-Za-z])/gi,
  /(?<![A-Za-z])(?:v|ver|rev|r)\.?\s?\d+(?:[._]\d+)*(?![A-Za-z])/gi, // v01, ver.2, rev3, v1.2
  /(?<![A-Za-z])(?:final|draft|fin|revised|latest|old|new)(?![A-Za-z])/gi,
  /최종본|최종안|최종|초안|가안|수정본|수정안|검토본|제출본|송부본|배포본|발표본|[0-9]+차\s*수정|수정\s*\d*(?!사업|계획)/g,
  /(?<!\d)20\d{2}[-.\s_/]?\d{2}[-.\s_/]?\d{2}(?!\d)/g, // 2025-05-08, 20250508
  /(?<!\d)\d{2}[-._]?\d{2}[-._]?\d{2}(?!\d)/g, // 250926, 25.09.26
  /(?<!\d)\d{4}(?!\d)(?=\s*$)/g, // 끝에 붙은 4자리 (0406 같은 월일)
];

// 묶음 열쇠: 버전 표시를 지우고, 기호·띄어쓰기를 없앤 소문자 이름
function familyKey(baseName) {
  let s = baseName.replace(/\.[^.]+$/, "");
  for (const re of VERSION_PATTERNS) s = s.replace(re, " ");
  s = s.toLowerCase().replace(/[\s_\-.,·()[\]{}~+]+/g, "");
  return s;
}

// 너무 짧거나 흔한 이름("보고서", "자료")은 서로 다른 문서일 가능성이 높아 묶지 않는다.
const GENERIC = new Set(["보고서", "자료", "문서", "발표", "발표자료", "회의록", "메모", "견적서", "계획서", "제안서", "untitled", "document", "presentation", "새문서", "제목없음"]);

function groupable(key) {
  return key.length >= 4 && !GENERIC.has(key);
}

/**
 * docs: [{ rel, base, mtimeMs }]
 * 결과: Map(rel → { key, size, latest(최신본 rel), order: [최신 → 예전 rel] })  — 버전이 2개 이상인 것만
 */
function groupVersions(docs) {
  const byKey = new Map();
  for (const d of docs) {
    const key = familyKey(d.base);
    if (!groupable(key)) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(d);
  }
  const out = new Map();
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
    const order = list.map((d) => d.rel);
    for (const d of list) out.set(d.rel, { key, size: list.length, latest: order[0], order });
  }
  return out;
}

module.exports = { familyKey, groupVersions };
