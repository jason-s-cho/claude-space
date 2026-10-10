// 파일 이름 · 폴더 이름 · 본문 글자에서 키워드를 찾아 문서 종류를 정하고 태그를 붙인다.
// 파일 이름에 나온 단어가 가장 강한 근거이고, 그다음이 폴더 이름, 본문 앞부분, 본문 순서다.

// 분류가 바뀌면 이 숫자를 올린다. 앱을 켤 때 색인의 숫자와 다르면 모든 문서를 다시 분류한다.
const CLASSIFIER_VERSION = 4;

// folder: 문서 폴더 안에서 이 분류가 들어갈 하위 폴더 이름 (group 폴더 아래)
const CATEGORIES = [
  { id: "gov_notice", group: "국가과제·지원사업", label: "공고·수요조사", folder: "1 공고·수요조사", color: "#2b59c3" },
  { id: "gov_plan", group: "국가과제·지원사업", label: "사업계획서", folder: "2 사업계획서", color: "#3563d0" },
  { id: "gov_agreement", group: "국가과제·지원사업", label: "선정·협약", folder: "3 선정·협약", color: "#416ed9" },
  { id: "gov_meeting", group: "국가과제·지원사업", label: "수행·회의", folder: "4 수행·회의", color: "#5079df" },
  { id: "gov_report", group: "국가과제·지원사업", label: "보고서", folder: "5 보고서", color: "#6286e4" },
  { id: "gov_settle", group: "국가과제·지원사업", label: "정산·증빙", folder: "6 정산·증빙", color: "#7593e8" },
  { id: "gov_etc", group: "국가과제·지원사업", label: "기타 과제자료", folder: "기타", color: "#8ba3ea" },
  { id: "cert_basic", group: "회사 증빙", label: "기본 서류", folder: "기본 서류", color: "#0f766e" },
  { id: "cert_auth", group: "회사 증빙", label: "인증·확인서", folder: "인증·확인서", color: "#14857b" },
  { id: "cert_perf", group: "회사 증빙", label: "실적·재무", folder: "실적·재무", color: "#2a9a8f" },
  { id: "ip_patent_app", group: "지식재산", label: "특허 출원", folder: "특허 출원", color: "#7c3aed" },
  { id: "ip_patent_reg", group: "지식재산", label: "특허 등록", folder: "특허 등록", color: "#8b5cf6" },
  { id: "ip_mark", group: "지식재산", label: "상표·디자인", folder: "상표·디자인", color: "#a78bfa" },
  { id: "ir", group: "회사소개", label: "IR·투자", folder: "IR·투자", color: "#a5428a" },
  { id: "company", group: "회사소개", label: "회사소개서", folder: "회사소개서", color: "#c066a8" },
  { id: "website", group: "홍보", label: "홈페이지", folder: "홈페이지", color: "#12807a" },
  { id: "catalog", group: "홍보", label: "카탈로그·브로셔", folder: "카탈로그·브로셔", color: "#2f8a5f" },
  { id: "analysis", group: "", label: "기술·시장 분석", folder: "기술·시장 분석", color: "#7a5af0" },
  { id: "request", group: "", label: "고객사·협력사", folder: "고객사·협력사", color: "#c47a12" },
  { id: "purchase", group: "", label: "구매·견적", folder: "구매·견적", color: "#b4532a" },
  { id: "other", group: "", label: "미분류", folder: "미분류", color: "#6b7280" },
];

// 예전 분류 이름 → 새 분류 이름 (직접 고친 분류, 분류 키워드 설정을 옮길 때)
const RENAMED = { gov_demand: "gov_notice" };

const CERT_IP = ["cert_basic", "cert_auth", "cert_perf", "ip_patent_app", "ip_patent_reg", "ip_mark"];
const GOV_SUBTYPES = ["gov_notice", "gov_plan", "gov_agreement", "gov_meeting", "gov_report", "gov_settle"];

