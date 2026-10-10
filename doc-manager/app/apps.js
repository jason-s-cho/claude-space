// ---------- 지원 현황: 지원 건(주제 × 사업)과 단계별 결과 ----------
// app.js 다음에 읽는다 (S, $, esc, icon, toast, byRel, goto, filter, renderSide, renderList, renderDetail 을 같이 쓴다).

let selectedApp = "";
let appsFilter = "all"; // all | 준비 | 진행 중 | 탈락 | 선정
const APP_STATE_CLASS = { 준비: "s-ready", "진행 중": "s-doing", 탈락: "s-fail", 선정: "s-pass" };
const STAGE_CLASS = { "": "st-none", 진행: "st-doing", 통과: "st-pass", 탈락: "st-fail", 제외: "st-skip" };
const STATUS_LABEL = { "": "아직", 진행: "진행", 통과: "통과", 탈락: "탈락", 제외: "제외(없음)" };
const appsOf = () => (S.applications && S.applications.items) || [];
const templatesOf = () => (S.applications && S.applications.templates) || [];
const appName = (a) => a.title || a.topic || "(이름 없음)";

async function appsOp(op, okMsg) {
  const r = await api.appsOp(op);
  if (r.error) {
    toast(r.error, 6000);
    return null;
  }
  if (okMsg) toast(okMsg);
  return r;
}

// 사업명별 하위 화면이면 그 사업명, 아니면 null
const appsProgram = () => (filter.view.startsWith("apps:") ? filter.view.slice(5) : null);
let appsCollapsed = new Set(pref("appsCollapsed", [])); // 목록에서 접어 둔 사업명

function appRowHtml(a) {
  const p = a.progress;
  const pipe = a.stages
    .map((s) => `<li class="${STAGE_CLASS[s.status] || ""}" title="${esc(`${s.name}: ${STATUS_LABEL[s.status] || s.status}${s.date ? " · " + s.date : ""}${s.note ? "\n" + s.note : ""}`)}"><span>${esc(s.name)}</span></li>`)
    .join("");
  return `<div class="app-row${a.id === selectedApp ? " sel" : ""}" data-a-id="${esc(a.id)}">
    <div class="app-main"><div class="app-title">${esc(appName(a))}</div>
      <div class="app-meta">${[a.topic && a.title ? a.topic : "", a.agency, a.year].filter(Boolean).map(esc).join(" · ")}</div></div>
    <span class="app-state ${APP_STATE_CLASS[p.state] || ""}">${esc(p.state)}${p.stage && p.state !== "선정" ? ` · ${esc(p.stage)}` : ""}</span>
    <ol class="pipe">${pipe}</ol>
  </div>`;
}

// 가운데: 지원 건 목록 (단계 흐름 막대). 전체 보기에서는 사업명별로 묶는다.
function renderAppsView() {
  let program = appsProgram();
  // 그 사업의 지원 건이 다 없어졌으면(사업명을 바꿨거나 지웠으면) 전체로 돌아간다
  if (program !== null && !appsOf().some((a) => progKey(a) === program)) {
    filter.view = "apps";
    program = null;
    renderSide();
  }
  const all = appsOf().filter((a) => program === null || progKey(a) === program);
  const counts = { all: all.length };
  for (const a of all) counts[a.progress.state] = (counts[a.progress.state] || 0) + 1;
  const seg = ["all", "진행 중", "선정", "탈락", "준비"]
    .map((k) => `<button class="seg-btn${appsFilter === k ? " on" : ""}" data-a-filter="${k}" type="button">${k === "all" ? "전체" : k}<small>${counts[k] || 0}</small></button>`)
    .join("");
  const title = program === null ? "지원 현황" : `<span class="crumb" data-a-all role="button" tabindex="0">지원 현황</span> › ${esc(program || "사업명 없음")}`;
  $("activeFilters").innerHTML = `<span class="title">${title}</span><div class="seg-group">${seg}</div>
    <button class="btn sm primary" data-a-new type="button">${icon("plus")}새 지원 건</button>
    <button class="btn sm ghost" data-a-templates type="button" title="사업 유형별 기본 단계 목록">단계 틀</button>
    ${program ? `<button class="btn sm ghost" data-a-refs type="button" title="공고문·RFP·작성 양식">${icon("inbox")}사업 자료 ${programRefs(program).length || ""}</button>` : ""}`;
  document.querySelector(".toolbar-right").hidden = true;
  $("list").hidden = true;
  $("empty").hidden = true;
  const board = $("appsBoard");
  board.hidden = false;
  const items = all
    .filter((a) => appsFilter === "all" || a.progress.state === appsFilter)
    .sort((x, y) => (y.year || 0) - (x.year || 0) || String(y.updatedAt).localeCompare(String(x.updatedAt)));
  $("count").textContent = `${items.length}건`;
  if (!all.length) {
    board.innerHTML = `<div class="apps-empty">${icon("briefcase")}<div><b>아직 지원 건이 없습니다.</b><br>
      한 주제(기술)를 한 사업에 낸 것을 '지원 건' 하나로 기록합니다. 수요조사 → RFP → 사업계획서 → 서류·발표평가 → 선정까지 단계마다 결과와 평가 의견, 관련 문서를 남기면,
      Claude 가 다음 작성 때 어디서 왜 떨어졌는지 참고합니다.<br><small>Claude 에게 "문서 보관함 자료를 보고 지금까지 지원 건 목록을 정리해 줘"라고 해도 됩니다.</small></div>
      <button class="btn primary" data-a-new type="button">${icon("plus")}새 지원 건</button></div>`;
    return;
  }
  if (!items.length) {
    board.innerHTML = `<div class="apps-empty"><div>이 조건의 지원 건이 없습니다.</div></div>`;
    return;
  }
  if (program !== null) {
    board.innerHTML = items.map(appRowHtml).join("");
    return;
  }
  // 사업명별 묶음: 왼쪽 메뉴와 같은 순서 (이름순, 사업명 없는 건은 맨 뒤)
  const groups = new Map(appProgramCounts(items).map(([p]) => [p, []]));
  for (const a of items) groups.get(progKey(a)).push(a);
  board.innerHTML = [...groups]
    .map(([p, list]) => {
      const st = {};
      for (const a of list) st[a.progress.state] = (st[a.progress.state] || 0) + 1;
      const summary = ["선정", "진행 중", "탈락", "준비"].filter((k) => st[k]).map((k) => `<span class="app-state ${APP_STATE_CLASS[k]}">${k} ${st[k]}</span>`).join("");
      const agencies = [...new Set(list.map((a) => a.agency).filter(Boolean))].join(", ");
      const closed = appsCollapsed.has(p);
      return `<section class="app-group${closed ? " closed" : ""}">
        <div class="app-group-head" data-a-group="${esc(p)}" role="button" tabindex="0">
          ${icon("chevron", "chev")}<b>${esc(p || "사업명 없음")}</b>${agencies ? `<small>${esc(agencies)}</small>` : ""}
          <span class="n">${list.length}건</span>${programRefs(p).length ? `<button class="ref-count" data-a-only="${esc(p)}" type="button" title="사업 자료 보기">${icon("inbox")}자료 ${programRefs(p).length}</button>` : ""}<span class="app-group-sum">${summary}</span>
          <button class="link-btn" data-a-only="${esc(p)}" type="button" title="이 사업만 보기">이 사업만</button>
        </div>
        <div class="app-group-body">${closed ? "" : list.map(appRowHtml).join("")}</div>
      </section>`;
    })
    .join("");
}

