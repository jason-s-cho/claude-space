// 작성용 카드: 회사 지식 카드 옆에 두는 세 가지.
//   - 주제 카드 (주제마다 한 장): 기술의 핵심 내용·수치·차별점·실적·검증된 문장. 같은 주제를 여러 사업에 낼 때 다시 쓴다.
//   - 사업 카드 (사업마다 한 장): 사업의 목적·자격·평가 항목·강조점·양식 특징·우리 지원 교훈.
//   - 작성 가이드 (문서 종류마다 한 장: 수요조사서, 사업계획서 …): 양식이 달라도 비슷한 '항목 종류'마다 쓰는 법.
//     수요조사서는 짧고 RFP 에 반영되는 것이 목표, 사업계획서는 평가 배점에 맞춘 긴 문서라 쓰는 법이 다르다.
// Claude 는 문서를 쓸 때 양식(inspect_form) × 주제 카드 × 사업 카드 × 작성 가이드를 함께 본다.
//
// 위치: <문서 폴더>/Claude 지식/주제/<주제>.md, …/사업/<사업명>.md, …/작성 가이드/<문서 종류>.md
// 저장·기록·'## 사용자 메모' 보호는 회사 지식 카드와 같다 (knowledge.js).
const fs = require("fs");
const path = require("path");
const knowledge = require("./knowledge");

const KINDS = {
  topic: { label: "주제 카드", dir: "주제" },
  program: { label: "사업 카드", dir: "사업" },
  guide: { label: "작성 가이드", dir: "작성 가이드" },
};
const GUIDE_NAMES = ["수요조사서", "사업계획서"]; // 기본으로 보여 주는 작성 가이드
const LEGACY_GUIDE = "작성 가이드.md"; // 예전(한 장짜리) 작성 가이드

// 사업명은 지원 건과 같은 규칙으로 맞춘다 (띄어쓰기 한 칸)
const cleanName = (n) => String(n == null ? "" : n).replace(/\s+/g, " ").trim().slice(0, 100);
// 파일 이름으로 못 쓰는 글자는 비슷한 글자로 바꾼다 (원래 이름은 카드 첫 줄에 남는다)
const fileSafe = (n) => n.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "");

const NAME_OF = { topic: "주제", program: "사업명", guide: "문서 종류(예: 수요조사서, 사업계획서)" };
function check(kind, name) {
  if (!KINDS[kind]) throw new Error("카드 종류는 topic(주제)·program(사업)·guide(작성 가이드) 중 하나입니다");
  const n = cleanName(name);
  if (!n) throw new Error(`${KINDS[kind].label} 이름(${NAME_OF[kind]})이 필요합니다`);
  return n;
}

function fileOf(root, kind, name) {
  return path.join(root, knowledge.DIR_NAME, KINDS[kind].dir, fileSafe(check(kind, name)) + ".md");
}

