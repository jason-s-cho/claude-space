// 파일 이름 · 폴더 이름 · 본문 글자에서 키워드를 찾아 문서 종류를 정하고 태그를 붙인다.
// 파일 이름에 나온 단어가 가장 강한 근거이고, 그다음이 폴더 이름, 본문 앞부분, 본문 순서다.

const CATEGORIES = [
  { id: "gov_demand", group: "국가과제", label: "수요조사서", color: "#2b59c3" },
  { id: "gov_plan", group: "국가과제", label: "과제계획서", color: "#3f6fd8" },
  { id: "gov_report", group: "국가과제", label: "과제보고서", color: "#5a86e6" },
  { id: "gov_etc", group: "국가과제", label: "기타 과제자료", color: "#7c9ce8" },
  { id: "ir", group: "회사소개", label: "IR 자료", color: "#a5428a" },
  { id: "company", group: "회사소개", label: "회사소개서", color: "#c066a8" },
  { id: "website", group: "홍보", label: "홈페이지", color: "#12807a" },
  { id: "catalog", group: "홍보", label: "카탈로그", color: "#2f8a5f" },
  { id: "request", group: "대외", label: "고객사·협력사 요청자료", color: "#c47a12" },
  { id: "other", group: "", label: "미분류", color: "#6b7280" },
];

// [키워드, 가중치]. 영문 키워드는 대소문자를 구분하지 않고 단어 단위로 찾는다.
const KEYWORDS = {
  gov: [
    ["국가연구개발", 3], ["연구개발과제", 3], ["정부출연금", 3], ["정부지원연구개발비", 3], ["주관연구개발기관", 3],
    ["주관기관", 2], ["참여기관", 2], ["공동연구개발기관", 2], ["위탁연구", 2], ["과제번호", 2], ["연구책임자", 2],
    ["전담기관", 2], ["전문기관", 1], ["국가과제", 3], ["정부과제", 3], ["R&D", 1], ["연구개발비", 2],
    ["기술개발사업", 2], ["사업단", 1], ["IRIS", 2], ["범부처통합연구지원시스템", 3], ["총괄과제", 2], ["세부과제", 2],
  ],
  gov_demand: [
    ["수요조사서", 6], ["수요조사", 5], ["기술수요", 4], ["수요 조사", 4], ["기획수요", 4], ["RFP", 2],
    ["제안요청서", 2], ["수요제안", 4], ["과제 제안서", 2],
  ],
  gov_plan: [
    ["과제계획서", 6], ["연구개발계획서", 6], ["사업계획서", 5], ["연구계획서", 5], ["수행계획서", 5],
    ["과제신청서", 5], ["신청서", 2], ["추진계획", 2], ["연구개발 목표", 3], ["연구개발목표", 3],
    ["연구개발 내용", 2], ["추진전략", 2], ["추진체계", 2], ["기대효과", 1], ["활용방안", 1], ["사업화 계획", 2],
  ],
  gov_report: [
    ["결과보고서", 6], ["최종보고서", 6], ["중간보고서", 6], ["연차보고서", 6], ["단계보고서", 6],
    ["연차실적", 5], ["진도점검", 5], ["성과보고", 4], ["실적보고", 4], ["연구개발 결과", 3], ["연구개발결과", 3],
    ["자체평가", 3], ["정산보고", 4], ["성과활용", 2], ["목표 달성도", 3], ["목표달성도", 3], ["보고서", 1],
  ],
  ir: [
    ["IR", 5], ["IR deck", 6], ["IR자료", 6], ["investor", 4], ["pitch", 3], ["pitch deck", 6], ["투자유치", 5],
    ["투자제안서", 6], ["투자 제안", 4], ["밸류에이션", 4], ["valuation", 3], ["시리즈 A", 4], ["Series A", 4],
    ["시드 투자", 3], ["TAM", 2], ["SAM", 1], ["SOM", 1], ["exit", 1], ["투자금", 3], ["투자 유치", 4],
    ["재무 계획", 2], ["매출 전망", 2], ["Use of Funds", 4], ["자금 사용", 3], ["주주", 2], ["지분", 2], ["cap table", 4],
  ],
  company: [
    ["회사소개서", 7], ["회사소개", 6], ["회사 소개", 5], ["기업소개", 6], ["company profile", 6], ["company introduction", 6],
    ["회사개요", 4], ["회사 개요", 4], ["기업개요", 4], ["연혁", 3], ["CEO 인사말", 4], ["대표이사 인사말", 4],
    ["조직도", 2], ["비전", 1], ["핵심가치", 2], ["주요 고객사", 2], ["주요 실적", 2], ["about us", 4],
  ],
  website: [
    ["홈페이지", 6], ["웹사이트", 6], ["website", 5], ["web site", 5], ["사이트맵", 5], ["sitemap", 4],
    ["메뉴 구조", 4], ["메뉴구조", 4], ["와이어프레임", 4], ["wireframe", 4], ["스토리보드", 3], ["GNB", 3],
    ["메인 페이지", 3], ["메인페이지", 3], ["랜딩 페이지", 3], ["landing page", 3], ["SEO", 2], ["UI", 1], ["URL", 1],
  ],
  catalog: [
    ["카탈로그", 7], ["catalog", 6], ["catalogue", 6], ["브로셔", 6], ["브로슈어", 6], ["brochure", 6],
    ["리플렛", 5], ["리플릿", 5], ["leaflet", 5], ["datasheet", 5], ["데이터시트", 5], ["제품소개", 4], ["제품안내", 4],
    ["제품 사양", 3], ["제품사양", 3], ["specification", 3], ["사양", 1], ["모델명", 2], ["라인업", 2], ["lineup", 2],
  ],
  request: [
    ["요청자료", 6], ["요청 자료", 6], ["요청하신", 4], ["제출자료", 5], ["제출 자료", 5], ["회신", 3], ["견적서", 5],
    ["견적", 3], ["quotation", 4], ["업체등록", 5], ["협력사 등록", 5], ["협력업체", 3], ["협력사", 3], ["고객사", 2],
    ["거래처", 3], ["납품", 2], ["시험성적서", 4], ["품질보증", 2], ["보안서약서", 4], ["비밀유지", 3], ["NDA", 4],
    ["질의응답", 2], ["답변서", 4], ["체크리스트", 2], ["checklist", 2], ["설문", 2], ["실사", 2],
  ],
};