function leaveAppsView() {
  $("appsBoard").hidden = true;
  document.querySelector(".toolbar-right").hidden = false;
}

// 오른쪽: 지원 건 하나 고치기
// ---- 사업 자료 (공고문·RFP·작성 양식 등 참고 문서) ----
const refKinds = () => (S.applications && S.applications.refKinds) || ["공고문", "RFP", "작성 양식", "평가 기준", "참고 자료"];
const programRefs = (p) => ((S.applications && S.applications.programs && S.applications.programs[p]) || { refs: [] }).refs;
let refKindChoice = "공고문"; // 넣을 때 고른 종류 (다음에도 그대로)

// scope: "p:<사업명>" (사업 전체) | "a:<지원 건 id>" (이 건만)
function refsCardHtml(scope, refs, title, hint) {
  const kinds = refKinds();
  const sorted = [...refs].sort((x, y) => kinds.indexOf(x.kind) - kinds.indexOf(y.kind));
  const rows = sorted
    .map((r) => {
      const d = byRel.get(r.rel);
      const kindSel = kinds.map((k) => `<option${k === r.kind ? " selected" : ""}>${esc(k)}</option>`).join("");
      return `<li class="ref-row${d ? "" : " missing"}">
        <select class="ref-kind" data-r-kind="${esc(r.rel)}" data-r-scope="${esc(scope)}" aria-label="자료 종류">${kindSel}</select>
        <button class="ref-name" data-r-open="${esc(r.rel)}" type="button" title="${esc(r.rel)}\n누르면 파일을 엽니다">${d ? `${refExtIcon(d)}${esc(d.base)}` : esc(r.rel.split("/").pop() + " (없음)")}</button>
        <button class="icon-btn" data-r-unlink="${esc(r.rel)}" data-r-scope="${esc(scope)}" type="button" title="연결 끊기 (파일은 그대로)">${icon("x")}</button>
      </li>`;
    })
    .join("");
  const kindPick = kinds.map((k) => `<option${k === refKindChoice ? " selected" : ""}>${esc(k)}</option>`).join("");
  return `<div class="card ref-card ref-drop" data-r-scope="${esc(scope)}"><h4>${icon("inbox")}${esc(title)}<small>${refs.length ? refs.length + "개" : ""}</small></h4>
    ${rows ? `<ul class="ref-list">${rows}</ul>` : `<p class="hint">${esc(hint)}</p>`}
    <div class="ref-add">
      <select class="select sm" data-r-newkind aria-label="넣을 자료 종류">${kindPick}</select>
      <button class="btn sm" data-r-import="${esc(scope)}" type="button">${icon("plus")}파일 넣기</button>
      <button class="link-btn" data-r-pick="${esc(scope)}" type="button">보관함에서 고르기</button>
    </div>
    <small class="hint drop-note">파일을 이 칸에 끌어다 놓아도 됩니다</small>
  </div>`;
}
const refExtIcon = (d) => `<span class="ref-ext">${esc(String(d.ext || "").replace(".", "").toUpperCase())}</span>`;

