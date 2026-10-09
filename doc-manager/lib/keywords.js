// 본문에서 핵심 키워드를 뽑는다.
// 형태소 분석기 없이 조사·어미를 떼고, 자주 쓰는 일반 단어를 빼고 센 다음,
// 전체 문서 중 몇 개 문서에 나오는지(문서 빈도)로 나눠서 "이 문서에만 많이 나오는 단어"를 고른다.

// 길이가 긴 것부터 떼어야 "에서"가 "에"보다 먼저 떨어진다.
const SUFFIXES = [
  "되었으며", "하였으며", "되었는데", "하였는데", "되었으나", "하였으나",
  "에서는", "으로는", "에게서", "이라는", "이라고", "하였다", "하였음", "되었다", "되었음", "합니다", "입니다", "됩니다", "습니다",
  "에서", "으로", "에게", "까지", "부터", "보다", "처럼", "이며", "이고", "이다", "이나", "라는", "에는", "와의", "과의", "로서", "로써",
  "하다", "되다", "으며", "었다", "였다", "하는", "하고", "하여", "하며", "해서", "했다", "한다", "하기", "되는", "되고", "되어", "된다", "되며", "적인", "적으로", "들의", "들을", "들이", "들은",
  "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만", "및", "등", "들", "한", "할", "함", "된", "됨", "적",
];

const STOP = new Set(`
및 등 위한 위해 대한 대해 통해 통한 관련 경우 이상 이하 이내 내용 사항 기타 해당 또는 그리고 그러나 따라서 따른 따라 있음 없음 있는 없는 있다 없다
본 해당 각 모든 기존 현재 향후 주요 기본 전체 일부 다양 다양한 필요 가능 가능한 진행 수행 사용 활용 제공 확보 구축 개발 추진 계획 목표 결과 내용 방법 방안
구분 항목 비고 합계 소계 단위 기준 기간 년도 연도 페이지 page 년 월 일 개 명 건 원 천원 백만원 억원 회 차 호 번 부 점 약 총 및/또는
우리 당사 귀사 저희 대표 담당 담당자 연락처 전화 이메일 주소 작성 작성자 제출 일자 날짜 서명 확인 승인
the and for with that this from are was were has have had not but all can will our your their its into than then also any each
of to in on at by as is be or an a it we you they he she his her them which who what when where how
`.trim().split(/\s+/));

const MIN_LEN = 2;

// "모듈에서의" → "모듈에서" → "모듈" 처럼 두 번까지 뗀다.
function stripSuffix(w) {
  for (let round = 0; round < 2; round++) {
    if (!/[가-힣]$/.test(w)) return w;
    const s = SUFFIXES.find((x) => w.length - x.length >= MIN_LEN && w.endsWith(x));
    if (!s) return w;
    w = w.slice(0, -s.length);
  }
  return w;
}

function isNoise(w) {
  if (w.length < MIN_LEN) return true;
  if (STOP.has(w)) return true;
  if (/^\d/.test(w) && !/^(3d|5g|6g)$/.test(w)) return true; // 숫자, 60db 같은 수치
  if (/^[a-z]$/.test(w)) return true;
  if (/^[a-z]{2}$/.test(w) && !/^(ai|ui|ux|ir|ip|rf|5g|6g)$/.test(w)) return true;
  if (w.length > 30) return true;
  return false;
}

// 한 문서 안의 단어 수를 센다. 결과: [[단어, 횟수], ...] 많이 나온 순, 최대 limit 개
function countTerms(text, limit = 60) {
  const counts = new Map();
  const tokens = [];
  // 한글/영문/숫자 덩어리. "5G", "R&D", "COVID-19" 같은 것도 한 단어로.
  const re = /[A-Za-z0-9][A-Za-z0-9&+\-.]*[A-Za-z0-9+]|[A-Za-z0-9]|[가-힣]+/g;
  let m;
  while ((m = re.exec(text))) {
    let w = m[0];
    if (/[A-Za-z]/.test(w) && !/[a-z]/.test(w.slice(1)) && w.length <= 6) {
      // 약어(IR, KEIT, TAM)는 대문자 그대로 두고
    } else w = w.toLowerCase();
    w = stripSuffix(w);
    if (isNoise(w.toLowerCase())) {
      tokens.push(null);
      continue;
    }
    tokens.push(w);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  // 두 단어 묶음(전자파 차폐, 그래핀 센서)이 여러 번 나오면 함께 센다.
  const pairs = new Map();
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i], b = tokens[i + 1];
    if (!a || !b || a === b) continue;
    const k = a + " " + b;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  for (const [k, n] of pairs) if (n >= 3) counts.set(k, n);
  return [...counts.entries()]
    // 한 번만 나온 단어는 약어(KEIT, TIPA)만 남긴다. (글자가 아주 적은 문서는 예외)
    .filter(([w, n]) => n >= 2 || tokens.length < 150 || /^[A-Z][A-Z0-9&]{2,}$/.test(w))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit);
}

// 전체 문서에서 단어마다 몇 개 문서에 나오는지
function docFrequency(termLists) {
  const df = new Map();
  for (const list of termLists) for (const [w] of list || []) df.set(w, (df.get(w) || 0) + 1);
  return df;
}

// 이 문서의 핵심 키워드 (최대 limit 개)
function topKeywords(terms, df, totalDocs, limit = 12) {
  if (!terms || !terms.length) return [];
  const count = new Map(terms);
  const N = Math.max(totalDocs, 1);
  const scored = terms.map(([w, n]) => {
    const d = df.get(w) || 1;
    // 문서가 적을 때는 문서 빈도 효과를 약하게
    const idf = Math.log(1 + N / d);
    const bonus = w.includes(" ") ? 1.3 : 1;
    // 거의 모든 문서에 나오는 단어(회사 이름 등)는 뺀다
    const common = N >= 8 && d / N > 0.6;
    return { w, s: common ? 0 : Math.log(1 + n) * idf * bonus };
  });
  scored.sort((a, b) => b.s - a.s);
  const out = [];
  for (const { w, s } of scored) {
    if (s <= 0 || out.length >= limit) break;
    // "그래핀 센서"를 골랐으면 "그래핀", "센서"가 그 아래에 또 나오지 않게
    // (단, 묶음 밖에서도 꽤 많이 나온 단어는 남긴다)
    if (out.some((o) => o.includes(" ") && o.split(" ").includes(w) && count.get(o) >= count.get(w) * 0.75)) continue;
    out.push(w);
  }
  return out;
}

module.exports = { countTerms, docFrequency, topKeywords, stripSuffix };
