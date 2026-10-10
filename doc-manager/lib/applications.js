// 지원 건: 한 주제(기술)를 한 사업에 낸 것. 수요조사 → RFP → 사업계획서 → 서류평가 → 발표평가 → 선정 처럼
// 단계마다 결과(통과·탈락)·날짜·평가 의견·관련 문서를 남긴다. 탈락한 단계와 사유는 다음 작성 때 Claude 가 참고한다.
//
// 단계 목록은 바꿀 수 있다:
//   - 단계 틀(템플릿): 사업 유형마다 기본 단계 목록. 새 지원 건을 만들 때 고른다.
//   - 지원 건마다 단계를 더하고 빼고 이름·순서를 바꿀 수 있다 (틀을 바꿔도 이미 만든 지원 건은 그대로).
//
// 사업 자료: 공고문·RFP·작성 양식·평가 기준처럼 남이 만든 참고 문서.
//   - 사업(사업명)에 붙이면 그 사업의 지원 건 모두가 같이 본다 (한 공고에 수요조사를 여러 건 내므로).
//   - 지원 건 하나에만 해당하는 자료(그 과제의 RFP 등)는 지원 건에 붙인다.
//
// 저장: <문서 폴더>/.docmanager/applications.json (문서 폴더를 따라 다른 PC에서도 보인다)
// 앱과 Claude 커넥터가 같이 쓰므로, 바꿀 때마다 파일을 새로 읽어 고친 뒤 바로 쓴다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");

const STATUSES = ["", "진행", "통과", "탈락", "제외"]; // "" = 아직 / 제외 = 이 건에서는 없는 단계
const REF_KINDS = ["공고문", "RFP", "작성 양식", "평가 기준", "참고 자료"];
const DEFAULT_TEMPLATES = [
  { name: "국가 R&D (수요조사부터)", stages: ["수요조사 제출", "RFP 반영", "사업계획서 제출", "서류평가", "발표평가", "선정·협약"] },
  { name: "국가 R&D (공고부터)", stages: ["사업계획서 제출", "서류평가", "발표평가", "선정·협약"] },
  { name: "지원사업 (창업·바우처 등)", stages: ["신청서 제출", "요건 검토", "서류평가", "발표평가", "선정·협약"] },
];

const fileOf = (root) => path.join(store.paths(root).dir, "applications.json");

function empty() {
  return { version: 1, templates: DEFAULT_TEMPLATES.map((t) => ({ name: t.name, stages: [...t.stages] })), programs: {}, items: [] };
}

function load(root) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(root), "utf8"));
    if (data && data.version === 1 && Array.isArray(data.items)) {
      if (!Array.isArray(data.templates) || !data.templates.length) data.templates = empty().templates;
      if (!data.programs || typeof data.programs !== "object" || Array.isArray(data.programs)) data.programs = {};
      for (const a of data.items) if (!Array.isArray(a.refs)) a.refs = [];
      return data;
    }
  } catch {}
  return empty();
}

function save(root, data) {
  if (!store.ensureDir(root)) throw new Error("문서 폴더에 쓸 수 없습니다");
  const f = fileOf(root);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, f);
}

const str = (v, max = 300) => String(v == null ? "" : v).trim().slice(0, max);
// 사업명은 묶음 기준이라 띄어쓰기 차이로 갈라지지 않게 한 칸으로 맞춘다
const programName = (v) => str(v, 200).replace(/\s+/g, " ");
const today = () => new Date().toISOString().slice(0, 10);

// 마감: "YYYY-MM-DD" 또는 "YYYY-MM-DD HH:MM" (공고의 접수 마감 시각까지)
function cleanDue(v) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(v || "").trim());
  if (!m) return "";
  if (m[2] === undefined) return m[1];
  const h = Math.min(23, parseInt(m[2], 10));
  return `${m[1]} ${String(h).padStart(2, "0")}:${m[3]}`;
}

