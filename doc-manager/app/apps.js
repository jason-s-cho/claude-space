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

// 가운데: 지원 건 목록 (단계 흐름 막대)
function renderAppsView() {
  const all = appsOf();
  const counts = { all: all.length };
  for (const a of all) counts[a.progress.state] = (counts[a.progress.state] || 0) + 1;
  const seg = ["all", "진행 중", "선정", "탈락", "준비"]
    .map((k) => `<button class="seg-btn${appsFilter === k ? " on" : ""}" data-a-filter="${k}" type="button">${k === "all" ? "전체" : k}<small>${counts[k] || 0}</small></button>`)
    .join("");
  $("activeFilters").innerHTML = `<span class="title">지원 현황</span><div class="seg-group">${seg}</div>
    <button class="btn sm primary" data-a-new type="button">${icon("plus")}새 지원 건</button>
    <button class="btn sm ghost" data-a-templates type="button" title="사업 유형별 기본 단계 목록">단계 틀</button>`;
  document.querySelector(".toolbar-right").hidden = true;
  $("list").hidden = true;
  $("empty").hidden = true;
  const board = $("appsBoard");
  board.hidden = false;
  const items = all
    .filter((a) => appsFilter === "all" || a.progress.state === appsFilter)
    .sort((x, y) => (y.year || 0) - (x.year || 0) || String(y.updatedAt).localeCompare(String(x.updatedAt)));
  if (!all.length) {
    board.innerHTML = `<div class="apps-empty">${icon("briefcase")}<div><b>아직 지원 건이 없습니다.</b><br>
      한 주제(기술)를 한 사업에 낸 것을 '지원 건' 하나로 기록합니다. 수요조사 → RFP → 사업계획서 → 서류·발표평가 → 선정까지 단계마다 결과와 평가 의견, 관련 문서를 남기면,
      Claude 가 다음 작성 때 어디서 왜 떨어졌는지 참고합니다.<br><small>Claude 에게 "문서 보관함 자료를 보고 지금까지 지원 건 목록을 정리해 줘"라고 해도 됩니다.</small></div>
      <button class="btn primary" data-a-new type="button">${icon("plus")}새 지원 건</button></div>`;
    return;
  }
  board.innerHTML = items.length
    ? items
        .map((a) => {
          const p = a.progress;
          const pipe = a.stages
            .map((s) => `<li class="${STAGE_CLASS[s.status] || ""}" title="${esc(`${s.name}: ${STATUS_LABEL[s.status] || s.status}${s.date ? " · " + s.date : ""}${s.note ? "\n" + s.note : ""}`)}"><span>${esc(s.name)}</span></li>`)
            .join("");
          return `<div class="app-row${a.id === selectedApp ? " sel" : ""}" data-a-id="${esc(a.id)}">
            <div class="app-main"><div class="app-title">${esc(appName(a))}</div>
              <div class="app-meta">${[a.topic && a.title ? a.topic : "", a.program, a.agency, a.year].filter(Boolean).map(esc).join(" · ")}</div></div>
            <span class="app-state ${APP_STATE_CLASS[p.state] || ""}">${esc(p.state)}${p.stage && p.state !== "선정" ? ` · ${esc(p.stage)}` : ""}</span>
            <ol class="pipe">${pipe}</ol>
          </div>`;
        })
        .join("")
    : `<div class="apps-empty"><div>이 조건의 지원 건이 없습니다.</div></div>`;
  $("count").textContent = `${items.length}건`;
}

function leaveAppsView() {
  $("appsBoard").hidden = true;
  document.querySelector(".toolbar-right").hidden = false;
}

// 오른쪽: 지원 건 하나 고치기
function renderAppDetail() {
  const box = $("detail");
  const a = appsOf().find((x) => x.id === selectedApp);
  if (!a) {
    box.innerHTML = `<div class="detail-empty">${icon("briefcase")}<div>지원 건을 고르면 여기서 단계별 결과와 평가 의견, 관련 문서를 기록합니다.</div></div>`;
    return;
  }
  const field = (k, label, ph = "", type = "text") => `<label class="af"><span>${label}</span><input type="${type}" data-a-f="${k}" value="${esc(a[k] == null ? "" : a[k])}" placeholder="${esc(ph)}"></label>`;
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
    <div class="card"><h4>${icon("layers")}단계<small>${a.template ? esc(a.template) : ""}</small></h4>
      <ol class="stage-list">${stages}</ol>
      <button class="btn sm ghost" data-a-sadd type="button">${icon("plus")}단계 추가</button>
    </div>
    <div class="app-foot"><button class="btn sm ghost danger" data-a-del type="button">${icon("trash")}이 지원 건 지우기</button></div>
    <datalist id="appDocList">${S.docs.map((d) => `<option value="${esc(d.rel)}"></option>`).join("")}</datalist>`;
}

// 문서 화면에 붙는 카드: 이 문서가 연결된 지원 건 + 지원 건에 연결하기
function appsCardHtml(d) {
  const linked = [];
  for (const a of appsOf()) for (const s of a.stages) if (s.docs.includes(d.rel)) linked.push({ a, s });
  if (!linked.length && !appsOf().length) return "";
  const rows = linked
    .map(({ a, s }) => `<li><button data-a-goto="${esc(a.id)}" type="button"><b>${esc(appName(a))}</b> <small>${esc([a.program, a.year].filter(Boolean).join(" · "))} › ${esc(s.name)}${s.status ? " · " + esc(s.status) : ""}</small></button></li>`)
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
  filter.view = "apps";
  renderSide();
  renderList();
  renderDetail();
}

// ---- 이벤트 ----

$("activeFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || filter.view !== "apps") return;
  if (b.dataset.aFilter) {
    appsFilter = b.dataset.aFilter;
    renderAppsView();
  }
  if (b.hasAttribute("data-a-new")) openNewApp();
  if (b.hasAttribute("data-a-templates")) openTemplates();
});

$("appsBoard").addEventListener("click", (e) => {
  if (e.target.closest("[data-a-new]")) return openNewApp();
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
  if (filter.view !== "apps") return;
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
    // 그 자리에 문서 고르는 칸을 연다 (경로 일부를 치면 목록에서 고를 수 있다)
    const i = idx("aSlink");
    const input = document.createElement("input");
    input.className = "doc-pick";
    input.setAttribute("list", "appDocList");
    input.placeholder = "문서 이름 일부를 입력해 고르세요";
    b.replaceWith(input);
    input.focus();
    input.addEventListener("change", async () => {
      const rel = input.value.trim();
      if (!byRel.has(rel)) return toast("목록에서 문서를 골라 주세요.");
      await appsOp({ type: "link", id: a.id, stage: a.stages[i].name, rel });
    });
    return;
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
  if (filter.view !== "apps") return;
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

// ---- 새 지원 건 ----
function openNewApp() {
  $("anTemplate").innerHTML = templatesOf().map((t) => `<option>${esc(t.name)}</option>`).join("");
  $("anYear").value = new Date().getFullYear();
  for (const id of ["anTitle", "anTopic", "anProgram", "anAgency"]) $(id).value = "";
  updateNewAppStages();
  $("appNewDlg").showModal();
  $("anTitle").focus();
}
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