// [키워드, 가중치]. 영문 키워드는 단어 단위로 찾고, 대문자 약어(IR, RAM, NDA)는 대소문자까지 맞아야 한다.
const KEYWORDS = {
  gov: [
    ["국가연구개발", 3], ["연구개발과제", 3], ["정부출연금", 3], ["정부지원연구개발비", 3], ["주관연구개발기관", 3],
    ["주관기관", 2], ["참여기관", 2], ["공동연구개발기관", 2], ["위탁연구", 2], ["과제번호", 2], ["연구책임자", 2],
    ["전담기관", 2], ["전문기관", 1], ["수행기관", 2], ["국가과제", 3], ["정부과제", 3], ["R&D", 1], ["연구개발비", 2],
    ["기술개발사업", 2], ["지원사업", 3], ["사업단", 1], ["IRIS", 2], ["범부처통합연구지원시스템", 3], ["총괄과제", 2],
    ["세부과제", 2], ["1세부", 2], ["2세부", 2], ["3세부", 2], ["협약", 2], ["사업비", 2], ["정부지원금", 3],
    ["민간부담금", 3], ["창업기업", 2], ["바우처", 2], ["고도화", 1], ["실증", 1],
  ],
  gov_notice: [
    ["수요조사서", 6], ["수요조사", 5], ["기술수요", 4], ["기획수요", 4], ["수요제안", 4], ["RFP", 3], ["제안요청서", 4],
    ["공고", 4], ["공고문", 5], ["사업공고", 5], ["모집공고", 5], ["신청안내", 4], ["사업설명회", 4], ["지침", 4],
    ["매뉴얼", 3], ["운영요령", 4], ["운영지침", 5], ["관리지침", 4], ["가이드라인", 3], ["작성요령", 3], ["참조자료", 2],
  ],
  gov_plan: [
    ["과제계획서", 6], ["연구개발계획서", 6], ["사업계획서", 5], ["연구계획서", 5], ["수행계획서", 5],
    ["과제신청서", 5], ["신청서", 2], ["추진계획", 2], ["연구개발 목표", 3], ["연구개발 내용", 2], ["추진전략", 2],
    ["추진체계", 2], ["기대효과", 1], ["활용방안", 1], ["사업화 계획", 2], ["발표평가", 3], ["대면평가", 3],
  ],
  gov_agreement: [
    ["협약서", 6], ["협약체결", 6], ["협약 체결", 6], ["선정결과", 6], ["과제선정", 5], ["선정 통보", 5], ["수정사업계획서", 7],
    ["수정계획서", 6], ["계좌 개설", 5], ["통장개설", 5], ["사업비 계좌", 6], ["사업비 카드", 6], ["카드 신청", 4],
    ["카드 개설", 5], ["참여연구원", 3], ["이행각서", 5], ["서약서", 2], ["기술료", 3],
  ],
  gov_meeting: [
    ["워크샵", 5], ["워크숍", 5], ["사전미팅", 5], ["킥오프", 5], ["kick-off", 5], ["kickoff", 5], ["착수보고", 5],
    ["착수회의", 5], ["회의록", 4], ["회의자료", 4], ["발표자료", 3], ["진도점검", 5], ["현장점검", 5], ["점검회의", 5],
    ["컨설팅", 2], ["멘토링", 2], ["미팅", 2], ["세미나", 2], ["간담회", 3],
  ],
  gov_report: [
    ["결과보고서", 6], ["최종보고서", 6], ["중간보고서", 6], ["연차보고서", 6], ["단계보고서", 6], ["완료보고", 5],
    ["연차실적", 5], ["성과보고", 4], ["실적보고", 4], ["연구개발 결과", 3], ["자체평가", 3], ["성과활용", 2],
    ["목표 달성도", 3], ["보고서", 1],
  ],
  gov_settle: [
    ["정산", 5], ["정산보고", 6], ["사업비 정산", 7], ["집행내역", 5], ["집행실적", 5], ["증빙", 4], ["영수증", 3],
    ["세금계산서", 2], ["지출결의", 4], ["집행잔액", 5], ["반납", 3], ["RCMS", 5], ["이지바로", 5], ["e나라도움", 5],
    ["회계감사", 5], ["감사보고서", 3],
  ],
  // 회사 증빙: 국가과제 신청·협약 때마다 내는 회사 서류
  cert_basic: [
    ["사업자등록증", 8], ["사업자등록증명", 8], ["사업자등록번호", 2], ["법인등기부등본", 8], ["등기부등본", 7], ["등기사항전부증명서", 8],
    ["등기사항일부증명서", 8], ["법인등기", 6], ["정관", 5], ["주주명부", 8], ["인감증명서", 8], ["법인인감", 6], ["사용인감계", 7],
    ["인감신고", 5], ["법인 설립", 3],
  ],
  cert_auth: [
    ["벤처기업확인서", 8], ["벤처기업 확인", 7], ["벤처인증", 7], ["벤처확인", 7], ["연구소기업", 7], ["기업부설연구소", 7],
    ["연구개발전담부서", 7], ["인정서", 5], ["이노비즈", 7], ["INNOBIZ", 7], ["메인비즈", 7], ["MAINBIZ", 7],
    ["소부장 전문기업", 7], ["소재부품장비 전문기업", 7], ["소재·부품·장비 전문기업", 7], ["중소기업확인서", 7], ["중소기업 확인서", 7],
    ["여성기업확인서", 7], ["장애인기업확인서", 7], ["직접생산확인", 7], ["우수조달", 5], ["혁신제품", 4], ["녹색인증", 6],
    ["신기술인증", 6], ["NET 인증", 6], ["ISO 9001", 7], ["ISO 14001", 7], ["ISO 45001", 7], ["인증서", 4], ["확인서", 2],
    ["인증번호", 3], ["유효기간", 3], ["강소기업", 5], ["뿌리기업", 5], ["기술혁신형", 4], ["경영혁신형", 4],
  ],
  cert_perf: [
    ["수출실적증명서", 8], ["수출실적증명", 8], ["수출실적", 5], ["표준재무제표", 8], ["재무제표", 6], ["재무제표증명", 8],
    ["손익계산서", 5], ["재무상태표", 5], ["대차대조표", 5], ["납세증명서", 8], ["국세완납증명", 8], ["지방세완납증명", 8],
    ["완납증명서", 8], ["부가가치세과세표준증명", 8], ["과세표준증명", 7], ["4대보험 가입자명부", 8], ["가입자명부", 7],
    ["사업장가입자명부", 8], ["고용보험 피보험자", 6], ["매출액 증명", 6], ["기업신용평가", 7], ["신용평가등급", 6], ["신용평가", 4],
    ["원천징수이행상황", 6], ["사업자 소득금액", 4],
  ],
  // 지식재산: 특허는 출원·등록을 나누고, 상표·디자인은 한곳에
  ip_patent_app: [
    ["특허출원서", 8], ["특허출원", 7], ["출원번호통지서", 8], ["출원서", 5], ["특허명세서", 8], ["명세서", 4], ["청구범위", 5],
    ["특허청구범위", 6], ["의견제출통지서", 8], ["의견서", 4], ["보정서", 5], ["거절이유", 6], ["거절결정", 6], ["심사청구", 6],
    ["우선권주장", 5], ["PCT", 5], ["국제출원", 6], ["공개특허", 6], ["공개공보", 6], ["발명의 명칭", 5], ["발명자", 3],
    ["직무발명", 5], ["발명신고서", 7], ["특허", 2],
  ],
  ip_patent_reg: [
    ["특허증", 9], ["등록특허", 7], ["특허등록", 7], ["등록공보", 7], ["등록결정서", 8], ["특허결정", 7], ["설정등록", 7],
    ["등록번호", 4], ["특허권", 5], ["연차료", 6], ["특허료 납부", 6], ["실용신안등록", 7], ["실용신안", 5],
  ],
  ip_mark: [
    ["상표등록증", 9], ["상표등록", 8], ["상표출원", 8], ["상표", 6], ["서비스표", 7], ["지정상품", 7], ["상품류", 6],
    ["trademark", 6], ["디자인등록증", 9], ["디자인등록", 8], ["디자인출원", 8], ["디자인권", 7], ["물품류", 5],
  ],
  ir: [
    ["IR", 5], ["IR deck", 6], ["IR자료", 6], ["investor", 4], ["pitch", 3], ["pitch deck", 6], ["투자유치", 5],
    ["투자제안서", 6], ["투자 제안", 4], ["투자검토", 6], ["투자 검토", 6], ["밸류에이션", 4], ["valuation", 3],
    ["시리즈 A", 4], ["Series A", 4], ["시드 투자", 3], ["TAM", 2], ["SAM", 1], ["SOM", 1], ["exit", 1], ["투자금", 3],
    ["재무 계획", 2], ["매출 전망", 2], ["Use of Funds", 4], ["자금 사용", 3], ["주주", 2], ["지분", 2], ["cap table", 4],
  ],
  company: [
    ["회사소개서", 7], ["회사소개", 6], ["기업소개", 6], ["company profile", 6], ["company introduction", 6],
    ["회사개요", 4], ["기업개요", 4], ["연혁", 3], ["CEO 인사말", 4], ["대표이사 인사말", 4],
    ["조직도", 2], ["비전", 1], ["핵심가치", 2], ["주요 고객사", 2], ["주요 실적", 2], ["about us", 4],
  ],
  website: [
    ["홈페이지", 6], ["웹사이트", 6], ["website", 5], ["web site", 5], ["사이트맵", 5], ["sitemap", 4],
    ["메뉴구조", 4], ["와이어프레임", 4], ["wireframe", 4], ["스토리보드", 3], ["GNB", 3], ["목업", 3], ["mockup", 3],
    ["메인페이지", 3], ["랜딩 페이지", 3], ["landing page", 3], ["SEO", 2], ["UI", 1], ["URL", 1],
  ],
  catalog: [
    ["카탈로그", 7], ["catalog", 6], ["catalogue", 6], ["브로셔", 6], ["브로슈어", 6], ["brochure", 6],
    ["리플렛", 5], ["리플릿", 5], ["leaflet", 5], ["datasheet", 5], ["데이터시트", 5], ["제품소개", 4], ["제품안내", 4],
    ["제품사양", 3], ["specification", 3], ["사양", 1], ["모델명", 2], ["라인업", 2], ["lineup", 2],
  ],
  analysis: [
    ["analysis", 5], ["분석", 3], ["기술분석", 6], ["시장분석", 6], ["시장조사", 6], ["기술동향", 6], ["동향", 4],
    ["산업동향", 6], ["경쟁사", 5], ["competitor", 5], ["competitive", 3], ["benchmark", 4], ["벤치마크", 4],
    ["벤치마킹", 4], ["특허분석", 6], ["특허동향", 6], ["리서치", 4], ["research", 3], ["market", 3], ["landscape", 4],
    ["trend", 3], ["트렌드", 3], ["전망", 2], ["outlook", 3], ["규제", 2], ["조사보고서", 5], ["기술조사", 5], ["review", 2],
  ],
  request: [
    ["요청자료", 6], ["요청하신", 4], ["제출자료", 5], ["회신", 3], ["업체등록", 5], ["협력사 등록", 5], ["협력업체", 3],
    ["협력사", 3], ["고객사", 2], ["거래처", 3], ["시험성적서", 4], ["품질보증", 2], ["보안서약서", 4], ["비밀유지", 3],
    ["NDA", 4], ["질의응답", 2], ["답변서", 4], ["체크리스트", 2], ["checklist", 2], ["설문", 2], ["실사", 2], ["제안서", 2],
  ],
  purchase: [
    ["견적서", 6], ["견적", 5], ["견적관리", 6], ["quotation", 5], ["quote", 3], ["발주", 5], ["발주서", 6], ["구매", 4],
    ["구매요청", 6], ["구매품의", 6], ["품의서", 5], ["장비", 2], ["purchase order", 6], ["PO", 3], ["입찰", 3],
    ["거래명세서", 6], ["거래명세표", 6], ["세금계산서", 6], ["계산서", 4], ["가격증빙", 5], ["납품확인서", 5], ["납품", 2], ["단가", 2], ["invoice", 3], ["계약서", 2],
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

// 화면의 '분류 키워드' 설정에서 쓰는 이름. gov 는 국가과제 세부 종류 모두에 더해지는 공통 단서다.
const KEYWORD_GROUPS = [
  { key: "gov", label: "국가과제·지원사업 공통 단서" },
  ...CATEGORIES.filter((c) => KEYWORDS[c.id]).map((c) => ({ key: c.id, label: c.group ? `${c.group} · ${c.label}` : c.label })),
];

const normKw = (kw) => kw.replace(/\s+/g, "").toLowerCase();

// 기본 키워드에 내가 더하거나 뺀 키워드를 반영한다.
// overrides: { [그룹]: { add: [[키워드, 가중치]], remove: [키워드] } }
let mergedCache = { key: null, value: KEYWORDS };
function mergedKeywords(overrides) {
  const key = JSON.stringify(overrides || {});
  if (mergedCache.key === key) return mergedCache.value;
  const out = {};
  for (const g of Object.keys(KEYWORDS)) {
    const o = (overrides && overrides[g]) || {};
    const removed = new Set((o.remove || []).map(normKw));
    const map = new Map();
    for (const [kw, w] of KEYWORDS[g]) if (!removed.has(normKw(kw))) map.set(normKw(kw), [kw, w]);
    for (const [kw, w] of o.add || []) if (kw && kw.trim() && w > 0) map.set(normKw(kw), [kw.trim(), Number(w)]);
    out[g] = [...map.values()];
  }
  mergedCache = { key, value: out };
  return out;
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

// 기술 분야 기본 태그 (분류 설정에서 끌 수 있음)
const TECH_TAGS = [
  ["그래핀", ["그래핀", "graphene", "rGO", "산화그래핀"]],
  ["스텔스·RAM", ["스텔스", "stealth", "전파흡수", "전파 흡수", "레이더 흡수", "radar absorbing", "RAM", "RAS"]],
  ["전자파차폐", ["전자파 차폐", "전자파차폐", "EMI", "shielding"]],
  ["센서", ["센서", "sensor"]],
  ["투명발열체·TCF", ["투명발열", "투명 발열", "투명전극", "TCF", "transparent conductive", "transparent heater", "발열필름", "면상발열"]],
  ["PFAS", ["PFAS", "과불화"]],
  ["라이다", ["라이다", "LiDAR"]],
  ["광전자·포토닉스", ["포토닉스", "photonics", "광전자", "photodetector", "광검출", "optoelectronic"]],
  ["반도체", ["반도체", "semiconductor"]],
  ["방산", ["방산", "국방", "방위산업", "defense", "defence"]],
  ["배터리", ["배터리", "이차전지", "battery"]],
];

const STAGE_TAGS = [
  ["중간보고", ["중간보고"]],
  ["최종보고", ["최종보고", "결과보고"]],
  ["연차보고", ["연차보고", "연차실적"]],
  ["최종본", ["최종본", "최종", "final"]],
  ["초안", ["초안", "draft", "가안"]],
  ["수정본", ["수정본", "수정", "rev", "revised"]],
];

const PRIVATE_DOC = ["등기부등본", "등기사항전부증명서", "등기사항일부증명서", "법인등기부", "주주명부"];
// 가리지 않은 주민등록번호 (YYMMDD-[1-4]NNNNNN). 앞뒤가 다른 숫자에 붙어 있으면 아니다.
const RRN = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s?-\s?[1-4]\d{6}(?!\d)/;

const LATIN_ONLY = /^[\x20-\x7e]+$/;
const regexCache = new Map();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 키워드 하나를 찾는 정규식. 영문은 앞뒤에 다른 영문자가 붙어 있으면 무시한다. (IR ≠ IRB, first)
// 4글자 이하 대문자 약어(IR, RAM, NDA)는 대소문자까지 맞아야 한다. (graphene_ir_sensitivity 의 ir 은 적외선)
function keywordRe(kw) {
  let re = regexCache.get(kw);
  if (!re) {
    const body = escapeRe(kw).replace(/ /g, "\\s*");
    const flags = /^[A-Z&]{2,4}$/.test(kw) ? "g" : "gi";
    re = LATIN_ONLY.test(kw) ? new RegExp(`(?<![A-Za-z])${body}(?![A-Za-z])`, flags) : new RegExp(body, flags);
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

// 문서가 어느 과제(분류 설정에 등록한 과제)의 것인지. 경로에 있으면 확실, 본문 앞부분에만 있으면 그다음.
function findProject(sec, projects) {
  let best = null;
  for (const p of normalizePartners(projects)) {
    let s = 0;
    for (const a of p.aliases) {
      if (countIn(sec.name, a, 1) || countIn(sec.dir, a, 1)) s = Math.max(s, 2);
      else if (countIn(sec.head, a, 1)) s = Math.max(s, 1);
    }
    if (s && (!best || s > best.s)) best = { name: p.name, s, inPath: s === 2 };
  }
  return best;
}

// doc: { name, dir, text, title }
// options: { partners, projects: [{name, aliases}], tagRules: [{ tag, keywords }], keywordOverrides, techTags(기본 true) }
// 결과: { category, score, reasons: [문장], tags: [], project: 과제 이름 또는 "" }
function classify(doc, options = {}) {
  const sec = sections(doc);
  const scores = {};
  const hits = {};
  const lists = mergedKeywords(options.keywordOverrides);
  for (const key of Object.keys(lists)) {
    const r = scoreList(sec, lists[key]);
    scores[key] = r.score;
    hits[key] = r.hits;
  }

  // 고객사·협력사 이름이 파일/폴더 이름에 있으면 그 회사 관련 자료일 가능성이 높다.
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

  // 등록한 과제 이름이 보이면 국가과제 문서다.
  const project = findProject(sec, options.projects);
  if (project) {
    const add = project.inPath ? 12 : 5;
    scores.gov += add;
    hits.gov.unshift({ kw: project.name, where: project.inPath ? "name" : "head", s: add });
  }

  // 국가과제 세부 종류는 "국가과제다운 정도(G)"를 함께 더한다.
  const G = scores.gov;
  const candidates = { gov_etc: G * 0.5 };
  for (const k of GOV_SUBTYPES) {
    let v = scores[k] > 0 ? scores[k] + G * 0.5 : 0;
    // "보고서", "회의록", "정산" 같은 흔한 단어만으로는 국가과제로 보지 않는다. (파일 이름에 강한 단어가 있으면 예외)
    // 국가과제 단서가 전혀 없으면 더 약하게 본다. (그냥 '주간 회의록'이 과제 회의로 가지 않게)
    if (G < 2 && !hits[k].some((h) => h.where === "name" && h.s >= 20)) v *= G === 0 ? 0.15 : 0.4;
    candidates[k] = v;
  }
  for (const k of ["ir", "company", "website", "catalog", "analysis", "request", "purchase", ...CERT_IP]) candidates[k] = scores[k];
  // 특허 '분석·동향' 보고서는 지식재산이 아니라 기술·시장 분석이다
  if (hits.analysis.some((h) => /특허(분석|동향)/.test(h.kw) && h.where === "name")) for (const k of CERT_IP) candidates[k] *= 0.3;

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
    if (GOV_SUBTYPES.includes(category)) list.push(...hits.gov.slice(0, 2));
    const shown = [];
    for (const h of list) {
      if (shown.length >= 4) break;
      if (shown.some((o) => o.where === h.where && o.kw.includes(h.kw))) continue;
      shown.push(h);
    }
    for (const h of shown) reasons.push(`${WHERE[h.where]}에 '${h.kw}'`);
  }

  const tags = new Set(partnerTags);
  if (project) tags.add(project.name);
  for (const t of yearTags(sec)) tags.add(t);
  const seen = (a, bodyMin = 2) => countIn(sec.name, a, 1) || countIn(sec.dir, a, 1) || countIn(sec.head, a, 1) || countIn(sec.body, a, bodyMin) >= bodyMin;
  for (const [tag, aliases] of AGENCIES) if (aliases.some((a) => seen(a))) tags.add(tag);
  if (options.techTags !== false) {
    for (const [tag, aliases] of TECH_TAGS) if (aliases.some((a) => seen(a))) tags.add(tag);
  }
  for (const [tag, words] of STAGE_TAGS) {
    if (words.some((w) => countIn(sec.name, w, 1))) tags.add(tag);
  }
  // 버전 표기(v2, ver.3, _v1.2)
  if (/(?<![A-Za-z])v(?:er)?\.?\s?\d/i.test(sec.name)) tags.add("수정본");
  // "수정사업계획서"의 '수정'은 버전 표시가 아니다.
  if (tags.has("수정본") && /수정\s*(사업)?계획서/.test(sec.name) && !/수정본|rev|(?<![A-Za-z])v(?:er)?\.?\s?\d/i.test(sec.name)) tags.delete("수정본");
  if (tags.has("최종보고") && tags.has("최종본") && !/최종본|final/i.test(sec.name)) tags.delete("최종본");
  // 폴더 이름의 [완료] 표시
  if (/\[\s*완료\s*\]/.test(sec.dir + " " + sec.name)) tags.add("완료");
  if (isEnglish(doc.text || "")) tags.add("영문");
  // 개인정보가 들어 있는 서류(등기부등본·주주명부, 주민등록번호가 그대로 보이는 문서)는 기본으로 Claude 에 보내지 않는다.
  // 화면에서 'AI제외' 태그를 지우면(숨기면) 보낼 수 있다.
  if (PRIVATE_DOC.some((w) => countIn(sec.name, w, 1) || countIn(sec.head, w, 1)) || RRN.test(doc.text || "")) tags.add("AI제외");
  for (const rule of options.tagRules || []) {
    if (!rule || !rule.tag) continue;
    const kws = (rule.keywords && rule.keywords.length ? rule.keywords : [rule.tag]).filter(Boolean);
    if (kws.some((k) => countIn(sec.name, k, 1) || countIn(sec.dir, k, 1) || countIn(sec.head, k, 1) || countIn(sec.body, k, 1))) tags.add(rule.tag);
  }

  return { category, score: Math.round(best * 10) / 10, reasons, tags: [...tags], project: project ? project.name : "" };
}

// 파일·폴더 이름의 연도는 모두, 본문은 가장 많이 나온 연도 하나만.
// 2025, 25년, 2025-05-08, 20250508, 250926(YYMMDD) 를 알아본다.
function yearTags(sec) {
  const now = new Date().getFullYear();
  const ok = (y) => y >= 2000 && y <= now + 5;
  const validMd = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const found = new Set();
  const src = sec.name + " " + sec.dir;
  for (const m of src.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)) if (ok(+m[1])) found.add(m[1]);
  for (const m of src.matchAll(/(?<!\d)'?(\d{2})\s?년/g)) {
    const y = 2000 + Number(m[1]);
    if (ok(y)) found.add(String(y));
  }
  // YYYYMMDD
  for (const m of src.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    if (ok(+m[1]) && validMd(+m[2], +m[3])) found.add(m[1]);
  }
  // YYMMDD (2015년 이후만: 그보다 옛날 6자리 숫자는 날짜가 아닐 가능성이 높다)
  for (const m of src.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    const y = 2000 + Number(m[1]);
    if (y >= 2015 && y <= now + 1 && validMd(+m[2], +m[3])) found.add(String(y));
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

// 예전 분류 키워드 설정({gov_demand: …})을 새 이름으로 옮긴다.
function migrateOverrides(overrides) {
  const out = {};
  for (const [k, v] of Object.entries(overrides || {})) out[RENAMED[k] || k] = v;
  return out;
}

function isEnglish(text) {
  if (text.length < 200) return false;
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin > 200 && hangul < latin * 0.05;
}

module.exports = { classify, CATEGORIES, KEYWORDS, KEYWORD_GROUPS, TECH_TAGS, RENAMED, CLASSIFIER_VERSION, GOV_SUBTYPES, mergedKeywords, migrateOverrides };