// 띄어쓰기는 있어도 없어도 같은 키워드로 찾으므로("요청 자료" = "요청자료") 겹치는 항목은 하나로 합친다.
for (const key of Object.keys(KEYWORDS)) {
  const best = new Map();
  for (const [kw, w] of KEYWORDS[key]) {
    const k = kw.replace(/\s+/g, "").toLowerCase();
    if (!best.has(k) || best.get(k)[1] < w) best.set(k, [kw, w]);
  }
  KEYWORDS[key] = [...best.values()];
}

const AGENCIES = [
  ["산업통상자원부", ["산업통상자원부", "산업부", "MOTIE"]],
  ["중소벤처기업부", ["중소벤처기업부", "중기부", "MSS"]],
  ["과학기술정보통신부", ["과학기술정보통신부", "과기정통부", "과기부", "MSIT"]],
  ["국토교통부", ["국토교통부", "국토부"]],
  ["환경부", ["환경부"]],
  ["해양수산부", ["해양수산부", "해수부"]],
  ["농림축산식품부", ["농림축산식품부", "농식품부"]],
  ["보건복지부", ["보건복지부", "복지부"]],
  ["방위사업청", ["방위사업청", "방사청"]],
  ["KEIT", ["한국산업기술기획평가원", "KEIT"]],
  ["KIAT", ["한국산업기술진흥원", "KIAT"]],
  ["IITP", ["정보통신기획평가원", "IITP"]],
  ["NIPA", ["정보통신산업진흥원", "NIPA"]],
  ["TIPA", ["중소기업기술정보진흥원", "TIPA"]],
  ["한국연구재단", ["한국연구재단", "NRF"]],
  ["KETEP", ["한국에너지기술평가원", "KETEP"]],
  ["창업진흥원", ["창업진흥원", "KISED"]],
  ["KAIA", ["국토교통과학기술진흥원", "KAIA"]],
  ["KEITI", ["한국환경산업기술원", "KEITI"]],
  ["KHIDI", ["한국보건산업진흥원", "KHIDI"]],
  ["KRIT", ["국방기술진흥연구소", "KRIT"]],
  ["IPET", ["농림식품기술기획평가원", "IPET"]],
  ["KIMST", ["해양수산과학기술진흥원", "KIMST"]],
  ["KOTRA", ["대한무역투자진흥공사", "KOTRA"]],
  ["TP(테크노파크)", ["테크노파크"]],
];