// 사업 하나를 고른 화면에서 지원 건을 고르지 않았을 때: 사업 자료 + 지원 건 목록
function renderProgramPanel(p) {
  const list = appsOf().filter((a) => progKey(a) === p);
  const agencies = [...new Set(list.map((a) => a.agency).filter(Boolean))].join(", ");
  $("detail").innerHTML = `
    <div class="d-head"><span class="ficon app">${icon("briefcase")}</span><div><h2>${esc(p)}</h2>
      <div class="d-path">${esc([agencies, `지원 건 ${list.length}개`].filter(Boolean).join(" · "))}</div></div></div>
    <div class="card"><h4>${icon("sparkle")}사업 카드<small>Claude 가 이 사업 문서를 쓸 때 읽는 카드</small></h4><ul class="card-rows">${cardRowHtml("program", p)}${cardRowHtml("guide")}</ul>
      <small class="hint">사업 자료(공고문·평가 기준)를 넣은 뒤 'Claude 로 만들기'를 하면 평가 항목·강조점·우리 지원 교훈을 정리합니다.</small></div>
    ${refsCardHtml("p:" + p, programRefs(p), "사업 자료", "공고문, RFP, 작성 양식, 평가 기준처럼 이 사업에서 받은 자료를 넣어 두세요. 이 사업의 지원 건 모두가 같이 보고, Claude 도 문서를 쓸 때 먼저 읽습니다.")}
    <div class="card"><h4>${icon("layers")}지원 건</h4><ul class="app-links">${list
      .map((a) => `<li><button data-a-goto="${esc(a.id)}" type="button"><b>${esc(appName(a))}</b> <small>${esc(a.progress.state)}${a.progress.stage && a.progress.state !== "선정" ? " · " + esc(a.progress.stage) : ""}</small></button></li>`)
      .join("")}</ul></div>`;
}

function refTarget(scope) {
  return scope.startsWith("a:") ? { id: scope.slice(2) } : { program: scope.slice(2) };
}

async function importRefs(scope, paths) {
  toast("자료를 넣는 중…", 60000);
  const r = await api.appsImportRefs(refTarget(scope), refKindChoice, paths || null);
  if (!r || r.cancelled) return toast("넣기를 취소했습니다.");
  if (r.error) return toast(r.error, 6000);
  toast(r.linked ? `${r.linked}개를 '${refKindChoice}'(으)로 넣었습니다.\n저장 위치: ${r.folder}` : "넣은 파일이 없습니다." + (r.skipped && r.skipped.length ? ` (${r.skipped.map((x) => x.name + ": " + x.reason).join(", ")})` : ""), 5000);
  renderAppDetail();
}

// 사업 자료 칸에 파일을 끌어다 놓으면 그 사업(지원 건) 자료로 넣는다. app.js 의 drop 처리에서 부른다.
function refDrop(e, paths) {
  const zone = e.target && e.target.closest && e.target.closest(".ref-drop");
  if (!zone || !isAppsView()) return false;
  if (paths.length) importRefs(zone.dataset.rScope, paths);
  return true;
}

$("detail").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !isAppsView()) return;
  if (b.dataset.rImport) return importRefs(b.dataset.rImport);
  if (b.dataset.rOpen) {
    if (!byRel.get(b.dataset.rOpen)) return toast("파일을 찾을 수 없습니다. 옮겨졌거나 지워졌을 수 있습니다.");
    return api.openFile(b.dataset.rOpen).then((err) => err && toast(err, 5000));
  }
  if (b.dataset.rUnlink) return appsOp({ type: "ref_unlink", ...refTarget(b.dataset.rScope), rel: b.dataset.rUnlink }).then(renderAppDetail);
  if (b.dataset.rPick) {
    const scope = b.dataset.rPick;
    const refs = scope.startsWith("a:") ? (appsOf().find((a) => a.id === scope.slice(2)) || { refs: [] }).refs : programRefs(scope.slice(2));
    return openDocPicker(b, new Set(refs.map((r) => r.rel)), (d) => appsOp({ type: "ref_link", ...refTarget(scope), rel: d.rel, kind: refKindChoice }, `'${d.base}'을(를) ${refKindChoice}(으)로 연결했습니다.`));
  }
});
$("detail").addEventListener("change", (e) => {
  const t = e.target;
  if (!isAppsView()) return;
  if (t.hasAttribute("data-r-newkind")) {
    refKindChoice = t.value;
    for (const x of document.querySelectorAll("[data-r-newkind]")) x.value = t.value;
  }
  if (t.dataset.rKind) appsOp({ type: "ref_link", ...refTarget(t.dataset.rScope), rel: t.dataset.rKind, kind: t.value });
});
$("detail").addEventListener("dragover", (e) => {
  const zone = e.target.closest && e.target.closest(".ref-drop");
  for (const z of document.querySelectorAll(".ref-drop.over")) if (z !== zone) z.classList.remove("over");
  if (zone) zone.classList.add("over");
});
$("detail").addEventListener("dragleave", (e) => {
  if (e.target.classList && e.target.classList.contains("ref-drop") && !e.target.contains(e.relatedTarget)) e.target.classList.remove("over");
});

