// ---------- 지식재산 대장: 특허·실용신안·상표·디자인 ----------
// apps.js 다음에 읽는다 (S, $, esc, icon, toast, byRel, goto, filter, renderSide, renderList, renderDetail, openDocPicker 를 같이 쓴다).

let ipSelected = "";
let ipFilter = "all"; // all | 특허 | 실용신안 | 상표 | 디자인
const IP_STATUS_CLASS = { 출원: "s-doing", 공개: "s-doing", 등록: "s-pass", 거절: "s-fail", 포기: "s-ready", 소멸: "s-ready" };
const ipOf = () => (S.ip && S.ip.items) || [];
const ipSuggestionsOf = () => (S.ip && S.ip.suggestions) || [];
const ipName = (it) => it.title || it.appNo || it.regNo || "(이름 없음)";

async function ipOp(op, okMsg) {
  const r = await api.ipOp(op);
  if (r.error) {
    toast(r.error, 6000);
    return null;
  }
  if (okMsg) toast(okMsg);
  return r;
}

function ipVisible() {
  return ipOf()
    .filter((it) => ipFilter === "all" || it.right === ipFilter)
    .sort((a, b) => String(b.appDate || b.regDate || b.createdAt).localeCompare(String(a.appDate || a.regDate || a.createdAt)));
}

// 가운데: 대장 목록
function renderIpView() {
  const all = ipOf();
  const counts = { all: all.length };
  for (const it of all) counts[it.right] = (counts[it.right] || 0) + 1;
  const seg = ["all", "특허", "실용신안", "상표", "디자인"]
    .filter((k) => k === "all" || counts[k] || k === "특허")
    .map((k) => `<button class="seg-btn${ipFilter === k ? " on" : ""}" data-ip-filter="${k}" type="button">${k === "all" ? "전체" : k}<small>${counts[k] || 0}</small></button>`)
    .join("");
  $("activeFilters").innerHTML = `<span class="title">지식재산 대장</span><div class="seg-group">${seg}</div>
    <button class="btn sm primary" data-ip-new type="button">${icon("plus")}새로 넣기</button>
    <button class="btn sm ghost" data-ip-copy type="button" title="보이는 목록을 표로 복사합니다. 사업계획서의 지식재산 표에 붙여 넣으세요.">${icon("copy")}표로 복사</button>`;
  document.querySelector(".toolbar-right").hidden = true;
  $("list").hidden = true;
  $("empty").hidden = true;
  const board = $("appsBoard");
  board.hidden = false;
  const items = ipVisible();
  $("count").textContent = `${items.length}건`;
  const sug = ipSuggestionsOf();
  const strip = sug.length
    ? `<div class="due-strip ip-sug"><div class="due-head">${icon("sparkle")}<b>문서에서 찾은 번호</b><small>대장에 없는 ${sug.length}건</small>
        <button class="link-btn" data-ip-add-all type="button">모두 대장에 넣기</button></div>
      <ul>${sug
        .map((x, i) => `<li><div class="ip-sug-row"><span class="ip-right">${esc(x.right)}</span><b>${esc(x.appNo)}</b><span class="due-title">${esc(x.title || "(명칭은 문서를 보고 채워 주세요)")}</span><small>${esc(x.docs.map((d) => d.split("/").pop()).join(", "))}</small><button class="btn sm" data-ip-add="${i}" type="button">대장에 넣기</button></div></li>`)
        .join("")}</ul></div>`
    : "";
  if (!all.length && !sug.length) {
    board.innerHTML = `<div class="apps-empty">${icon("bulb")}<div><b>아직 대장에 넣은 지식재산이 없습니다.</b><br>
      특허·실용신안·상표·디자인을 한 건씩 넣어 두면 출원·등록 번호와 상태를 한눈에 보고, 사업계획서의 '지식재산 보유 현황' 표를 바로 만들 수 있습니다.<br>
      <small>출원서·특허증·등록증을 넣으면(분류: 지식재산) 문서에서 번호를 찾아 넣자고 알려 줍니다. Claude 에게 "지식재산 문서를 보고 대장을 채워 줘"라고 해도 됩니다.</small></div>
      <button class="btn primary" data-ip-new type="button">${icon("plus")}새로 넣기</button></div>`;
    return;
  }
  board.innerHTML =
    strip +
    (items.length
      ? items
          .map(
            (it) => `<div class="app-row ip-row${it.id === ipSelected ? " sel" : ""}" data-ip-id="${esc(it.id)}">
        <div class="app-main"><div class="app-title"><span class="ip-right">${esc(it.right)}</span>${esc(ipName(it))}</div>
          <div class="app-meta">${[it.topic, it.applicants, it.project].filter(Boolean).map(esc).join(" · ")}</div></div>
        <span class="app-state ${IP_STATUS_CLASS[it.status] || ""}">${esc(it.status)}</span>
        <div class="ip-nums">${it.appNo ? `<div><small>출원</small> ${esc(it.appNo)}${it.appDate ? ` <small>${esc(it.appDate)}</small>` : ""}</div>` : ""}${it.regNo ? `<div><small>등록</small> ${esc(it.regNo)}${it.regDate ? ` <small>${esc(it.regDate)}</small>` : ""}</div>` : ""}</div>
      </div>`
          )
          .join("")
      : `<div class="apps-empty"><div>이 종류의 지식재산이 없습니다.</div></div>`);
}