const STAGE_TAGS = [
  ["중간보고", ["중간보고"]],
  ["최종보고", ["최종보고", "결과보고"]],
  ["연차보고", ["연차보고", "연차실적"]],
  ["최종본", ["최종본", "최종", "final"]],
  ["초안", ["초안", "draft", "가안"]],
  ["수정본", ["수정본", "수정", "rev", "revised"]],
];

const LATIN_ONLY = /^[\x20-\x7e]+$/;
const regexCache = new Map();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 키워드 하나를 찾는 정규식. 영문은 앞뒤에 다른 영문자가 붙어 있으면 무시한다. (IR ≠ IRB, first)
function keywordRe(kw) {
  let re = regexCache.get(kw);
  if (!re) {
    const body = escapeRe(kw).replace(/ /g, "\\s*");
    re = LATIN_ONLY.test(kw) ? new RegExp(`(?<![A-Za-z])${body}(?![A-Za-z])`, "gi") : new RegExp(body, "gi");
    regexCache.set(kw, re);
  }
  re.lastIndex = 0;
  return re;
}

function countIn(text, kw, cap) {
  if (!text) return 0;
  const re = keywordRe(kw);
  let n = 0;
  while (re.exec(text) && n < cap) n++;
  return n;
}

// 문서를 파일 이름 / 폴더 / 본문 앞부분 / 본문 으로 나눈다.
function sections(doc) {
  const text = doc.text || "";
  return {
    name: doc.name || "",
    dir: doc.dir || "",
    head: [doc.title || "", text.slice(0, 1500)].join("\n"),
    body: text.slice(1500),
  };
}

const WHERE = { name: "파일 이름", dir: "폴더", head: "본문 앞부분", body: "본문" };

function scoreList(sec, list) {
  let score = 0;
  const hits = [];
  for (const [kw, w] of list) {
    let s = 0;
    let where = "";
    if (countIn(sec.name, kw, 1)) { s += w * 4; where = "name"; }
    if (countIn(sec.dir, kw, 1)) { s += w * 3; where = where || "dir"; }
    const h = countIn(sec.head, kw, 3);
    if (h) { s += w * (1 + 0.5 * (h - 1)); where = where || "head"; }
    const b = countIn(sec.body, kw, 4);
    if (b) { s += w * 0.25 * b; where = where || "body"; }
    if (s > 0) { score += s; hits.push({ kw, where, s }); }
  }
  hits.sort((a, b) => b.s - a.s);
  return { score, hits };
}

function normalizePartners(partners) {
  return (partners || [])
    .map((p) => (typeof p === "string" ? { name: p, aliases: [] } : p))
    .filter((p) => p && p.name && p.name.trim())
    .map((p) => ({ name: p.name.trim(), aliases: [p.name.trim(), ...(p.aliases || []).map((a) => a.trim()).filter(Boolean)] }));
}

const MIN_SCORE = 3;