function renderAppDetail() {
  const box = $("detail");
  const a = appsOf().find((x) => x.id === selectedApp);
  if (!a && appsProgram()) return renderProgramPanel(appsProgram());
  if (!a) {
    box.innerHTML = `<div class="detail-empty">${icon("briefcase")}<div>지원 건을 고르면 여기서 단계별 결과와 평가 의견, 관련 문서를 기록합니다.</div></div>`;
    return;
  }
  fillProgramList();
  const field = (k, label, ph = "", type = "text") => `<label class="af"><span>${label}</span><input type="${type}" data-a-f="${k}" value="${esc(a[k] == null ? "" : a[k])}" placeholder="${esc(ph)}"${k === "program" ? ' list="programList"' : ""}></label>`;
  const statusOpts = (cur) => (S.applications.statuses || ["", "진행", "통과", "탈락", "제외"]).map((s) => `<option value="${s}"${s === cur ? " selected" : ""}>${STATUS_LABEL[s] || s}</option>`).join("");
  const stages = a.stages
    .map((s, i) => {
      const docs = s.docs
        .map((rel) => {
          const d = byRel.get(rel);
          return `<span class="doc-chip${d ? "" : " missing"}" title="${esc(rel)}"><button data-a-open-doc="${esc(rel)}" type="button">${esc(d ? d.base : rel.split("/").pop() + " (없음)")}</button><button data-a-unlink="${i}" data-rel="${esc(rel)}" type="button" aria-label="연결 끊기">${icon("x")}</button></span>`;
        })
        .join("");
      return `<li class="stage ${STAGE_CLASS[s.status] || ""}">
        <div class="stage-head">
          <input class="stage-name" data-a-sname="${i}" value="${esc(s.name)}" aria-label="단계 이름">
          <select class="select" data-a-sstatus="${i}" aria-label="결과">${statusOpts(s.status)}</select>
          <input type="date" data-a-sdate="${i}" value="${esc(s.date)}" aria-label="날짜">
          <span class="stage-tools">
            <button class="icon-btn" data-a-sup="${i}" type="button" title="위로"${i ? "" : " disabled"}>↑</button>
            <button class="icon-btn" data-a-sdown="${i}" type="button" title="아래로"${i < a.stages.length - 1 ? "" : " disabled"}>↓</button>
            <button class="icon-btn danger" data-a-sdel="${i}" type="button" title="이 단계 빼기">${icon("x")}</button>
          </span>
        </div>
        <textarea data-a-snote="${i}" rows="${s.note ? 3 : 1}" placeholder="평가 의견 · 탈락 사유 · 메모">${esc(s.note)}</textarea>
        <div class="stage-docs">${docs}<button class="link-btn" data-a-slink="${i}" type="button">+ 문서 연결</button></div>
      </li>`;
    })
    .join("");
  box.innerHTML = `
    <div class="d-head"><span class="ficon app">${icon("briefcase")}</span><div><h2>${esc(appName(a))}</h2>
      <div class="d-path"><span class="app-state ${APP_STATE_CLASS[a.progress.state] || ""}">${esc(a.progress.state)}${a.progress.stage && a.progress.state !== "선정" ? " · " + esc(a.progress.stage) : ""}</span></div></div></div>
    <div class="card"><h4>${icon("info")}지원 건</h4>
      <div class="af-grid">${field("title", "과제명")}${field("topic", "주제(기술)", "예: 그래핀 스텔스 패널")}${field("program", "사업명", "예: 소재부품기술개발")}${field("agency", "전문기관", "예: KEIT")}${field("year", "연도", "", "number")}</div>
      <label class="af"><span>메모</span><textarea data-a-f="memo" rows="2" placeholder="공동기관, 예산 규모 등">${esc(a.memo || "")}</textarea></label>
    </div>
    ${writeCardsHtml(a)}
    ${progKey(a) ? refsCardHtml("p:" + progKey(a), programRefs(progKey(a)), `사업 자료 · ${progKey(a)}`, "이 사업의 공고문·RFP·작성 양식을 넣어 두면 같은 사업의 지원 건 모두가 같이 봅니다.") : ""}
    ${refsCardHtml("a:" + a.id, a.refs || [], "이 과제만의 자료", "이 지원 건에만 해당하는 자료 (예: 이 과제의 RFP, 수요조사 안내)")}
    <div class="card"><h4>${icon("layers")}단계<small>${a.template ? esc(a.template) : ""}</small></h4>
      <ol class="stage-list">${stages}</ol>
      <button class="btn sm ghost" data-a-sadd type="button">${icon("plus")}단계 추가</button>
    </div>
    <div class="app-foot"><button class="btn sm ghost danger" data-a-del type="button">${icon("trash")}이 지원 건 지우기</button></div>
`;
}

// 문서 고르기: 이름·폴더 일부(띄어쓰기로 여러 단어)를 치면 맞는 문서가 바로 아래에 뜬다. 누르거나 Enter(첫 번째)로 연결.
// already: 이미 연결된 문서(목록에서 뺀다), onPick(d): 고른 문서로 할 일
function openDocPicker(btn, already, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "doc-picker";
  wrap.innerHTML = `<input class="doc-pick" placeholder="문서 이름 일부 (예: 탄소 수요조사)" autocomplete="off"><ul class="doc-pick-list"></ul><small class="hint">눌러서 고르거나 Enter 로 첫 번째 문서를 연결합니다 · Esc 로 닫기</small>`;
  btn.replaceWith(wrap);
  const input = wrap.querySelector("input");
  const list = wrap.querySelector("ul");
  let matches = [];
  const norm = (t) => t.toLowerCase().replace(/\s+/g, "");
  const show = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean).map(norm);
    matches = (words.length ? S.docs.filter((d) => !already.has(d.rel) && words.every((w) => norm(d.rel).includes(w))) : [])
      .sort((x, y) => y.mtimeMs - x.mtimeMs)
      .slice(0, 8);
    list.innerHTML = matches.length
      ? matches.map((d, i) => `<li><button type="button" data-pick="${i}"><b>${esc(d.base)}</b><small>${esc(d.dir || "최상위 폴더")}</small></button></li>`).join("")
      : words.length
        ? '<li class="none">맞는 문서가 없습니다</li>'
        : "";
  };
  const pick = async (d) => {
    if (!d) return toast("맞는 문서가 없습니다. 이름 일부를 다르게 입력해 보세요.");
    input.blur(); // 입력 중이면 화면을 다시 그리지 않으므로 먼저 빠져나온다
    await onPick(d);
    renderAppDetail();
  };
  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pick(matches[0]);
    } else if (e.key === "Escape") renderAppDetail();
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) pick(matches[parseInt(b.dataset.pick, 10)]);
  });
  input.focus();
}