function leaveIpView() {
  $("appsBoard").hidden = true;
  document.querySelector(".toolbar-right").hidden = false;
}

// 오른쪽: 한 건 자세히
function renderIpDetail() {
  const box = $("detail");
  const it = ipOf().find((x) => x.id === ipSelected);
  if (!it) {
    box.innerHTML = `<div class="detail-empty">${icon("bulb")}<div>지식재산을 고르면 번호·상태·발명자·관련 주제와 문서를 기록합니다.</div></div>`;
    return;
  }
  const sel = (k, list) => `<label class="af"><span>${k === "right" ? "종류" : "상태"}</span><select class="select" data-ip-f="${k}">${list.map((v) => `<option${v === it[k] ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  const field = (k, label, ph = "", type = "text", list = "") => `<label class="af"><span>${label}</span><input type="${type}" data-ip-f="${k}" value="${esc(it[k] || "")}" placeholder="${esc(ph)}"${list ? ` list="${list}"` : ""}></label>`;
  const topics = [...new Set([...((S.applications && S.applications.items) || []).map((a) => a.topic), ...((S.applications && S.applications.cards) || []).filter((c) => c.kind === "topic").map((c) => c.name)].filter(Boolean))];
  const projects = [...new Set(((S.applications && S.applications.items) || []).map((a) => a.title).filter(Boolean))];
  const docs = it.docs
    .map((rel) => {
      const d = byRel.get(rel);
      return `<span class="doc-chip${d ? "" : " missing"}" title="${esc(rel)}"><button data-ip-open-doc="${esc(rel)}" type="button">${esc(d ? d.base : rel.split("/").pop() + " (없음)")}</button><button data-ip-unlink="${esc(rel)}" type="button" aria-label="연결 끊기">${icon("x")}</button></span>`;
    })
    .join("");
  box.innerHTML = `
    <div class="d-head"><span class="ficon app ip">${icon("bulb")}</span><div><h2>${esc(ipName(it))}</h2>
      <div class="d-path"><span class="app-state ${IP_STATUS_CLASS[it.status] || ""}">${esc(it.right)} · ${esc(it.status)}</span></div></div></div>
    <div class="card"><h4>${icon("info")}기본</h4>
      <div class="af-grid">${sel("right", (S.ip && S.ip.rights) || ["특허", "실용신안", "상표", "디자인"])}${sel("status", (S.ip && S.ip.statuses) || ["출원", "공개", "등록", "거절", "포기", "소멸"])}</div>
      ${field("title", it.right === "상표" ? "상표(명칭)" : it.right === "디자인" ? "디자인 물품(명칭)" : "발명의 명칭")}
      <div class="af-grid">${field("appNo", "출원번호", "10-2024-0123456")}${field("appDate", "출원일", "", "date")}${field("pubNo", "공개번호", "10-2025-0012345")}${field("pubDate", "공개일", "", "date")}${field("regNo", "등록번호", "10-2654321")}${field("regDate", "등록일", "", "date")}</div>
      <div class="af-grid">${field("applicants", "출원인", "예: (주)엠씨케이테크, ○○대학교")}${field("inventors", it.right === "상표" ? "담당자" : "발명자·창작자", "예: 홍길동, 김철수")}${field("country", "국가", "KR, US, PCT …")}</div>
    </div>
    <div class="card"><h4>${icon("layers")}연결<small>사업계획서·주제 카드에 쓰입니다</small></h4>
      <div class="af-grid">${field("topic", "관련 주제(기술)", "예: 그래핀 투명 전자파 차폐재", "text", "ipTopicList")}${field("project", "관련 과제(성과)", "이 특허가 나온 국가과제", "text", "ipProjectList")}</div>
      <datalist id="ipTopicList">${topics.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <datalist id="ipProjectList">${projects.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <label class="af"><span>메모</span><textarea data-ip-f="memo" rows="2" placeholder="공동출원 지분, 기술이전, 우선권 등">${esc(it.memo || "")}</textarea></label>
    </div>
    <div class="card"><h4>${icon("files")}문서<small>출원서·명세서·의견서·등록증</small></h4>
      <div class="stage-docs">${docs}<button class="link-btn" data-ip-link type="button">+ 문서 연결</button></div>
    </div>
    <div class="app-foot"><button class="btn sm ghost danger" data-ip-del type="button">${icon("trash")}대장에서 지우기</button></div>`;
}

// 문서 화면에 붙는 카드: 이 문서가 연결된 지식재산
function ipCardHtml(d) {
  const linked = ipOf().filter((it) => it.docs.includes(d.rel));
  if (!linked.length && !/^ip_/.test(d.category)) return "";
  const rows = linked.map((it) => `<li><button data-ip-goto="${esc(it.id)}" type="button"><b>${esc(ipName(it))}</b> <small>${esc(it.right)} · ${esc(it.status)}${it.appNo ? " · " + esc(it.appNo) : ""}</small></button></li>`).join("");
  const opts = ipOf()
    .filter((it) => !it.docs.includes(d.rel))
    .map((it) => `<option value="${esc(it.id)}">${esc(it.right)} · ${esc(ipName(it))}</option>`)
    .join("");
  return `<div class="card"><h4>${icon("bulb")}지식재산 대장</h4>
    ${rows ? `<ul class="app-links">${rows}</ul>` : '<p class="hint">아직 대장의 어느 건에도 연결되지 않았습니다.</p>'}
    ${opts ? `<select class="select" id="ipLinkSelect"><option value="">대장의 건에 연결…</option>${opts}</select>` : ""}
  </div>`;
}

function openIp(id) {
  ipSelected = id;
  filter.view = "ip";
  renderSide();
  renderList();
  renderDetail();
}

async function ipAddSuggestion(x) {
  return ipOp({ type: "create", fields: { right: x.right, title: x.title, appNo: x.appNo, appDate: x.appDate, regNo: x.regNo, regDate: x.regDate, docs: x.docs } });
}

// ---- 이벤트 ----
$("activeFilters").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || filter.view !== "ip") return;
  if (b.dataset.ipFilter) {
    ipFilter = b.dataset.ipFilter;
    return renderIpView();
  }
  if (b.hasAttribute("data-ip-new")) return ipNew();
  if (b.hasAttribute("data-ip-copy")) {
    const r = await api.ipCopy(ipVisible().map((it) => it.id));
    toast(`${r.count}건을 표로 복사했습니다. 사업계획서의 표나 엑셀에 붙여 넣으세요.`);
  }
});

