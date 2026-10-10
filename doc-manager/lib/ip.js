// 지식재산 대장: 특허·실용신안·상표·디자인을 한 건씩 (출원번호·등록번호·상태·발명자·관련 주제·과제·문서).
// 사업계획서의 '지식재산 보유 현황' 표, 주제 카드의 '선행 실적'에 쓴다. 연차료 알림은 두지 않는다 (특허사무소가 챙긴다).
//
// 저장: <문서 폴더>/.docmanager/ip.json (문서 폴더를 따라 다른 PC에서도 보인다)
// 앱과 Claude 커넥터가 같이 쓰므로, 바꿀 때마다 파일을 새로 읽어 고친 뒤 바로 쓴다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");

const RIGHTS = ["특허", "실용신안", "상표", "디자인"];
const STATUSES = ["출원", "공개", "등록", "거절", "포기", "소멸"];
// 한국 출원번호 앞자리: 10 특허, 20 실용신안, 30 디자인, 40 상표 (41 서비스표, 45 상표 갱신 등도 상표로 본다)
const RIGHT_OF_PREFIX = { 10: "특허", 20: "실용신안", 30: "디자인", 40: "상표", 41: "상표", 45: "상표" };

const fileOf = (root) => path.join(store.paths(root).dir, "ip.json");
const empty = () => ({ version: 1, items: [] });

function load(root) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(root), "utf8"));
    if (d && d.version === 1 && Array.isArray(d.items)) return d;
  } catch {}
  return empty();
}

function save(root, data) {
  if (!store.ensureDir(root)) throw new Error("문서 폴더에 쓸 수 없습니다");
  const f = fileOf(root);
  fs.writeFileSync(f + ".tmp", JSON.stringify(data, null, 1));
  fs.renameSync(f + ".tmp", f);
}

const str = (v, max = 300) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