// 문서 화면에 붙는 카드: 이 문서가 연결된 지원 건 + 지원 건에 연결하기
function appsCardHtml(d) {
  const linked = [];
  for (const a of appsOf()) for (const s of a.stages) if (s.docs.includes(d.rel)) linked.push({ a, s });
  const asRef = [];
  for (const [p, v] of Object.entries((S.applications && S.applications.programs) || {})) for (const r of v.refs) if (r.rel === d.rel) asRef.push({ label: p, kind: r.kind, program: p });
  for (const a of appsOf()) for (const r of a.refs || []) if (r.rel === d.rel) asRef.push({ label: appName(a), kind: r.kind, id: a.id });
  if (!linked.length && !asRef.length && !appsOf().length) return "";
  const rows = linked
    .map(({ a, s }) => `<li><button data-a-goto="${esc(a.id)}" type="button"><b>${esc(appName(a))}</b> <small>${esc([a.program, a.year].filter(Boolean).join(" · "))} › ${esc(s.name)}${s.status ? " · " + esc(s.status) : ""}</small></button></li>`)
    .join("") +
    asRef
      .map((x) => `<li><button ${x.id ? `data-a-goto="${esc(x.id)}"` : `data-a-goto-program="${esc(x.program)}"`} type="button"><b>${esc(x.label)}</b> <small>사업 자료 · ${esc(x.kind)}</small></button></li>`)
      .join("");
  const opts = appsOf()
    .flatMap((a) => a.stages.filter((s) => !s.docs.includes(d.rel)).map((s) => `<option value="${esc(a.id)}|${esc(s.name)}">${esc(appName(a))} › ${esc(s.name)}</option>`))
    .join("");
  return `<div class="card"><h4>${icon("briefcase")}지원 건</h4>
    ${rows ? `<ul class="app-links">${rows}</ul>` : '<p class="hint">아직 어떤 지원 건에도 연결되지 않았습니다.</p>'}
    ${opts ? `<select class="select" id="appLinkSelect"><option value="">지원 건 단계에 연결…</option>${opts}</select>` : ""}
  </div>`;
}

function openApp(id) {
  selectedApp = id;
  const a = appsOf().find((x) => x.id === id);
  // 지금 보고 있는 사업의 지원 건이면 그 화면에 머문다
  if (!(a && appsProgram() !== null && progKey(a) === appsProgram())) filter.view = "apps";
  renderSide();
  renderList();
  renderDetail();
}

// ---- 이벤트 ----

$("activeFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button, [data-a-all]");
  if (!b || !isAppsView()) return;
  if (b.dataset.aFilter) {
    appsFilter = b.dataset.aFilter;
    renderAppsView();
  }
  if (b.hasAttribute("data-a-new")) openNewApp();
  if (b.hasAttribute("data-a-all")) showProgram(null);
  if (b.hasAttribute("data-a-refs")) {
    selectedApp = "";
    for (const r of $("appsBoard").querySelectorAll(".app-row.sel")) r.classList.remove("sel");
    renderAppDetail();
  }
  if (b.hasAttribute("data-a-templates")) openTemplates();
});

function showProgram(p) {
  filter.view = p === null ? "apps" : "apps:" + p;
  renderSide();
  renderList();
}

function toggleAppGroup(p) {
  appsCollapsed.has(p) ? appsCollapsed.delete(p) : appsCollapsed.add(p);
  setPref("appsCollapsed", [...appsCollapsed]);
  renderAppsView();
}

$("appsBoard").addEventListener("click", (e) => {
  if (e.target.closest("[data-a-new]")) return openNewApp();
  const only = e.target.closest("[data-a-only]");
  if (only) {
    selectedApp = "";
    showProgram(only.dataset.aOnly);
    return renderDetail();
  }
  const head = e.target.closest("[data-a-group]");
  if (head) return toggleAppGroup(head.dataset.aGroup);
  const row = e.target.closest("[data-a-id]");
  if (!row) return;
  selectedApp = row.dataset.aId;
  for (const r of $("appsBoard").querySelectorAll(".app-row")) r.classList.toggle("sel", r === row);
  renderAppDetail();
});

const appNow = () => appsOf().find((x) => x.id === selectedApp);
const stagesCopy = (a) => a.stages.map((s) => ({ ...s, docs: [...s.docs] }));