function cleanStage(s) {
  if (typeof s === "string") s = { name: s };
  const name = str(s && s.name, 60);
  if (!name) throw new Error("단계 이름이 비어 있습니다");
  const status = STATUSES.includes(s.status) ? s.status : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s.date || "") ? s.date : "";
  const docs = [...new Set((Array.isArray(s.docs) ? s.docs : []).map((d) => str(d, 500)).filter(Boolean))];
  return { name, status, date, due: cleanDue(s.due), note: str(s.note, 4000), docs };
}

function cleanStages(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("단계가 하나 이상 있어야 합니다");
  if (list.length > 20) throw new Error("단계는 20개까지 둘 수 있습니다");
  const out = list.map(cleanStage);
  const names = out.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`단계 이름이 겹칩니다: ${dup}`);
  return out;
}

function find(data, id) {
  const a = data.items.find((x) => x.id === id);
  if (!a) throw new Error("없는 지원 건입니다: " + id);
  return a;
}

/** 지금 어디까지 왔는지: { state: "준비"|"진행 중"|"탈락"|"선정", stage } */
function progress(a) {
  const st = a.stages.filter((s) => s.status !== "제외");
  const failed = st.find((s) => s.status === "탈락");
  if (failed) return { state: "탈락", stage: failed.name };
  if (st.length && st[st.length - 1].status === "통과") return { state: "선정", stage: st[st.length - 1].name };
  const done = st.filter((s) => s.status);
  if (!done.length) return { state: "준비", stage: st[0] ? st[0].name : "" };
  const last = done[done.length - 1];
  // 마지막으로 통과한 단계 다음이 지금 단계
  if (last.status === "통과") {
    const next = st[st.indexOf(last) + 1];
    return { state: "진행 중", stage: next ? next.name : last.name };
  }
  return { state: "진행 중", stage: last.name };
}

/**
 * 바꾸기 한 번. op:
 *   { type: "create", fields: { title, topic, program, agency, year, memo }, template?: 틀 이름 | stages?: [...] }
 *   { type: "update", id, fields }
 *   { type: "delete", id }
 *   { type: "stage", id, stage: 이름, patch: { status?, date?, note?, due? } } — 단계 결과·마감 기록
 *   { type: "stages", id, stages: [...] }                                — 단계 목록 통째로 (더하기·빼기·이름·순서)
 *   { type: "link" | "unlink", id, stage, rel }                          — 문서 연결
 *   { type: "templates", templates: [{ name, stages: [이름…] }] }
 *   { type: "bundle", id, kinds: [증빙 종류…] }                         — 제출 서류 꾸러미에 넣을 증빙
 *   { type: "ref_link" | "ref_unlink", program | id, rel, kind? }        — 사업 자료(공고문·RFP 등) 연결. 사업 전체면 program, 이 건만이면 id
 * 결과: { data, id? }
 */