async function ipNew() {
  const r = await ipOp({ type: "create", fields: { title: "새 지식재산" } });
  if (!r) return;
  ipFilter = "all";
  openIp(r.id);
  const t = document.querySelector('[data-ip-f="title"]');
  if (t) t.select();
}

$("appsBoard").addEventListener("click", async (e) => {
  if (filter.view !== "ip") return;
  if (e.target.closest("[data-ip-new]")) return ipNew();
  const add = e.target.closest("[data-ip-add]");
  if (add) {
    const x = ipSuggestionsOf()[parseInt(add.dataset.ipAdd, 10)];
    const r = x && (await ipAddSuggestion(x));
    if (r) {
      toast(`${x.appNo} 을(를) 대장에 넣었습니다. 명칭·발명자를 확인해 주세요.`);
      openIp(r.id);
    }
    return;
  }
  if (e.target.closest("[data-ip-add-all]")) {
    const list = ipSuggestionsOf();
    let n = 0;
    for (const x of list) if (await ipAddSuggestion(x)) n++;
    return toast(`${n}건을 대장에 넣었습니다. 명칭·발명자를 확인해 주세요.`);
  }
  const row = e.target.closest("[data-ip-id]");
  if (!row) return;
  ipSelected = row.dataset.ipId;
  for (const r of $("appsBoard").querySelectorAll(".ip-row")) r.classList.toggle("sel", r === row);
  renderIpDetail();
});

$("detail").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.ipGoto) return openIp(b.dataset.ipGoto);
  if (filter.view !== "ip") return;
  const it = ipOf().find((x) => x.id === ipSelected);
  if (!it) return;
  if (b.dataset.ipOpenDoc) {
    filter.view = "all";
    leaveIpView();
    return goto(b.dataset.ipOpenDoc);
  }
  if (b.dataset.ipUnlink) return ipOp({ type: "unlink", id: it.id, rel: b.dataset.ipUnlink });
  if (b.hasAttribute("data-ip-link")) return openDocPicker(b, new Set(it.docs), (d) => ipOp({ type: "link", id: it.id, rel: d.rel }, `'${d.base}'을(를) 연결했습니다.`));
  if (b.hasAttribute("data-ip-del")) {
    if (!confirm(`'${ipName(it)}'을(를) 대장에서 지울까요? (문서 파일은 지워지지 않습니다)`)) return;
    await ipOp({ type: "delete", id: it.id }, "대장에서 지웠습니다.");
    ipSelected = "";
    renderIpDetail();
  }
});

$("detail").addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "ipLinkSelect" && t.value) {
    const d = byRel.get(selected);
    if (d) await ipOp({ type: "link", id: t.value, rel: d.rel }, "지식재산 대장에 연결했습니다.");
    return;
  }
  if (filter.view !== "ip" || !t.dataset.ipF) return;
  const it = ipOf().find((x) => x.id === ipSelected);
  if (!it) return;
  const r = await ipOp({ type: "update", id: it.id, fields: { [t.dataset.ipF]: t.value } });
  if (!r) t.value = it[t.dataset.ipF] || "";
  else if (["right", "status", "regNo", "appNo"].includes(t.dataset.ipF)) renderIpDetail();
});