$("detail").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.aGoto) return openApp(b.dataset.aGoto);
  if (b.dataset.aGotoProgram !== undefined) {
    selectedApp = "";
    showProgram(b.dataset.aGotoProgram);
    return renderDetail();
  }
  if (!isAppsView()) return;
  const a = appNow();
  if (!a) return;
  if (b.dataset.aOpenDoc) {
    filter.view = "all";
    leaveAppsView();
    return goto(b.dataset.aOpenDoc);
  }
  const st = stagesCopy(a);
  const idx = (k) => parseInt(b.dataset[k], 10);
  if (b.dataset.aSup !== undefined || b.dataset.aSdown !== undefined) {
    const i = b.dataset.aSup !== undefined ? idx("aSup") : idx("aSdown");
    const j = b.dataset.aSup !== undefined ? i - 1 : i + 1;
    [st[i], st[j]] = [st[j], st[i]];
    return appsOp({ type: "stages", id: a.id, stages: st });
  }
  if (b.dataset.aSdel !== undefined) {
    const s = st[idx("aSdel")];
    if ((s.note || s.docs.length || s.status) && !confirm(`'${s.name}' 단계를 뺄까요? 이 단계의 결과·의견·연결 문서도 함께 지워집니다.`)) return;
    st.splice(idx("aSdel"), 1);
    return appsOp({ type: "stages", id: a.id, stages: st });
  }
  if (b.hasAttribute("data-a-sadd")) {
    let n = 1;
    while (st.some((s) => s.name === `새 단계${n > 1 ? " " + n : ""}`)) n++;
    st.push({ name: `새 단계${n > 1 ? " " + n : ""}` });
    return appsOp({ type: "stages", id: a.id, stages: st });
  }
  if (b.dataset.aUnlink !== undefined) return appsOp({ type: "unlink", id: a.id, stage: a.stages[idx("aUnlink")].name, rel: b.dataset.rel });
  if (b.dataset.aSlink !== undefined) {
    const s = a.stages[idx("aSlink")];
    return openDocPicker(b, new Set(s.docs), (d) => appsOp({ type: "link", id: a.id, stage: s.name, rel: d.rel }, `'${d.base}'을(를) 연결했습니다.`));
  }
  if (b.hasAttribute("data-a-del")) {
    if (!confirm(`'${appName(a)}' 지원 건을 지울까요? (문서 파일은 지워지지 않습니다)`)) return;
    await appsOp({ type: "delete", id: a.id }, "지원 건을 지웠습니다.");
    selectedApp = "";
    renderAppDetail();
  }
});

$("detail").addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "appLinkSelect" && t.value) {
    const [id, stage] = t.value.split("|");
    const d = byRel.get(selected);
    if (d) await appsOp({ type: "link", id, stage, rel: d.rel }, "지원 건에 연결했습니다.");
    return;
  }
  if (!isAppsView()) return;
  const a = appNow();
  if (!a) return;
  if (t.dataset.aF) return appsOp({ type: "update", id: a.id, fields: { [t.dataset.aF]: t.value } });
  if (t.dataset.aSname !== undefined) {
    const st = stagesCopy(a);
    st[parseInt(t.dataset.aSname, 10)].name = t.value;
    const r = await appsOp({ type: "stages", id: a.id, stages: st });
    if (!r) t.value = a.stages[parseInt(t.dataset.aSname, 10)].name;
    return;
  }
  const i = [t.dataset.aSstatus, t.dataset.aSdate, t.dataset.aSnote].find((v) => v !== undefined);
  if (i === undefined) return;
  const patch = t.dataset.aSstatus !== undefined ? { status: t.value } : t.dataset.aSdate !== undefined ? { date: t.value } : { note: t.value };
  await appsOp({ type: "stage", id: a.id, stage: a.stages[parseInt(i, 10)].name, patch });
});

$("appsBoard").addEventListener("keydown", (e) => {
  const head = e.target.closest("[data-a-group]");
  if (head && (e.key === "Enter" || e.key === " ") && e.target === head) {
    e.preventDefault();
    toggleAppGroup(head.dataset.aGroup);
  }
});

// ---- 새 지원 건 ----
function openNewApp() {
  $("anTemplate").innerHTML = templatesOf().map((t) => `<option>${esc(t.name)}</option>`).join("");
  $("anYear").value = new Date().getFullYear();
  for (const id of ["anTitle", "anTopic", "anProgram", "anAgency"]) $(id).value = "";
  fillProgramList();
  // 사업명별 화면에서 만들면 그 사업명·전문기관을 미리 넣는다
  const p = appsProgram();
  if (p) {
    $("anProgram").value = p;
    $("anAgency").value = agencyOf(p);
  }
  updateNewAppStages();
  $("appNewDlg").showModal();
  $("anTitle").focus();
}
// 사업명은 묶음 기준이므로 이미 쓴 이름을 골라 쓰게 한다 (띄어쓰기 하나만 달라도 다른 묶음이 된다)
function fillProgramList() {
  $("programList").innerHTML = appProgramCounts(appsOf()).filter(([p]) => p).map(([p]) => `<option value="${esc(p)}">`).join("");
}
const agencyOf = (p) => ((appsOf().find((a) => progKey(a) === p && a.agency) || {}).agency || "");
$("anProgram").addEventListener("change", () => {
  if (!$("anAgency").value) $("anAgency").value = agencyOf($("anProgram").value.replace(/\s+/g, " ").trim());
});

function updateNewAppStages() {
  const t = templatesOf().find((x) => x.name === $("anTemplate").value);
  $("anStages").textContent = t ? t.stages.join(" → ") : "";
}
$("anTemplate").addEventListener("change", updateNewAppStages);
$("anCancel").onclick = () => $("appNewDlg").close();
$("anGo").onclick = async () => {
  const fields = { title: $("anTitle").value, topic: $("anTopic").value, program: $("anProgram").value, agency: $("anAgency").value, year: $("anYear").value };
  const r = await appsOp({ type: "create", fields, template: $("anTemplate").value });
  if (!r) return;
  $("appNewDlg").close();
  appsFilter = "all";
  openApp(r.id);
};