// 예전 한 장짜리 작성 가이드는 사업계획서 가이드로 옮긴다 (그 양식이 사업계획서 항목이었다)
function migrateLegacyGuide(root) {
  const old = path.join(root, knowledge.DIR_NAME, LEGACY_GUIDE);
  if (!fs.existsSync(old)) return false;
  const dest = fileOf(root, "guide", "사업계획서");
  if (fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const text = fs.readFileSync(old, "utf8").replace(/^# 작성 가이드\s*$/m, "# 작성 가이드: 사업계획서");
  fs.writeFileSync(dest, text);
  fs.unlinkSync(old);
  return true;
}

const relOf = (root, file) => path.relative(root, file).split(path.sep).join("/");

function template(kind, name) {
  const U = `${knowledge.USER_SECTION}\n(여기는 사용자가 직접 쓰는 곳입니다. Claude 는 이 부분을 고치지 않습니다.)\n`;
  if (kind === "topic")
    return `# 주제 카드: ${name}

> 이 주제(기술)로 문서를 쓸 때 Claude 가 먼저 읽는 카드입니다. 사업이 달라도 이 내용은 같이 씁니다.
> 각 사실 뒤의 [출처] 는 근거 문서입니다. 틀린 내용은 직접 고쳐 주세요.

## 1. 한 줄 정의
(무엇을, 어떻게 해서, 무엇이 좋아지는 기술인지 한 문장)

## 2. 기술 개요
(원리, 구성, 공정. 3~6줄)

## 3. 핵심 성능·목표 수치
| 항목 | 현재 수준 | 목표 | 비교 대상(경쟁 기술·세계 최고) | 출처 |
|---|---|---|---|---|

## 4. 차별점
(경쟁 기술·기존 제품보다 나은 점. 수치로)

## 5. 선행 연구·실적
(특허, 논문, 시제품, 수행 과제, 인증, 수상)

## 6. 적용 분야·시장
(수요처, 시장 규모와 출처, 고객 반응·LOI)

## 7. 사업화 단서
(제품 형태, 판매 경로, 가격, 양산 계획, 협력사)

## 8. 지원 이력과 교훈
| 사업 | 연도 | 결과(단계) | 평가 의견·탈락 사유 |
|---|---|---|---|

## 9. 검증된 문장
(통과한 문서에서 쓴 표현 가운데 다시 쓸 만한 것)

## 10. 확인 필요
(문서마다 값이 다른 것, 오래된 정보)

${U}`;
  if (kind === "program")
    return `# 사업 카드: ${name}

> 이 사업에 낼 문서를 쓸 때 Claude 가 먼저 읽는 카드입니다. 공고문·RFP·평가 기준(사업 자료)과 우리 지원 이력으로 만듭니다.
> 각 사실 뒤의 [출처] 는 근거 문서입니다. 해마다 공고가 바뀌면 고쳐 주세요.

## 1. 사업 개요
(부처, 전문기관, 목적, 지원 규모·기간, 기업 부담금, 공고 연도)

## 2. 일정
(수요조사, 공고, 접수 마감, 서류·발표평가, 협약)

## 3. 신청 자격·요건
(주관·참여기관 조건, 가점·감점, 제외 대상)

## 4. 평가 항목·배점
| 평가 항목 | 배점 | 무엇을 보는지 |
|---|---|---|

## 5. 이 사업이 강조하는 것
(정책 방향, 자주 나오는 키워드, 우대 분야. 문서에서 꼭 짚어야 할 점)

## 6. 양식 특징
(분량 제한, 필수 항목, 작성 요령, 첨부 서류)

## 7. 우리 지원 이력과 교훈
| 과제(주제) | 연도 | 결과(단계) | 평가 의견·탈락 사유 | 다음에 바꿀 점 |
|---|---|---|---|---|

## 8. 확인 필요

${U}`;
  if (/수요조사/.test(name))
    return `# 작성 가이드: ${name}

> 수요조사서를 쓸 때 Claude 가 따르는 가이드입니다. 수요조사서는 짧고, 목표는 '우리 기술이 RFP(과제 공고)로 반영되는 것'입니다.
> 양식은 사업마다 달라도 칸의 종류는 비슷합니다. 칸마다 어떤 종류인지 보고 아래 쓰는 법을 따릅니다. 우리 회사 수요조사서 가운데 RFP 에 반영된 것을 기준으로 정리합니다.

## 공통 원칙
(분량, 문체, RFP 문구처럼 쓰기: 기업 고유 제품명보다 기술·목표 중심, 너무 좁지 않게 범위 잡기, 수치에는 근거)

## 항목별 쓰는 법
### 기술명·과제명
(RFP 제목이 될 수 있게: 핵심 기술 + 성능 + 적용처)

### 개요·필요성
(정책·산업 수요, 왜 지금 국가가 지원해야 하는지)

### 개발 목표 (정량 목표)
(측정 가능한 지표·단위·목표치, 세계 최고 수준과 비교)

### 개발 내용·범위
(세부 내용, 기간·TRL 시작/종료)

### 국내외 동향·차별성
(경쟁 기술, 국내 기술 수준, 차별점)

### 활용·기대 효과
(수요처, 시장 규모, 파급 효과)

### 지원 규모·기간
(예산·기간 제안 방식)

## RFP 반영·탈락에서 배운 점
(반영된 수요조사서의 공통점, 반영 안 된 이유)

${U}`;
  return `# 작성 가이드: ${name}

> ${name}를 쓸 때 Claude 가 따르는 가이드입니다. 양식은 사업마다 달라도 칸의 종류는 비슷합니다. 칸마다 어떤 종류인지 보고 아래 쓰는 법을 따릅니다.
> 우리 회사 ${name} 가운데 선정된 것을 기준으로 정리합니다. 평가 항목·배점은 사업 카드를 따릅니다.

## 공통 원칙
(문체: 개조식/서술식, 문장 길이, 수치에는 근거·출처, 용어 표기 규칙, 피할 표현, 평가 항목에 맞춘 소제목)

## 항목별 쓰는 법
### 요약·초록
(분량, 꼭 넣을 것: 목표·핵심 기술·차별점·기대 효과)

### 연구개발 목표 (최종 목표·정량 목표)
(정량 목표 표 쓰는 법: 항목·단위·현재 수준·목표·세계 최고 수준·측정 방법·공인 시험 기관)

### 필요성·배경
(정책·시장·기술 측면 순서, 근거 통계)

### 국내외 현황·차별성
(경쟁 기술 비교표, 우리 기술의 위치)

### 개발 내용·방법
(세부 과제별, 연차별, 방법·검증)

### 선행 연구·수행 역량
(실적 나열 순서, 인력·장비)

### 추진 체계·일정
(기관별 역할, 일정표)

### 활용·사업화 계획
(목표 시장, 매출 계획 근거, 판로, 투자·고용)

### 기대 효과
(기술·경제·사회 효과, 수치)

### 연구비
(비목별 원칙)

## 탈락 사유에서 배운 점
(지원 건의 평가 의견에서 되풀이되는 지적과 대응)

${U}`;
}

function read(root, kind, name) {
  if (kind === "guide") migrateLegacyGuide(root);
  const n = check(kind, name);
  const k = knowledge.readFile(fileOf(root, kind, n));
  return { kind, name: n, label: KINDS[kind].label, rel: relOf(root, k.path), ...k };
}

/** 저장. 결과: { path, rel, backup, keptUserSection } */
function save(root, kind, name, content, opts = {}) {
  const n = check(kind, name);
  const file = fileOf(root, kind, n);
  const r = knowledge.saveFile(root, file, `${KINDS[kind].label}_${fileSafe(n)}`, content, opts);
  return { ...r, rel: relOf(root, file), kind, name: n };
}

// 만들어 둔 카드 목록: [{ kind, name, label, rel, updated, size }]
function list(root) {
  const base = path.join(root, knowledge.DIR_NAME);
  const out = [];
  migrateLegacyGuide(root);
  for (const kind of ["topic", "program", "guide"]) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, KINDS[kind].dir)).filter((f) => f.endsWith(".md"));
    } catch {}
    for (const f of files.sort((a, b) => a.localeCompare(b, "ko"))) {
      const file = path.join(base, KINDS[kind].dir, f);
      // 카드 이름은 첫 줄 제목에서 (파일 이름은 못 쓰는 글자를 바꿨을 수 있다)
      let name = f.slice(0, -3);
      try {
        const head = fs.readFileSync(file, "utf8").slice(0, 300);
        const m = /^#\s*(?:주제 카드|사업 카드|작성 가이드):\s*(.+)$/m.exec(head);
        if (m) name = cleanName(m[1]);
      } catch {}
      const st = fs.statSync(file);
      out.push({ kind, name, label: KINDS[kind].label, rel: relOf(root, file), updated: st.mtime.toISOString(), size: st.size });
    }
  }
  return out;
}