// 번호 모양 맞추기: "1020240123456" / "10-2024-0123456" → "10-2024-0123456", 등록 "10-1234567"
function normAppNo(v) {
  const d = String(v || "").replace(/[^\d]/g, "");
  if (/^\d{13}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
  return str(v, 40);
}
function normRegNo(v) {
  const d = String(v || "").replace(/[^\d]/g, "");
  if (/^\d{9}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2)}`; // 10-1234567
  if (/^\d{13}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2)}`; // 10-12345670000 (등록번호 뒤 0000)
  return str(v, 40);
}
function normDate(v) {
  const m = /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(String(v || ""));
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

function find(data, id) {
  const it = data.items.find((x) => x.id === id);
  if (!it) throw new Error("대장에 없는 건입니다: " + id);
  return it;
}

function setFields(it, f = {}) {
  if (f.right !== undefined) {
    if (!RIGHTS.includes(f.right)) throw new Error(`종류는 ${RIGHTS.join("·")} 중 하나입니다`);
    it.right = f.right;
  }
  if (f.status !== undefined) {
    if (!STATUSES.includes(f.status)) throw new Error(`상태는 ${STATUSES.join("·")} 중 하나입니다`);
    it.status = f.status;
  }
  for (const k of ["title", "applicants", "inventors", "country", "topic", "project", "memo"]) if (f[k] !== undefined) it[k] = str(f[k], k === "memo" ? 4000 : 300);
  if (f.appNo !== undefined) it.appNo = normAppNo(f.appNo);
  if (f.regNo !== undefined) it.regNo = normRegNo(f.regNo);
  if (f.pubNo !== undefined) it.pubNo = str(f.pubNo, 40);
  for (const k of ["appDate", "regDate", "pubDate"]) if (f[k] !== undefined) it[k] = normDate(f[k]) || (f[k] === "" ? "" : it[k] || "");
  // 번호로 종류를 알 수 있으면 맞춘다
  if (f.right === undefined && it.appNo && RIGHT_OF_PREFIX[it.appNo.slice(0, 2)]) it.right = RIGHT_OF_PREFIX[it.appNo.slice(0, 2)];
  // 등록번호가 생기면 상태를 등록으로 (거절·포기·소멸로 직접 정한 것은 그대로)
  if (it.regNo && (it.status === "출원" || it.status === "공개") && f.status === undefined) it.status = "등록";
}

/**
 * 바꾸기 한 번. op:
 *   { type: "create", fields }   fields: { right, title, appNo, appDate, pubNo, pubDate, regNo, regDate, status, applicants, inventors, country, topic, project, memo }
 *   { type: "update", id, fields }
 *   { type: "delete", id }
 *   { type: "link" | "unlink", id, rel }   — 출원서·명세서·등록증 같은 문서 연결
 */
function apply(data, op) {
  const now = new Date().toISOString();
  switch (op && op.type) {
    case "create": {
      const f = op.fields || {};
      if (!str(f.title) && !str(f.appNo) && !str(f.regNo)) throw new Error("명칭이나 출원번호·등록번호가 필요합니다");
      const appNo = f.appNo ? normAppNo(f.appNo) : "";
      if (appNo && data.items.some((x) => x.appNo === appNo)) throw new Error(`이미 대장에 있는 출원번호입니다: ${appNo}`);
      const it = { id: crypto.randomBytes(6).toString("hex"), right: "특허", title: "", appNo: "", appDate: "", pubNo: "", pubDate: "", regNo: "", regDate: "", status: "출원", applicants: "", inventors: "", country: "KR", topic: "", project: "", memo: "", docs: [], createdAt: now, updatedAt: now };
      setFields(it, f);
      if (Array.isArray(f.docs)) it.docs = [...new Set(f.docs.map((d) => str(d, 500)).filter(Boolean))];
      data.items.push(it);
      return { data, id: it.id };
    }
    case "update": {
      const it = find(data, op.id);
      const f = op.fields || {};
      if (f.appNo !== undefined) {
        const n = normAppNo(f.appNo);
        if (n && data.items.some((x) => x !== it && x.appNo === n)) throw new Error(`이미 대장에 있는 출원번호입니다: ${n}`);
      }
      setFields(it, f);
      it.updatedAt = now;
      return { data, id: it.id };
    }
    case "delete":
      find(data, op.id);
      data.items = data.items.filter((x) => x.id !== op.id);
      return { data };
    case "link":
    case "unlink": {
      const it = find(data, op.id);
      const rel = str(op.rel, 500);
      if (!rel) throw new Error("문서 경로가 필요합니다");
      if (op.type === "link") {
        if (!it.docs.includes(rel)) it.docs.push(rel);
      } else it.docs = it.docs.filter((d) => d !== rel);
      it.updatedAt = now;
      return { data, id: it.id };
    }
    default:
      throw new Error("알 수 없는 작업입니다");
  }
}

function update(root, op) {
  const data = load(root);
  const r = apply(data, op);
  save(root, r.data);
  return r;
}

function renameDocs(root, renames) {
  if (!renames.length || !fs.existsSync(fileOf(root))) return false;
  const data = load(root);
  const map = new Map(renames.map((r) => [r.from, r.to]));
  let changed = false;
  for (const it of data.items)
    it.docs = it.docs.map((d) => {
      if (!map.has(d)) return d;
      changed = true;
      return map.get(d);
    });
  if (changed) save(root, data);
  return changed;
}

// ---- 문서에서 번호 찾기 ----
// 본문(OCR 포함)에서 출원번호·등록번호·명칭·날짜를 뽑는다.
const APP_RE = /(?<!\d)(10|20|30|40|41|45)\s?-\s?(\d{4})\s?-\s?(\d{7})(?!\d)/g;
const REG_RE = /(?:등록\s*(?:번호|제)?\s*[:：]?\s*(?:제\s*)?)(10|20|30|40|41|45)\s?-\s?(\d{7})(?:\s?-\s?0000)?(?!\d)/g;

function readNumbers(text) {
  const t = String(text || "");
  const appNos = [...new Set([...t.matchAll(APP_RE)].map((m) => `${m[1]}-${m[2]}-${m[3]}`))];
  const regNos = [...new Set([...t.matchAll(REG_RE)].map((m) => `${m[1]}-${m[2]}`))];
  const pick = (re) => {
    const m = re.exec(t);
    return m ? str(m[1], 200) : "";
  };
  const title = pick(/(?:【?\s*발명의\s*명칭\s*】?|발명의\s*명칭\s*[:：]|고안의\s*명칭\s*[:：]?|디자인의\s*대상이\s*되는\s*물품\s*[:：]?|상표\s*견본\s*[:：]?)\s*([^\n【]{2,120})/);
  const near = (label) => normDate((new RegExp(label + "\\s*(?:일자|일)?\\s*[:：]?\\s*(\\d{4}\\s*[.\\-/년]\\s*\\d{1,2}\\s*[.\\-/월]\\s*\\d{1,2})").exec(t) || [])[1]);
  return { appNos, regNos, title, appDate: near("출원"), regDate: near("등록") };
}

// 이 문서 자신의 출원번호: 명세서·공보에는 선행기술(특허문헌 1: 10-2011-…)처럼 남의 번호도 많이 나오므로
// ① 파일 이름의 번호 ② '출원번호'·'(21)' 칸의 번호 ③ 둘 다 없으면 문서 첫머리(서지 사항 자리)의 번호만 본다.
const NUM = String.raw`(10|20|30|40|41|45)\s?-\s?(\d{4})\s?-\s?(\d{7})(?!\d)`;
const LABELED_RE = new RegExp(String.raw`(?:출\s*원\s*번\s*호|\(\s*21\s*\))\s*[】\]]?\s*[:：]?\s*(?:제\s*)?` + NUM, "g");
function ownAppNos(text, name = "") {
  const fmt = (m) => `${m[1]}-${m[2]}-${m[3]}`;
  const t = String(text || "");
  const fromName = [...String(name).matchAll(APP_RE)].map(fmt);
  const labeled = [...t.matchAll(LABELED_RE)].map(fmt);
  let own = [...fromName, ...labeled];
  if (!own.length) own = [...t.slice(0, 800).matchAll(APP_RE)].map(fmt);
  return [...new Set(own)];
}

/**
 * 지식재산 분류 문서에서 찾은 번호 가운데 대장에 없는 것: 대장에 넣자고 제안한다.
 * docs: [{ rel, text, category }]  결과: [{ appNo, regNo, right, title, appDate, regDate, docs: [rel] }]
 */
function suggestions(data, docs) {
  const known = new Set(data.items.map((x) => x.appNo).filter(Boolean));
  const knownReg = new Set(data.items.map((x) => x.regNo).filter(Boolean));
  const out = new Map();
  for (const d of docs) {
    if (!/^ip_/.test(d.category || "")) continue;
    const n = readNumbers(d.text);
    const own = ownAppNos(d.text, String(d.rel || "").split("/").pop());
    for (const appNo of own) {
      if (known.has(appNo)) continue;
      const s = out.get(appNo) || { appNo, regNo: "", right: RIGHT_OF_PREFIX[appNo.slice(0, 2)] || "특허", title: "", appDate: "", regDate: "", docs: [] };
      if (!s.docs.includes(d.rel)) s.docs.push(d.rel);
      s.title = s.title || n.title;
      s.appDate = s.appDate || n.appDate;
      // 한 문서에 출원번호 하나와 등록번호 하나면 같은 건으로 본다
      if (own.length === 1 && n.regNos.length === 1 && !knownReg.has(n.regNos[0])) {
        s.regNo = s.regNo || n.regNos[0];
        s.regDate = s.regDate || n.regDate;
      }
      out.set(appNo, s);
    }
  }
  return [...out.values()].sort((a, b) => a.appNo.localeCompare(b.appNo));
}

// 사업계획서 표에 붙여 넣을 탭 구분 글자 (엑셀·한글·워드 표에 그대로 붙는다)
function toTsv(items) {
  const head = ["구분", "명칭", "출원번호", "출원일", "등록번호", "등록일", "상태", "출원인", "발명자"];
  const rows = items.map((it) => [it.right, it.title, it.appNo, it.appDate, it.regNo, it.regDate, it.status, it.applicants, it.inventors]);
  return [head, ...rows].map((r) => r.map((c) => String(c || "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");
}

module.exports = { RIGHTS, STATUSES, fileOf, empty, load, save, apply, update, renameDocs, readNumbers, ownAppNos, suggestions, toTsv, normAppNo, normRegNo, normDate };