// ---- 단계 틀 ----
function openTemplates() {
  $("tplList").innerHTML = templatesOf().map(tplBlock).join("");
  $("appTplDlg").showModal();
}
const tplBlock = (t) => `<div class="tpl"><input class="tpl-name" value="${esc(t.name)}" placeholder="틀 이름 (예: 국방 핵심기술)">
  <textarea class="tpl-stages" rows="${Math.max(3, t.stages.length)}" placeholder="한 줄에 단계 하나">${esc(t.stages.join("\n"))}</textarea>
  <button class="btn sm ghost danger" data-tpl-del type="button">이 틀 빼기</button></div>`;
$("tplList").addEventListener("click", (e) => {
  if (e.target.closest("[data-tpl-del]")) e.target.closest(".tpl").remove();
});
$("tplAdd").onclick = () => $("tplList").insertAdjacentHTML("beforeend", tplBlock({ name: "", stages: [] }));
$("tplCancel").onclick = () => $("appTplDlg").close();
$("tplSave").onclick = async () => {
  const templates = [...document.querySelectorAll("#tplList .tpl")].map((el) => ({
    name: el.querySelector(".tpl-name").value.trim(),
    stages: el.querySelector(".tpl-stages").value.split("\n").map((s) => s.trim()).filter(Boolean),
  }));
  const r = await appsOp({ type: "templates", templates }, "단계 틀을 저장했습니다. 새로 만드는 지원 건부터 적용됩니다.");
  if (r) $("appTplDlg").close();
};

// ---------- 작성 카드: 주제 카드·사업 카드·작성 가이드 ----------
const CARD_LABEL = { topic: "주제 카드", program: "사업 카드", guide: "작성 가이드" };
const cardKey = (n) => String(n || "").replace(/\s+/g, " ").trim();
const cardsOf = () => (S.applications && S.applications.cards) || [];
const cardFind = (kind, name) => cardsOf().find((c) => c.kind === kind && (kind === "guide" || c.name === cardKey(name)));
// Claude 에게 보낼 요청: 어떤 카드인지, 어디에 무엇을 정리하는지까지 적어야 되묻지 않는다
const CARD_ASK = {
  topic: (n) => `문서 보관함의 '${n}' 주제 카드를 만들어 줘(이미 있으면 새로 고쳐 줘). get_card(kind: topic, name: "${n}")로 양식을 받아 그 구조대로, 이 주제의 수요조사서·계획서·보고서·IR 문서와 지원 이력을 읽고 핵심 수치·차별점·실적·검증된 문장을 출처와 함께 정리해 save_card로 저장해 줘.`,
  program: (n) => `문서 보관함의 '${n}' 사업 카드를 만들어 줘(이미 있으면 새로 고쳐 줘). get_card(kind: program, name: "${n}")로 양식을 받아 그 구조대로, get_program의 사업 자료(공고문·RFP·평가 기준)와 이 사업 지원 건의 결과·탈락 사유를 읽고 평가 항목·강조점·양식 특징·교훈을 출처와 함께 정리해 save_card로 저장해 줘.`,
  guide: () => `문서 보관함의 작성 가이드를 만들어 줘(이미 있으면 새로 고쳐 줘). get_card(kind: guide)로 양식을 받아 그 구조대로, 우리 회사가 낸 사업계획서·수요조사서(선정된 것 먼저)와 작성 안내 자료를 읽고 요약·목표·필요성·국내외 현황·개발 내용·수행 역량·추진 체계·사업화·기대 효과·연구비 같은 항목 종류마다 쓰는 법과 예시를 정리해 save_card로 저장해 줘. 탈락 사유는 '탈락 사유에서 배운 점'에 넣어 줘.`,
};
const cardPrompt = (kind, name) => CARD_ASK[kind](cardKey(name));

// 카드 한 줄: 이름·있는지·고치기·Claude 에게 보낼 문장 복사
function cardRowHtml(kind, name) {
  const c = cardFind(kind, name);
  const attrs = `data-c-kind="${kind}" data-c-name="${esc(cardKey(name))}"`;
  const state = c ? `<span class="state-on">있음</span> · ${esc(new Date(c.updated).toLocaleDateString())}` : '<span class="muted">없음</span>';
  return `<li class="card-row">
    <div class="card-row-main"><b>${CARD_LABEL[kind]}</b>${kind === "guide" ? "" : ` <span>${esc(cardKey(name))}</span>`}<small>${state}</small></div>
    <div class="card-row-act">
      <button class="link-btn" data-c-edit ${attrs} type="button">${c ? "보기·고치기" : "직접 쓰기"}</button>
      <button class="link-btn" data-c-copy="${esc(cardPrompt(kind, name))}" type="button" title="${esc(cardPrompt(kind, name))}">${c ? "Claude 로 새로 고치기" : "Claude 로 만들기"}</button>
    </div>
  </li>`;
}