// Claude 에게 주는 작성 절차
const BUILD_STEPS = {
  topic: `주제 카드를 만들거나 새로 고치는 순서:
1. get_card(kind: topic, name: 주제) 로 지금 카드를 읽는다 (없으면 빈 양식). 사용자가 고친 내용은 살린다. get_knowledge 의 회사 지식 카드도 읽는다.
2. search_documents 로 그 주제의 문서(수요조사서·사업계획서·보고서·IR·기술 분석)를 찾아 read_document 로 읽는다. 최신 문서와 선정된 문서를 먼저.
3. list_applications(query: 주제) 와 get_application 으로 그 주제를 낸 사업·결과·탈락 사유를 '지원 이력과 교훈'에 정리한다.
4. 사실·수치마다 [출처: 문서 경로] 를 붙이고 추측은 쓰지 않는다. 문서마다 값이 다르면 '확인 필요'에 둘 다 적는다.
5. '## 사용자 메모' 는 그대로 두고 save_card 로 저장한 뒤, 새로 넣거나 바꾼 것과 확인 필요한 것을 짧게 알려 준다.`,
  program: `사업 카드를 만들거나 새로 고치는 순서:
1. get_card(kind: program, name: 사업명) 로 지금 카드를 읽는다 (없으면 빈 양식). 사용자가 고친 내용은 살린다.
2. get_program 으로 사업 자료(공고문·RFP·작성 양식·평가 기준)를 찾아 read_document 로 읽는다. 작성 양식은 inspect_form 으로 칸 구성을 본다.
3. 공고문에서 개요·일정·자격·평가 항목과 배점·강조점·양식 특징을 뽑는다. 사업 자료가 없으면 search_documents 로 그 사업의 공고·안내 문서를 찾고, 그래도 없으면 사용자에게 공고문을 '사업 자료'에 넣어 달라고 한다.
4. 그 사업의 지원 건(get_program 의 applications → get_application)에서 결과와 평가 의견을 '우리 지원 이력과 교훈'에 정리하고 다음에 바꿀 점을 적는다.
5. 사실마다 [출처] 를 붙이고, '## 사용자 메모' 는 그대로 두고 save_card 로 저장한 뒤 짧게 알려 준다.`,
  guide: `작성 가이드를 만들거나 새로 고치는 순서 (문서 종류마다 한 장: 수요조사서, 사업계획서):
1. get_card(kind: guide, name: 문서 종류) 로 지금 가이드를 읽는다 (없으면 그 문서 종류에 맞는 빈 양식). 사용자가 고친 내용은 살린다.
2. 그 종류의 우리 문서를 읽는다. 수요조사서: 'RFP 반영' 단계가 통과한 지원 건의 수요조사서를 먼저(list_applications → get_application 의 단계 문서). 사업계획서: 선정(state: 선정)된 지원 건의 계획서를 먼저. 없으면 search_documents 로 최근 것을 읽는다. 보관함의 작성 안내·작성 요령 자료도 참고한다.
3. 항목 종류마다 우리 문서가 어떻게 썼는지 공통점을 뽑아 '쓰는 법'으로 정리하고, 짧은 예시 문장과 [출처] 를 붙인다.
4. 탈락하거나 반영되지 않은 지원 건의 평가 의견에서 되풀이되는 지적을 '배운 점'에 정리한다.
5. '## 사용자 메모' 는 그대로 두고 save_card 로 저장한 뒤 짧게 알려 준다.`,
};

