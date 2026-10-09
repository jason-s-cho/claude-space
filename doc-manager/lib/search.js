// 검색어 해석과 문서 맞추기.
//
//   그래핀 센서          두 단어가 모두 들어 있는 문서
//   "전자파 차폐"        구절 그대로 (띄어쓰기는 무시: "전자파차폐"도 찾음)
//   그래핀|graphene      둘 중 하나라도
//   -초안                이 단어가 들어 있는 문서는 빼기
//   #KEIT  태그:KEIT     태그
//   분류:보고서           분류 이름에 '보고서'가 들어간 것
//   연도:2025            연도 태그나 수정한 해
//   형식:ppt             word / ppt / excel / pdf / hwp (워드·파워포인트·엑셀·한글도 됨)
//   폴더:고객사  이름:최종  메모:제출  키워드:그래핀

const FIELD_ALIASES = {
  태그: "tag", tag: "tag",
  분류: "cat", 종류: "cat", cat: "cat", category: "cat",
  연도: "year", 년도: "year", 해: "year", year: "year",
  형식: "kind", 파일: "kind", type: "kind", kind: "kind", ext: "kind",
  폴더: "dir", 경로: "dir", folder: "dir", dir: "dir",
  이름: "name", 파일명: "name", 제목: "name", name: "name",
  메모: "note", note: "note",
  키워드: "kw", kw: "kw", keyword: "kw",
};

const KIND_ALIASES = {
  word: "word", 워드: "word", doc: "word", docx: "word",
  ppt: "ppt", pptx: "ppt", 파워포인트: "ppt", 피피티: "ppt", powerpoint: "ppt",
  excel: "excel", 엑셀: "excel", xls: "excel", xlsx: "excel",
  pdf: "pdf",
  hwp: "hwp", hwpx: "hwp", 한글: "hwp", 아래아한글: "hwp",
};

const ns = (s) => s.replace(/\s+/g, "");

function tokenize(q) {
  const out = [];
  const re = /(-?)(?:([^\s:"]+):)?(?:"([^"]*)"?|(\S+))/g;
  let m;
  while ((m = re.exec(q))) {
    const neg = m[1] === "-";
    let field = m[2] ? FIELD_ALIASES[m[2].toLowerCase()] || null : null;
    let value = m[3] !== undefined ? m[3] : m[4] || "";
    let quoted = m[3] !== undefined;
    // 알 수 없는 "필드:" 는 그냥 글자로 본다 (예: 10:30)
    if (m[2] && !field) value = m[2] + ":" + value;
    if (!field && !quoted && value.startsWith("#") && value.length > 1) {
      field = "tag";
      value = value.slice(1);
    }
    value = value.trim();
    if (!value || value === "-") continue;
    out.push({ neg, field, value, quoted });
  }
  return out;
}

// 결과: { terms: [{ alts: [소문자] , neg }], filters: [{ field, value, neg }], highlight: [원래 글자] }
function parseQuery(q) {
  const parsed = { terms: [], filters: [], highlight: [] };
  for (const t of tokenize(String(q || ""))) {
    if (t.field) {
      parsed.filters.push({ field: t.field, value: t.value.toLowerCase(), neg: t.neg });
      if (!t.neg && ["kw", "note", "name", "tag"].includes(t.field)) parsed.highlight.push(t.value);
      continue;
    }
    const alts = (t.quoted ? [t.value] : t.value.split("|")).map((a) => a.trim().toLowerCase()).filter(Boolean);
    if (!alts.length) continue;
    parsed.terms.push({ alts, neg: t.neg });
    if (!t.neg) parsed.highlight.push(...alts);
  }
  return parsed;
}

function isEmpty(parsed) {
  return !parsed.terms.length && !parsed.filters.length;
}

// view: 문서 하나를 검색하기 좋게 펼친 것 (main.js 의 searchView)
//   { name, dir, title, note, tags[], keywords[], kind, ext, years[], catText, text, textNs }
function filterOk(view, f) {
  const v = f.value;
  switch (f.field) {
    case "tag": return view.tags.some((t) => t.toLowerCase().includes(v));
    case "cat": return view.catText.toLowerCase().includes(v);
    case "year": return view.years.includes(v);
    case "kind": {
      const k = KIND_ALIASES[v] || v;
      return view.kind === k || view.ext === v;
    }
    case "dir": return ns(view.dir.toLowerCase()).includes(ns(v));
    case "name": return ns(view.name.toLowerCase()).includes(ns(v));
    case "note": return view.note.toLowerCase().includes(v);
    case "kw": return view.keywords.some((k) => ns(k.toLowerCase()).includes(ns(v)));
    default: return true;
  }
}

function countUpTo(hay, needle, cap) {
  let n = 0, i = 0;
  while (n < cap && (i = hay.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

// 맞으면 점수(>0), 아니면 0
function matchView(view, parsed) {
  for (const f of parsed.filters) {
    const ok = filterOk(view, f);
    if (ok === f.neg) return 0;
  }
  const meta = ns([view.name, view.dir, view.title, view.note, view.tags.join(" "), view.keywords.join(" ")].join(" ").toLowerCase());
  let score = 1;
  for (const t of parsed.terms) {
    let best = 0;
    for (const a of t.alts) {
      const n = ns(a);
      if (!n) continue;
      if (ns(view.name.toLowerCase()).includes(n)) best = Math.max(best, 20);
      else if (meta.includes(n)) best = Math.max(best, 10);
      else {
        const c = countUpTo(view.textNs, n, 20);
        if (c) best = Math.max(best, 1 + Math.log2(1 + c));
      }
    }
    if (t.neg) {
      if (best > 0) return 0;
    } else {
      if (!best) return 0;
      score += best;
    }
  }
  return score;
}

// 검색어가 처음 나온 곳 앞뒤를 잘라 보여 준다.
function snippet(text, highlight) {
  if (!text || !highlight.length) return "";
  const lower = text.toLowerCase();
  let at = -1, len = 0;
  for (const h of highlight) {
    const i = lower.indexOf(h.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = h.length;
    }
  }
  if (at < 0) return "";
  const start = Math.max(0, at - 50);
  return (start > 0 ? "…" : "") + text.slice(start, at + len + 100).replace(/\s+/g, " ") + "…";
}

module.exports = { parseQuery, matchView, snippet, isEmpty, KIND_ALIASES };