// 아직 끝나지 않은 단계 가운데 처음으로 문서를 내는 단계 → 쓸 문서 이름
function nextDocOf(a) {
  const DOCS = [[/수요조사/, "수요조사서"], [/사업계획서|계획서/, "사업계획서"], [/신청서/, "신청서"], [/발표/, "발표자료"]];
  for (const s of a.stages) {
    if (s.status === "통과" || s.status === "제외" || s.status === "탈락") continue;
    const hit = DOCS.find(([re]) => re.test(s.name));
    if (hit) return hit[1];
  }
  return "제출 문서";
}

// 지원 건 화면: 이 건의 문서를 쓸 때 읽는 카드 + 문서 쓰기 요청 문장
function writeCardsHtml(a) {
  const topic = cardKey(a.topic), program = progKey(a);
  const rows = [topic ? cardRowHtml("topic", topic) : '<li class="card-row muted">주제를 적으면 주제 카드를 만들 수 있습니다</li>',
    program ? cardRowHtml("program", program) : '<li class="card-row muted">사업명을 적으면 사업 카드를 만들 수 있습니다</li>',
    cardRowHtml("guide")].join("");
  const ask = `문서 보관함의 '${appName(a)}' 지원 건${program ? `(${program})` : ""}으로 ${nextDocOf(a)}를 써 줘`;
  return `<div class="card"><h4>${icon("sparkle")}문서 쓰기<small>Claude 가 읽는 카드</small></h4>
    <ul class="card-rows">${rows}</ul>
    <div class="cmd-row"><code>${esc(ask)}</code><button class="icon-btn" data-c-copy="${esc(ask)}" type="button" title="복사" aria-label="요청 문장 복사">${icon("copy")}</button></div>
    <small class="hint">Claude 데스크톱 일반 채팅에 붙여 넣으면 회사 지식 카드·위 카드·사업 자료·지난 탈락 사유를 읽고, 칸별 요약을 먼저 보여 준 뒤 양식을 새 파일로 채웁니다. '+' 메뉴의 <b>사업 문서 쓰기</b>로 시작해도 됩니다.</small>
  </div>`;
}

// 설정 > Claude 연결: 만들어 둔 카드 목록
function renderCardsList() {
  const box = $("cardsList");
  if (!box) return;
  const list = cardsOf().filter((c) => c.kind !== "guide");
  const topics = new Set(appsOf().map((a) => cardKey(a.topic)).filter(Boolean));
  const programs = new Set(appsOf().map(progKey).filter(Boolean));
  // 지원 건에는 있는데 카드가 없는 주제·사업도 보여 준다
  const rows = [
    cardRowHtml("guide"),
    ...[...new Set([...list.filter((c) => c.kind === "topic").map((c) => c.name), ...topics])].sort((x, y) => x.localeCompare(y, "ko")).map((n) => cardRowHtml("topic", n)),
    ...[...new Set([...list.filter((c) => c.kind === "program").map((c) => c.name), ...programs])].sort((x, y) => x.localeCompare(y, "ko")).map((n) => cardRowHtml("program", n)),
  ];
  box.innerHTML = `<ul class="card-rows">${rows.join("")}</ul>
    <small class="hint">'Claude 로 만들기'를 누르면 요청 문장이 복사됩니다. Claude 데스크톱 일반 채팅에 붙여 넣으세요. 카드는 <code>Claude 지식</code> 폴더에 저장되고, 맨 아래 <b>사용자 메모</b>는 Claude 가 고치지 않습니다. 주제·사업은 지원 현황의 주제·사업명에서 가져옵니다.</small>`;
}

let cardEditing = null;
async function openCardEditor(kind, name) {
  const c = await api.cardGet(kind, name);
  if (c.error) return toast(c.error, 5000);
  cardEditing = { kind, name: c.name };
  $("cardDlgTitle").textContent = kind === "guide" ? "작성 가이드" : `${CARD_LABEL[kind]} · ${c.name}`;
  $("cardDlgSub").textContent = c.exists
    ? `${c.rel} · 마지막으로 고친 때 ${new Date(c.updated).toLocaleString()} · 저장하면 이전 내용은 기록으로 남습니다`
    : "아직 없어서 빈 양식을 보여 줍니다. 직접 채워 저장하거나, 닫고 'Claude 로 만들기'를 쓰세요.";
  $("cardText").value = c.exists ? c.content : c.template;
  $("cardDlg").showModal();
  $("cardText").setSelectionRange(0, 0);
  $("cardText").focus();
  $("cardText").scrollTop = 0;
}
$("cardDlgCancel").onclick = () => $("cardDlg").close();
$("cardDlgSave").onclick = async () => {
  if (!cardEditing) return;
  const r = await api.cardSave(cardEditing.kind, cardEditing.name, $("cardText").value);
  if (r.error) return toast(r.error, 6000);
  $("cardDlg").close();
  toast(r.backup ? "저장했습니다. 이전 내용은 기록으로 남겼습니다." : "저장했습니다.");
};
$("cardDlgOpen").onclick = async () => {
  if (!cardEditing) return;
  const r = await api.cardOpen(cardEditing.kind, cardEditing.name);
  if (r && r.error) toast(r.error);
};

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-c-edit], [data-c-copy]");
  if (!b) return;
  if (b.hasAttribute("data-c-edit")) return openCardEditor(b.dataset.cKind, b.dataset.cName);
  try {
    await navigator.clipboard.writeText(b.dataset.cCopy);
    toast("복사했습니다. Claude 데스크톱 일반 채팅에 붙여 넣으세요.");
  } catch {
    toast("복사하지 못했습니다. 글자를 직접 선택해 복사해 주세요.");
  }
});