function apply(data, op) {
  const now = new Date().toISOString();
  const touch = (a) => (a.updatedAt = now);
  const fields = (a, f = {}) => {
    for (const k of ["title", "topic", "program", "agency", "memo"]) if (f[k] !== undefined) a[k] = str(f[k], k === "memo" ? 4000 : 200);
    for (const k of ["program", "agency"]) if (f[k] !== undefined) a[k] = programName(f[k]);
    if (f.year !== undefined) {
      const y = parseInt(f.year, 10);
      a.year = y >= 2000 && y <= 2100 ? y : null;
    }
  };
  switch (op && op.type) {
    case "create": {
      const f = op.fields || {};
      if (!str(f.title) && !str(f.topic)) throw new Error("지원 건 이름(과제명)이나 주제가 필요합니다");
      let stages;
      if (op.stages) stages = cleanStages(op.stages);
      else {
        const t = data.templates.find((x) => x.name === op.template) || data.templates[0];
        stages = cleanStages(t.stages);
      }
      const a = { id: crypto.randomBytes(6).toString("hex"), title: "", topic: "", program: "", agency: "", year: new Date().getFullYear(), memo: "", template: op.template || "", stages, refs: [], createdAt: now, updatedAt: now };
      fields(a, f);
      data.items.push(a);
      return { data, id: a.id };
    }
    case "update": {
      const a = find(data, op.id);
      const before = a.program;
      fields(a, op.fields);
      // 사업명을 고쳤고 옛 이름을 쓰는 지원 건이 더는 없으면, 옛 사업 자료를 새 이름으로 옮긴다
      if (before && a.program !== before && data.programs[before] && !data.items.some((x) => x.program === before)) {
        if (a.program && !data.programs[a.program]) data.programs[a.program] = data.programs[before];
        delete data.programs[before];
      }
      touch(a);
      return { data, id: a.id };
    }
    case "delete": {
      find(data, op.id);
      data.items = data.items.filter((x) => x.id !== op.id);
      return { data };
    }
    case "stage": {
      const a = find(data, op.id);
      const s = a.stages.find((x) => x.name === op.stage);
      if (!s) throw new Error(`이 지원 건에 '${op.stage}' 단계가 없습니다 (있는 단계: ${a.stages.map((x) => x.name).join(", ")})`);
      const p = op.patch || {};
      if (p.status !== undefined) {
        if (!STATUSES.includes(p.status)) throw new Error(`결과는 ${STATUSES.filter(Boolean).join("·")} 중 하나(또는 빈 값)입니다`);
        s.status = p.status;
        if (p.status && !s.date && p.date === undefined) s.date = today();
      }
      if (p.date !== undefined) s.date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || "") ? p.date : "";
      if (p.note !== undefined) s.note = str(p.note, 4000);
      if (p.due !== undefined) {
        if (p.due && !cleanDue(p.due)) throw new Error("마감은 YYYY-MM-DD 또는 YYYY-MM-DD HH:MM 으로 적어 주세요");
        s.due = cleanDue(p.due);
      }
      touch(a);
      return { data, id: a.id };
    }
    case "stages": {
      const a = find(data, op.id);
      a.stages = cleanStages(op.stages);
      touch(a);
      return { data, id: a.id };
    }
    case "link":
    case "unlink": {
      const a = find(data, op.id);
      const s = a.stages.find((x) => x.name === op.stage);
      if (!s) throw new Error(`이 지원 건에 '${op.stage}' 단계가 없습니다`);
      const rel = str(op.rel, 500);
      if (!rel) throw new Error("문서 경로가 필요합니다");
      if (op.type === "link") {
        if (!s.docs.includes(rel)) s.docs.push(rel);
      } else s.docs = s.docs.filter((d) => d !== rel);
      touch(a);
      return { data, id: a.id };
    }
    case "ref_link":
    case "ref_unlink": {
      // program(사업명) 이나 id(지원 건) 중 하나에 붙인다
      let refs, a = null;
      if (op.id) {
        a = find(data, op.id);
        refs = a.refs;
      } else {
        const name = programName(op.program);
        if (!name) throw new Error("사업명(program)이나 지원 건 id 가 필요합니다");
        if (op.type === "ref_link" && !data.items.some((x) => x.program === name) && !data.programs[name])
          throw new Error(`'${name}' 사업의 지원 건이 없습니다. 지원 건을 먼저 만들거나 사업명을 확인하세요.`);
        data.programs[name] = data.programs[name] || { refs: [] };
        refs = data.programs[name].refs;
      }
      const rel = str(op.rel, 500);
      if (!rel) throw new Error("문서 경로가 필요합니다");
      const i = refs.findIndex((r) => r.rel === rel);
      if (op.type === "ref_link") {
        const kind = REF_KINDS.includes(op.kind) ? op.kind : i >= 0 ? refs[i].kind : "참고 자료";
        if (i >= 0) refs[i].kind = kind; // 이미 있으면 종류만 바꾼다
        else refs.push({ rel, kind });
      } else if (i >= 0) refs.splice(i, 1);
      if (!a) {
        const name = programName(op.program);
        if (!data.programs[name].refs.length) delete data.programs[name];
      } else touch(a);
      return { data, id: a ? a.id : undefined, program: a ? undefined : programName(op.program) };
    }
    case "bundle": {
      // 이 지원 건에 낼 회사 증빙 종류 (예: 사업자등록증, 벤처기업확인서) — 꾸러미를 만들 때 최신본을 모은다
      const a = find(data, op.id);
      a.bundle = [...new Set((Array.isArray(op.kinds) ? op.kinds : []).map((k) => str(k, 60)).filter(Boolean))].slice(0, 40);
      touch(a);
      return { data, id: a.id };
    }
    case "templates": {
      if (!Array.isArray(op.templates) || !op.templates.length) throw new Error("단계 틀이 하나 이상 있어야 합니다");
      const out = op.templates.map((t) => ({ name: str(t.name, 60), stages: cleanStages(t.stages).map((s) => s.name) }));
      if (out.some((t) => !t.name)) throw new Error("단계 틀 이름이 비어 있습니다");
      const names = out.map((t) => t.name);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) throw new Error(`단계 틀 이름이 겹칩니다: ${dup}`);
      data.templates = out;
      return { data };
    }
    default:
      throw new Error("알 수 없는 작업입니다");
  }
}

