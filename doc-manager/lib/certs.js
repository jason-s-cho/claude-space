// 회사 증빙의 종류·발급일·유효기간.
//   - 종류: 사업자등록증, 벤처기업확인서 … (같은 종류가 여러 장이면 발급일이 가장 늦은 것이 '최신본')
//   - 발급일·유효기간: 문서 본문(OCR 포함)에서 찾고, 사용자가 직접 고친 값(issuedAt, validUntil)이 있으면 그것을 쓴다.
// 만료가 다가오면 알리고, 지원 건마다 낼 서류를 골라 최신본만 한 폴더에 모아 준다(제출 서류 꾸러미).

// [종류, 찾을 낱말들]. 위에서부터 먼저 맞는 것 (더 구체적인 것을 위에)
const KINDS = [
  ["사업자등록증", ["사업자등록증명", "사업자등록증"]],
  ["법인등기부등본", ["등기사항전부증명서", "등기사항일부증명서", "법인등기부등본", "등기부등본", "법인등기"]],
  ["정관", ["정관"]],
  ["주주명부", ["주주명부"]],
  ["법인인감증명서", ["법인인감증명", "인감증명서"]],
  ["사용인감계", ["사용인감계"]],
  ["벤처기업확인서", ["벤처기업확인서", "벤처기업 확인서", "벤처기업확인", "벤처인증", "벤처확인"]],
  ["연구소기업 등록증", ["연구소기업"]],
  ["기업부설연구소 인정서", ["기업부설연구소", "연구개발전담부서"]],
  ["이노비즈 확인서", ["이노비즈", "INNOBIZ", "기술혁신형 중소기업"]],
  ["메인비즈 확인서", ["메인비즈", "MAINBIZ", "경영혁신형 중소기업"]],
  ["소부장 전문기업 확인서", ["소부장 전문기업", "소재부품장비 전문기업", "소재·부품·장비 전문기업"]],
  ["중소기업확인서", ["중소기업확인서", "중소기업 확인서"]],
  ["여성기업확인서", ["여성기업확인서"]],
  ["직접생산확인증명서", ["직접생산확인"]],
  ["ISO 9001 인증서", ["ISO 9001", "ISO9001"]],
  ["ISO 14001 인증서", ["ISO 14001", "ISO14001"]],
  ["ISO 45001 인증서", ["ISO 45001", "ISO45001"]],
  ["녹색인증서", ["녹색인증"]],
  ["신기술인증서", ["신기술인증", "NET 인증"]],
  ["수출실적증명서", ["수출실적증명"]],
  ["재무제표", ["표준재무제표", "재무제표증명", "재무제표"]],
  ["국세완납증명서", ["국세완납", "납세증명서"]],
  ["지방세완납증명서", ["지방세완납", "지방세 완납"]],
  ["부가가치세과세표준증명", ["부가가치세과세표준증명", "과세표준증명"]],
  ["4대보험 가입자명부", ["사업장가입자명부", "가입자명부", "4대보험 가입자"]],
  ["기업신용평가", ["기업신용평가", "신용평가등급", "신용평가"]],
];

const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

// 종류: 파일 이름을 먼저 보고, 없으면 본문 앞부분
function kindOf(name, text) {
  const n = norm(name);
  for (const [kind, words] of KINDS) if (words.some((w) => n.includes(norm(w)))) return kind;
  const head = norm(String(text || "").slice(0, 600));
  for (const [kind, words] of KINDS) if (words.some((w) => head.includes(norm(w)))) return kind;
  return "";
}

const DATE = String.raw`(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*[일.]?`;
const ymd = (m, i = 1) => `${m[i]}-${String(m[i + 1]).padStart(2, "0")}-${String(m[i + 2]).padStart(2, "0")}`;
const valid = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
};

// 본문에서 발급일·유효기간 끝을 찾는다. 결과: { issued, validUntil } (못 찾으면 "")
function datesOf(text) {
  const t = String(text || "").replace(/\r/g, "");
  let issued = "", validUntil = "";
  // 유효기간: 2024.01.01 ~ 2027.12.31 / 유효기간 : ~2027.12.31 / 2027년 12월 31일까지
  let m = new RegExp(String.raw`유효\s*기간[^\n\d~]{0,12}(?:${DATE})?\s*[~∼\-–부터]*\s*${DATE}`).exec(t);
  if (m) validUntil = ymd(m, m[4] ? 4 : 1);
  if (!validUntil) {
    m = new RegExp(String.raw`${DATE}\s*까지`).exec(t);
    if (m) validUntil = ymd(m);
  }
  m = new RegExp(String.raw`(?:발\s*급\s*일\s*자?|발\s*행\s*일\s*자?|발급\s*일시|교부\s*일)\s*[:：]?\s*${DATE}`).exec(t);
  if (m) issued = ymd(m);
  if (!issued) {
    // 증명서 끝의 날짜 줄 ("2025년 3월 2일" 다음 줄에 기관장) — 본문 마지막 쪽의 날짜
    const all = [...t.slice(-800).matchAll(new RegExp(DATE, "g"))].map((x) => ymd(x)).filter(valid);
    if (all.length) issued = all[all.length - 1];
  }
  return { issued: valid(issued) ? issued : "", validUntil: valid(validUntil) ? validUntil : "" };
}

function daysLeft(date, now = new Date()) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}

/**
 * 회사 증빙 문서들의 종류·날짜·최신본.
 * docs: [{ rel, name, text, category, mtimeMs, issuedAt?, validUntil? }]
 * 결과: Map(rel → { kind, issued, validUntil, issuedAuto, validAuto, latest, latestRel })
 */
function analyze(docs) {
  const info = new Map();
  const byKind = new Map();
  for (const d of docs) {
    if (!/^cert_/.test(d.category || "") || d.category === "cert_hr") continue; // 인사 서류는 사람마다라 종류·유효기간으로 보지 않는다
    const kind = kindOf(d.name, d.text);
    const auto = datesOf(d.text);
    const issued = d.issuedAt || auto.issued;
    const validUntil = d.validUntil || auto.validUntil;
    const x = { kind, issued, validUntil, issuedAuto: !d.issuedAt && !!auto.issued, validAuto: !d.validUntil && !!auto.validUntil, sortKey: issued || new Date(d.mtimeMs || 0).toISOString().slice(0, 10), latest: false, latestRel: d.rel };
    info.set(d.rel, x);
    if (kind) {
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(d.rel);
    }
  }
  for (const rels of byKind.values()) {
    const best = rels.reduce((a, b) => (info.get(b).sortKey > info.get(a).sortKey ? b : a));
    for (const r of rels) {
      info.get(r).latest = r === best;
      info.get(r).latestRel = best;
    }
  }
  for (const [rel, x] of info) if (!x.kind) x.latest = true; // 종류를 모르면 각자 최신본
  return info;
}

// 종류별 최신본 목록 (꾸러미·Claude 용): [{ kind, rel, issued, validUntil, daysLeft }]
function latestByKind(info) {
  const out = [];
  for (const [rel, x] of info) if (x.kind && x.latest) out.push({ kind: x.kind, rel, issued: x.issued, validUntil: x.validUntil, daysLeft: x.validUntil ? daysLeft(x.validUntil) : null });
  const order = KINDS.map((k) => k[0]);
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

module.exports = { KINDS, kindOf, datesOf, daysLeft, analyze, latestByKind };
