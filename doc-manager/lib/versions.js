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
// 형식 갈래: 같은 이름이라도 PDF 로 내보낸 것과 원본(워드·한글 …)은 버전이 아니라 다른 형식의 사본이다.
// (.hwp 와 .hwpx, .doc 와 .docx 처럼 같은 프로그램의 옛/새 형식은 같은 문서의 버전으로 본다)
const FORMAT_CLASS = { ".pdf": "pdf", ".doc": "word", ".docx": "word", ".hwp": "hwp", ".hwpx": "hwp", ".ppt": "ppt", ".pptx": "ppt", ".xls": "excel", ".xlsx": "excel" };

function familyKey(baseName) {
  const ext = (baseName.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  let s = baseName.replace(/\.[^.]+$/, "");
  for (const re of VERSION_PATTERNS) s = s.replace(re, " ");
  s = s.toLowerCase().replace(/[\s_\-.,·()[\]{}~+]+/g, "");
  const cls = FORMAT_CLASS[ext] || ext.slice(1);
  return s && cls ? `${s}|${cls}` : s;
}

// 너무 짧거나 흔한 이름("보고서", "자료")은 서로 다른 문서일 가능성이 높아 묶지 않는다.
const GENERIC = new Set(["보고서", "자료", "문서", "발표", "발표자료", "회의록", "메모", "견적서", "계획서", "제안서", "untitled", "document", "presentation", "새문서", "제목없음"]);

function groupable(key) {
  const name = key.split("|")[0];
  return name.length >= 4 && !GENERIC.has(name);
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

// ---- 새 버전 이름 정하기 ----

const pad = (n, width) => String(n).padStart(width, "0");
const VERSION_RE = /(?<![A-Za-z])(v|ver|rev)([._ ]?)(\d+)(?!\d)/i;

function validDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2015 && y <= new Date().getFullYear() + 1;
}

/**
 * 다음 버전의 파일 이름을 정한다. (같은 폴더에 만들 이름. 겹치는지는 부르는 쪽에서 다시 확인)
 *   보고서_v01.docx  → 보고서_v02.docx   (같은 문서의 다른 버전에 v05 가 있으면 v06)
 *   IR_260406.pptx   → IR_261009.pptx     (YYMMDD·YYYYMMDD 날짜는 오늘 날짜로)
 *   회사소개서.pptx  → 회사소개서_v2.pptx  (버전 표시가 없으면 _v2)
 * 이름 끝의 " (2)", " - 복사본" 같은 표시는 뗀다.
 */
function nextVersionName(fileName, siblings = [], now = new Date()) {
  const ext = (fileName.match(/\.[^.]+$/) || [""])[0];
  let stem = fileName.slice(0, fileName.length - ext.length);
  stem = stem.replace(/\s*\(\s*\d+\s*\)\s*$/, "").replace(/\s*-?\s*(복사본|사본|copy)(\s*\(\d+\))?\s*$/i, "").trim();

  // 1) v01 같은 번호: 같은 문서의 모든 버전 중 가장 큰 번호 + 1
  const m = stem.match(VERSION_RE);
  if (m) {
    let max = Number(m[3]);
    for (const s of siblings) {
      const sm = s.replace(/\.[^.]+$/, "").match(VERSION_RE);
      if (sm) max = Math.max(max, Number(sm[3]));
    }
    const width = m[3].length > 1 ? m[3].length : 1;
    return stem.replace(VERSION_RE, `${m[1]}${m[2]}${pad(max + 1, width)}`) + ext;
  }

  // 2) 날짜(YYYYMMDD 또는 YYMMDD): 오늘 날짜로. 이미 오늘 날짜면 _v2 를 붙인다.
  const y4 = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
  const today8 = `${y4}${pad(mo, 2)}${pad(d, 2)}`;
  const today6 = today8.slice(2);
  const d8 = stem.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (d8 && validDate(+d8[1], +d8[2], +d8[3])) {
    if (d8[0] !== today8) return stem.replace(d8[0], today8) + ext;
  } else {
    const d6 = stem.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/);
    if (d6 && validDate(2000 + +d6[1], +d6[2], +d6[3]) && d6[0] !== today6) return stem.replace(d6[0], today6) + ext;
  }

  // 3) 버전 표시가 없으면 _v2 (같은 문서에 _v2 가 이미 있으면 그다음)
  let n = 2;
  for (const s of siblings) {
    const sm = s.replace(/\.[^.]+$/, "").match(VERSION_RE);
    if (sm) n = Math.max(n, Number(sm[3]) + 1);
  }
  return `${stem}_v${n}${ext}`;
}

// 이름이 겹칠 때: 날짜 등은 그대로 두고 버전 번호만 올린다. (번호가 없으면 _v2)
function bumpNumber(name) {
  const ext = (name.match(/\.[^.]+$/) || [""])[0];
  const stem = name.slice(0, name.length - ext.length);
  const m = stem.match(VERSION_RE);
  if (!m) return `${stem}_v2${ext}`;
  const width = m[3].length > 1 ? m[3].length : 1;
  return stem.replace(VERSION_RE, `${m[1]}${m[2]}${pad(Number(m[3]) + 1, width)}`) + ext;
}

// 이미 같은 이름이 있으면 번호를 하나씩 올려 비어 있는 이름을 찾는다. exists(name) → boolean
function uniqueVersionName(name, exists) {
  let cur = name;
  for (let i = 0; i < 500 && exists(cur); i++) cur = bumpNumber(cur);
  return cur;
}

module.exports = { familyKey, groupVersions, nextVersionName, uniqueVersionName };
