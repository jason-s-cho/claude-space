// 회사 지식 카드: Claude 가 보관함 문서를 읽고 회사의 핵심 사실(기술·성능 수치·과제 이력·고객사·자주 쓰는 표현)을
// 한 장으로 정리해 두는 파일. Claude 는 글을 쓰거나 고치기 전에 이 카드를 먼저 읽는다.
//
// 위치: <문서 폴더>/Claude 지식/회사 지식 카드.md  (문서 폴더를 따라 다니고, 메모장 등으로 직접 고칠 수 있다)
// 바꿀 때마다 이전 내용을 .docmanager/knowledge-history/ 에 남긴다.
// '## 사용자 메모' 부분은 사용자가 쓰는 곳이라 Claude 가 새로 저장할 때 빠뜨려도 그대로 붙여 둔다.
const fs = require("fs");
const path = require("path");
const store = require("./store");

const DIR_NAME = "Claude 지식";
const CARD_NAME = "회사 지식 카드.md";
const USER_SECTION = "## 사용자 메모";
const MAX_BYTES = 300 * 1024;
const HISTORY_KEEP = 200; // 카드 여러 장의 기록을 같이 둔다

function paths(root) {
  const dir = path.join(root, DIR_NAME);
  return { dir, card: path.join(dir, CARD_NAME), history: path.join(store.paths(root).dir, "knowledge-history") };
}

const TEMPLATE = `# 회사 지식 카드

> Claude 가 문서 보관함의 자료를 읽고 정리한 회사의 핵심 사실입니다. Claude 는 문서를 쓰거나 고치기 전에 이 카드를 먼저 읽습니다.
> 틀린 내용은 직접 고쳐 주세요. 각 사실 뒤의 [출처] 는 근거 문서입니다.

## 1. 회사 개요
(회사 이름, 설립, 대표, 소재지, 인원, 주요 사업)

## 2. 핵심 기술·제품
(기술마다: 한 줄 설명, 특징, 적용 분야, TRL, 특허)

## 3. 대표 성능 수치
| 항목 | 값 | 조건 | 출처 | 날짜 |
|---|---|---|---|---|

## 4. 과제 이력
| 과제명 | 사업·기관 | 기간 | 규모 | 역할 | 상태 |
|---|---|---|---|---|---|

## 5. 고객사·협력 기관
(기관마다: 관계, 주요 거래·협력 내용)

## 6. 자주 쓰는 표현·문체
(제안서·보고서에서 반복해 쓰는 핵심 문장, 용어 표기 규칙)

## 7. 확인 필요
(문서마다 값이 다른 것, 오래된 정보)

${USER_SECTION}
(여기는 사용자가 직접 쓰는 곳입니다. Claude 는 이 부분을 고치지 않습니다.)
`;

function read(root) {
  return readFile(paths(root).card);
}

// 카드 파일 하나 읽기 (회사 지식 카드·주제 카드·사업 카드·작성 가이드가 같이 쓴다)
function readFile(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, path: file, updated: st.mtime.toISOString(), content: fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") };
  } catch {
    return { exists: false, path: file, updated: null, content: "" };
  }
}

// '## 사용자 메모' 부터 다음 '## ' 제목 전까지
function userSection(text) {
  const i = text.indexOf(USER_SECTION);
  if (i < 0) return "";
  const rest = text.slice(i + USER_SECTION.length);
  const next = rest.search(/\n## /);
  return (USER_SECTION + (next < 0 ? rest : rest.slice(0, next))).trimEnd();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 카드를 저장한다. 이전 내용은 기록 폴더에 남긴다.
 * protectUserSection: Claude 가 저장할 때 true. '## 사용자 메모' 는 이전 카드의 것을 그대로 쓴다 (Claude 가 빠뜨리거나 고쳐도).
 * 결과: { path, backup, keptUserSection }
 */
function save(root, content, opts = {}) {
  return saveFile(root, paths(root).card, "회사 지식 카드", content, opts);
}

// file: 카드 파일, label: 기록 파일 이름 앞부분
function saveFile(root, file, label, content, { now = new Date(), protectUserSection = false } = {}) {
  content = String(content || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!content.trim()) throw new Error("빈 내용은 저장하지 않습니다.");
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`카드가 너무 깁니다 (최대 ${MAX_BYTES / 1024}KB). 핵심만 남겨 주세요.`);
  const history = paths(root).history;
  const old = readFile(file);
  let keptUserSection = false;
  const mine = protectUserSection && old.exists ? userSection(old.content) : "";
  if (mine) {
    const theirs = userSection(content);
    if (theirs !== mine) {
      content = theirs ? content.replace(theirs, () => mine) : content.trimEnd() + "\n\n" + mine + "\n";
      keptUserSection = true;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (old.exists && old.content !== content) {
    fs.mkdirSync(history, { recursive: true });
    backup = path.join(history, `${label.replace(/[\\/:*?"<>|]/g, " ")}_${stamp(now)}.md`);
    fs.writeFileSync(backup, old.content);
    prune(history);
  }
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return { path: file, backup, keptUserSection };
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) fs.unlinkSync(path.join(dir, f));
  } catch {}
}

// 예전 내용 목록 (최근 것부터)
function history(root) {
  const dir = paths(root).history;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Claude 에게 주는 작성 절차 (커넥터의 도구 설명과 '지식 카드 만들기' 프롬프트에 쓴다)
const BUILD_STEPS = `회사 지식 카드를 만들거나 새로 고치는 순서:
1. get_knowledge 로 지금 카드를 읽는다 (없으면 빈 양식이 온다). 사용자가 고친 내용은 그대로 살린다.
2. library_overview 로 분류·과제·고객사를 본다.
3. search_documents 로 분류마다 대표 문서를 찾아 read_document 로 읽는다. 우선순위: 최신 IR·회사소개서 → 최근 사업계획서·수요조사서 → 보고서 → 기술·시장 분석 → 고객사·견적. 긴 문서는 next_offset 으로 필요한 만큼 이어 읽는다.
4. 양식의 각 칸을 채운다. 사실과 수치마다 [출처: 문서 경로] 를 붙이고, 추측은 쓰지 않는다. 같은 항목이 문서마다 다르면 '확인 필요'에 둘 다 적는다 (예: 300mm vs 200mm).
5. '## 사용자 메모' 부분은 고치지 말고 그대로 둔다.
6. save_knowledge_card 로 저장하고, 무엇을 새로 넣거나 바꿨는지와 확인 필요한 항목을 사용자에게 짧게 알려 준다.`;

module.exports = { DIR_NAME, CARD_NAME, USER_SECTION, TEMPLATE, BUILD_STEPS, paths, read, save, readFile, saveFile, history, userSection };