// 마감까지 남은 날 (오늘 마감 = 0, 지났으면 음수). now 는 시험용
function daysLeft(due, now = new Date()) {
  const [d] = String(due).split(" ");
  const [y, m, dd] = d.split("-").map(Number);
  const a = new Date(y, m - 1, dd), b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86400000);
}

/**
 * 다가오는 마감: 아직 결과가 없거나 진행 중인 단계의 마감. 지난 것도 overdueDays 안이면 보여 준다.
 * 결과: [{ id, title, program, stage, due, daysLeft }] 가까운 순
 */
function upcoming(data, { now = new Date(), withinDays = 60, overdueDays = 14 } = {}) {
  const out = [];
  for (const a of data.items)
    for (const s of a.stages) {
      if (!s.due || !(s.status === "" || s.status === "진행")) continue;
      const left = daysLeft(s.due, now);
      if (left > withinDays || left < -overdueDays) continue;
      out.push({ id: a.id, title: a.title || a.topic || "(이름 없음)", program: a.program || "", stage: s.name, due: s.due, daysLeft: left });
    }
  return out.sort((x, y) => x.due.localeCompare(y.due));
}

// 파일을 새로 읽어 바꾸고 바로 쓴다 (앱과 커넥터가 같이 써도 서로 덮어쓰지 않게)
function update(root, op) {
  const data = load(root);
  const r = apply(data, op);
  save(root, r.data);
  return r;
}

// 문서가 옮겨지면(이름·폴더 바뀜) 연결도 따라 바꾼다. renames: [{ from, to }]
function renameDocs(root, renames) {
  if (!renames.length || !fs.existsSync(fileOf(root))) return false;
  const data = load(root);
  const map = new Map(renames.map((r) => [r.from, r.to]));
  let changed = false;
  const follow = (d) => {
    if (!map.has(d)) return d;
    changed = true;
    return map.get(d);
  };
  const followRefs = (refs) => refs.forEach((r) => (r.rel = follow(r.rel)));
  for (const a of data.items) {
    for (const s of a.stages) s.docs = s.docs.map(follow);
    followRefs(a.refs);
  }
  for (const p of Object.values(data.programs)) followRefs(p.refs);
  if (changed) save(root, data);
  return changed;
}

module.exports = { cleanDue, daysLeft, upcoming, REF_KINDS, programName, STATUSES, DEFAULT_TEMPLATES, fileOf, load, save, apply, update, progress, renameDocs, empty };