// 사업 문서를 쓰는 순서 (커넥터의 '사업 문서 쓰기' 프롬프트)
const WRITE_STEPS = `사업에 낼 문서(수요조사서·사업계획서 등)를 쓰는 순서:
1. 무엇을 쓰는지 확인한다: 지원 건(list_applications 로 찾거나, 없으면 사용자에게 주제·사업명을 물어 record_application 으로 만든다)과 채울 양식.
2. 바탕 자료를 읽는다:
   - get_knowledge: 회사 지식 카드
   - get_application: 단계별 결과와 탈락 사유, 이 건만의 자료
   - get_program: 그 사업의 공고문·RFP·평가 기준·작성 양식 → read_document 로 읽는다
   - get_card: 주제 카드(topic), 사업 카드(program), 쓸 문서 종류의 작성 가이드(guide, name: 수요조사서 또는 사업계획서). 없으면 사용자에게 알리고, 원하면 먼저 만든다.
   - 같은 주제를 다른 사업에 낸 지원 건(list_applications(query: 주제))의 문서와 평가 의견
3. 양식을 본다: inspect_form. .hwp/.doc 이면 convert_document 로 hwpx/docx 로 바꾼 뒤 본다. 양식이 사업 자료에 없으면 사용자에게 묻는다.
4. 칸마다 쓴다: 칸의 안내 문구로 항목 종류를 정하고 작성 가이드의 그 항목 쓰는 법을 따른다. 사실·수치는 주제 카드와 회사 지식 카드에서, 강조점과 평가 항목은 사업 카드와 공고문에서 가져온다. 지난 탈락 사유가 되풀이되지 않게 한다. RFP 가 있으면 그 문구와 목표에 맞춘다. 근거 없는 수치는 만들지 말고 [확인 필요] 로 남긴다.
5. 채우기 전에 칸별 요약(어느 칸에 무엇을, 어떤 근거로)과 확인 필요 항목을 사용자에게 보여 주고 확인받는다.
6. fill_form 으로 새 파일에 채운다 (원본 양식은 그대로). 표 행이 모자라면 table_rows 를 쓴다.
7. record_application 으로 새 파일을 해당 단계에 연결하고(link) 단계 결과를 '진행'으로 기록한다.
8. 이번에 새로 확인한 사실·표현이 있으면 주제 카드·사업 카드에 넣을지 사용자에게 묻는다.`;

module.exports = { GUIDE_NAMES, KINDS, cleanName, fileOf, template, read, save, list, BUILD_STEPS, WRITE_STEPS };