// doc: { name, dir, text, title }
// options: { partners: [이름 또는 {name, aliases}], tagRules: [{ tag, keywords: [] }] }
// 결과: { category, score, reasons: [문장], tags: [] }
function classify(doc, options = {}) {
  const sec = sections(doc);
  const scores = {};
  const hits = {};
  for (const key of Object.keys(KEYWORDS)) {
    const r = scoreList(sec, KEYWORDS[key]);
    scores[key] = r.score;
    hits[key] = r.hits;
  }

  // 고객사·협력사 이름이 파일/폴더 이름에 있으면 그 회사에 보낸 자료일 가능성이 높다.
  const partners = normalizePartners(options.partners);
  const partnerTags = [];
  for (const p of partners) {
    let inPath = false, inText = false;
    for (const a of p.aliases) {
      if (countIn(sec.name, a, 1) || countIn(sec.dir, a, 1)) inPath = true;
      else if (countIn(sec.head, a, 1) || countIn(sec.body, a, 1)) inText = true;
    }
    if (inPath) {
      scores.request += 12;
      hits.request.unshift({ kw: p.name, where: "name", s: 12 });
    }
    if (inPath || inText) partnerTags.push(p.name);
  }

  // 국가과제 세부 종류는 "국가과제다운 정도"를 함께 더한다.
  const G = scores.gov;
  const candidates = {
    gov_demand: scores.gov_demand > 0 ? scores.gov_demand + G * 0.5 : 0,
    gov_plan: scores.gov_plan > 0 ? scores.gov_plan + G * 0.5 : 0,
    gov_report: scores.gov_report > 0 ? scores.gov_report + G * 0.5 : 0,
    gov_etc: G * 0.5,
    ir: scores.ir,
    company: scores.company,
    website: scores.website,
    catalog: scores.catalog,
    request: scores.request,
  };
  // "보고서", "신청서" 같은 흔한 단어만으로는 국가과제로 보지 않는다.
  for (const k of ["gov_plan", "gov_report"]) {
    if (G < 2 && !hits[k].some((h) => h.where === "name" && h.s >= 20)) candidates[k] *= 0.4;
  }

  let category = "other";
  let best = 0;
  for (const [k, v] of Object.entries(candidates)) {
    if (v > best) { best = v; category = k; }
  }
  if (best < MIN_SCORE) category = "other";

  const reasons = [];
  if (category !== "other") {
    const key = category === "gov_etc" ? "gov" : category;
    const list = [...hits[key]];
    if (category.startsWith("gov_") && category !== "gov_etc") list.push(...hits.gov.slice(0, 2));
    const shown = [];
    for (const h of list) {
      if (shown.length >= 4) break;
      if (shown.some((o) => o.where === h.where && o.kw.includes(h.kw))) continue;
      shown.push(h);
    }
    for (const h of shown) reasons.push(`${WHERE[h.where]}에 '${h.kw}'`);
  }

  const tags = new Set(partnerTags);
  for (const t of yearTags(sec)) tags.add(t);
  for (const [tag, aliases] of AGENCIES) {
    if (aliases.some((a) => countIn(sec.name, a, 1) || countIn(sec.dir, a, 1) || countIn(sec.head, a, 1) || countIn(sec.body, a, 2) >= 2)) tags.add(tag);
  }
  for (const [tag, words] of STAGE_TAGS) {
    if (words.some((w) => countIn(sec.name, w, 1))) tags.add(tag);
  }
  // 버전 표기(v2, ver.3, _v1.2)
  if (/(?<![A-Za-z])v(?:er)?\.?\s?\d/i.test(sec.name)) tags.add("수정본");
  if (tags.has("최종보고") && tags.has("최종본") && !/최종본|final/i.test(sec.name)) tags.delete("최종본");
  if (isEnglish(doc.text || "")) tags.add("영문");
  for (const rule of options.tagRules || []) {
    if (!rule || !rule.tag) continue;
    const kws = (rule.keywords && rule.keywords.length ? rule.keywords : [rule.tag]).filter(Boolean);
    if (kws.some((k) => countIn(sec.name, k, 1) || countIn(sec.dir, k, 1) || countIn(sec.head, k, 1) || countIn(sec.body, k, 1))) tags.add(rule.tag);
  }

  return { category, score: Math.round(best * 10) / 10, reasons, tags: [...tags] };
}

// 파일 이름의 연도는 모두, 본문은 가장 많이 나온 연도 하나만.
function yearTags(sec) {
  const now = new Date().getFullYear();
  const ok = (y) => y >= 2000 && y <= now + 5;
  const found = new Set();
  const src = sec.name + " " + sec.dir;
  for (const m of src.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)) if (ok(+m[1])) found.add(m[1]);
  for (const m of src.matchAll(/(?<!\d)'?(\d{2})\s?년/g)) {
    const y = 2000 + Number(m[1]);
    if (ok(y)) found.add(String(y));
  }
  if (!found.size) {
    const counts = {};
    const text = sec.head + "\n" + sec.body;
    for (const m of text.matchAll(/(?<!\d)(20\d{2})\s?(?:년|[.\-/]\s?\d{1,2}[.\-/])/g)) {
      if (ok(+m[1])) counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (top && top[1] >= 2) found.add(top[0]);
  }
  return [...found];
}

function isEnglish(text) {
  if (text.length < 200) return false;
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin > 200 && hangul < latin * 0.05;
}

module.exports = { classify, CATEGORIES, KEYWORDS };
