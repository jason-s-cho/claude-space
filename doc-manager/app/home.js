// ---------- 대시보드(할 일): 앱을 켜면 처음 보는 화면 ----------
// 흩어져 있던 알림을 한곳에: 다가오는 마감, 만료되는 증빙, 대장에 없는 특허 번호, 정리할 문서, 글자 읽기, 빠진 카드, 최근 문서, Claude 활동.
// ip.js 다음에 읽는다 (app.js·apps.js·ip.js 의 함수를 같이 쓴다).

const TODO_DUE_DAYS = 30; // 이 안의 마감·만료를 보여 준다

// '확인함'으로 숨긴 항목: { 열쇠: 숨긴 시각 }. 열쇠에 날짜·개수가 들어 있어 상황이 바뀌면(마감일 변경, 새 문서) 다시 나온다
let todoHidden = pref("todoHidden", {});
const isHiddenTodo = (k) => !!todoHidden[k];
function hideTodo(k) {
  const cut = Date.now() - 180 * DAY; // 오래된 것은 지워 둔다
  todoHidden = Object.fromEntries(Object.entries(todoHidden).filter(([, t]) => t > cut));
  todoHidden[k] = Date.now();
  setPref("todoHidden", todoHidden);
}
function unhideAllTodo() {
  todoHidden = {};
  setPref("todoHidden", todoHidden);
}
const hideBtn = (k) => `<button class="todo-hide" data-t-hide="${esc(k)}" type="button" title="확인함 — 목록에서 숨기기">${icon("check")}</button>`;
const todoKey = {
  due: (u) => `due|${u.id}|${u.stage}|${u.due}`,
  cert: (c) => `cert|${c.rel}|${c.validUntil}`,
  ip: (x) => `ip|${x.right}|${x.appNo}`,
  card: (c) => `card|${c.kind}|${c.name}`,
  ocr: (d) => `ocr|${d.rel}|${d.ocrError ? "err" : "wait"}`,
};

function todoData() {
  const docs = S.docs || [];
  const deadlines = (typeof upcomingOf === "function" ? upcomingOf() : []).filter((u) => u.daysLeft <= TODO_DUE_DAYS);
  const certs = (S.certs || []).filter((c) => c.daysLeft !== null && c.daysLeft <= TODO_DUE_DAYS);
  const ipSug = (S.ip && S.ip.suggestions) || [];
  const misplaced = docs.filter((d) => d.misplaced);
  const dupGroups = S.duplicates || [];
  const unclassified = docs.filter((d) => d.category === "other");
  const scanned = docs.filter((d) => d.scanned && !d.ocrError);
  const ocrFailed = docs.filter((d) => d.ocrError && !d.ocr);
  // 지원 건에 쓰이는데 아직 없는 카드
  const missingCards = [];
  if (typeof cardFind === "function") {
    const seen = new Set();
    for (const a of appsOf()) {
      if (a.progress.state === "선정" || a.progress.state === "탈락") continue;
      for (const [kind, name] of [["topic", a.topic], ["program", progKey(a)]]) {
        const k = kind + "|" + cardKey(name);
        if (!cardKey(name) || seen.has(k) || cardFind(kind, name)) continue;
        seen.add(k);
        missingCards.push({ kind, name: cardKey(name) });
      }
    }
    for (const g of GUIDE_DOCS) if (appsOf().length && !cardFind("guide", g)) missingCards.push({ kind: "guide", name: g });
  }
  const weekAgo = Date.now() - 7 * DAY;
  const recent = docs.filter((d) => d.mtimeMs > weekAgo).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 6);
  const vis = (key) => (x) => !isHiddenTodo(todoKey[key](x));
  return {
    deadlines: deadlines.filter(vis("due")),
    certs: certs.filter(vis("cert")),
    ipSug: ipSug.filter(vis("ip")),
    misplaced,
    dupGroups,
    unclassified,
    scanned: scanned.filter(vis("ocr")),
    ocrFailed: ocrFailed.filter(vis("ocr")),
    missingCards: missingCards.filter(vis("card")),
    recent,
  };
}

// 왼쪽 메뉴 '대시보드' 옆 숫자: 대시보드 '할 일' 칸에 보이는 항목 수와 같게
function todoCount() {
  if (!S.docs) return 0;
  return dashTodoRows(todoData()).length;
}

// ---------- 대시보드: 왼쪽 지표·마감 달력·최근 문서 / 가운데 세컨드 브레인 / 오른쪽 할 일·작성 카드·Claude 활동 ----------
let dashMonth = 0; // 마감 달력: 이번 달에서 몇 달 앞뒤
let dashCardQ = ""; // 작성 카드 검색어

const dashPanel = (iconName, title, body, opts = {}) =>
  `<section class="dash-panel${opts.cls ? " " + opts.cls : ""}"><h3>${icon(iconName)}<span>${title}</span>${opts.n ? `<small>${opts.n}</small>` : ""}${opts.right || ""}</h3>${body}</section>`;

function dashStats() {
  const docs = S.docs || [];
  const weekAgo = Date.now() - 7 * DAY;
  const apps = appsOf();
  const open = apps.filter((a) => a.progress.state !== "선정" && a.progress.state !== "탈락").length;
  const won = apps.filter((a) => a.progress.state === "선정").length;
  const ips = typeof ipOf === "function" ? ipOf() : [];
  const ipCats = new Set((S.categories || []).filter((c) => c.group === "지식재산").map((c) => c.id));
  const ipDocs = docs.filter((d) => ipCats.has(d.category)).length;
  const cards = cardsOf();
  const tile = (label, n, sub, view) => `<button class="dash-stat" data-t-view="${view}" type="button"><span>${label}</span><b>${Number(n).toLocaleString()}</b><small>${sub}</small></button>`;
  return `<div class="dash-stats">
    ${tile("문서", docs.length, `이번 주 +${docs.filter((d) => d.mtimeMs > weekAgo).length}`, "all")}
    ${tile("진행 중 지원", open, `선정 ${won} · 전체 ${apps.length}`, "apps")}
    ${tile("지식재산 문서", ipDocs, `대장 ${ips.length}건 · 등록 ${ips.filter((x) => x.status === "등록").length}`, "ip")}
    ${tile("Claude 카드", cards.length, `주제 ${cards.filter((c) => c.kind === "topic").length} · 사업 ${cards.filter((c) => c.kind === "program").length}`, "cards")}
  </div>`;
}

// 마감·만료 날짜 → 그날의 항목
function dashEvents() {
  const m = new Map();
  const add = (date, ev) => {
    if (!date) return;
    if (!m.has(date)) m.set(date, []);
    m.get(date).push(ev);
  };
  for (const u of upcomingOf()) add(String(u.due).slice(0, 10), { kind: "due", text: `${u.stage} · ${u.title}`, app: u.id, left: u.daysLeft });
  for (const c of S.certs || []) if (c.validUntil) add(String(c.validUntil).slice(0, 10), { kind: "cert", text: `${c.kind} 만료`, doc: c.rel, left: c.daysLeft });
  return m;
}

function dashCalendar() {
  const ev = dashEvents();
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() + dashMonth, 1);
  const y = first.getFullYear(), mo = first.getMonth();
  const days = new Date(y, mo + 1, 0).getDate();
  const pad = (n) => String(n).padStart(2, "0");
  let cells = "";
  for (let i = 0; i < first.getDay(); i++) cells += '<span class="cal-cell blank"></span>';
  for (let d = 1; d <= days; d++) {
    const key = `${y}-${pad(mo + 1)}-${pad(d)}`;
    const list = ev.get(key) || [];
    const isToday = dashMonth === 0 && d === today.getDate();
    const minLeft = list.length ? Math.min(...list.map((x) => x.left)) : null;
    const heat = !list.length ? "" : minLeft < 0 ? " h-over" : minLeft <= 3 ? " h-soon" : minLeft <= 7 ? " h-near" : " h-later";
    const tip = list.map((x) => x.text).join("\n");
    const target = list[0] ? (list[0].app ? `data-t-app="${esc(list[0].app)}"` : `data-t-doc="${esc(list[0].doc)}"`) : "";
    cells += list.length
      ? `<button class="cal-cell${heat}${isToday ? " today" : ""}" ${target} type="button" title="${esc(tip)}">${d}${list.length > 1 ? `<i>${list.length}</i>` : ""}</button>`
      : `<span class="cal-cell${isToday ? " today" : ""}">${d}</span>`;
  }
  // 다가오는 것 3개
  const next = [...ev.entries()]
    .flatMap(([date, l]) => l.map((x) => ({ ...x, date })))
    .filter((x) => x.left >= 0)
    .sort((a, b) => a.left - b.left)
    .slice(0, 3);
  const nextHtml = next.length
    ? `<ul class="dash-mini">${next
        .map((x) => `<li><button ${x.app ? `data-t-app="${esc(x.app)}"` : `data-t-doc="${esc(x.doc)}"`} type="button"><span class="dday ${ddayClass(x.left)}">${ddayText(x.left)}</span><span class="t-sub">${esc(x.text)}</span></button></li>`)
        .join("")}</ul>`
    : '<p class="dash-none">다가오는 마감이 없습니다</p>';
  return dashPanel(
    "calendar",
    "마감 달력",
    `<div class="cal-week">${"일월화수목금토".split("").map((w) => `<span>${w}</span>`).join("")}</div><div class="cal-grid">${cells}</div>${nextHtml}`,
    {
      right: `<span class="cal-nav"><button class="icon-btn sm" data-dash-month="-1" type="button" aria-label="이전 달">${icon("chevron")}</button><b>${y}.${pad(mo + 1)}</b><button class="icon-btn sm" data-dash-month="1" type="button" aria-label="다음 달">${icon("chevron")}</button></span>`,
    }
  );
}

function dashRecent() {
  const rows = [...(S.docs || [])].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
  return dashPanel(
    "clock",
    "최근 문서",
    rows.length
      ? `<ul class="dash-mini">${rows.map((d) => `<li><button data-t-doc="${esc(d.rel)}" type="button"><span class="dot" style="background:${(catById[d.category] || {}).color || "#888"}"></span><span class="t-sub">${esc(d.base)}</span><small>${esc(relDate(d.mtimeMs))}</small></button></li>`).join("")}</ul>`
      : '<p class="dash-none">아직 문서가 없습니다</p>',
    { right: `<button class="link-btn dash-more" data-t-view="recent" type="button">더 보기</button>` }
  );
}

function dashShortcuts() {
  const apps = appsOf().length, ips = typeof ipOf === "function" ? ipOf().length : 0;
  const go = (view, ic, label, sub) => `<button class="dash-go" data-t-view="${view}" type="button"><span class="dash-go-ic">${icon(ic)}</span><span><b>${label}</b><small>${sub}</small></span>${icon("chevron")}</button>`;
  return dashPanel(
    "layers",
    "바로 가기",
    `<div class="dash-gos">${go("apps", "briefcase", "지원 현황", `${apps}건 · 단계·마감·자료`)}${go("ip", "bulb", "지식재산 대장", `${ips}건 · 특허·상표·디자인`)}${go("all", "files", "전체 문서", `${(S.docs || []).length.toLocaleString()}개 · 검색·버전`)}</div>`
  );
}

// 오른쪽: 할 일 (급한 것부터 한 목록으로)
function dashTodoRows(t) {
  const rows = [];
  for (const u of t.deadlines) rows.push(`<li><button data-t-app="${esc(u.id)}" type="button"><span class="dday ${ddayClass(u.daysLeft)}">${ddayText(u.daysLeft)}</span><span class="t-sub"><b>${esc(u.stage)}</b> ${esc(u.title)}</span></button>${hideBtn(todoKey.due(u))}</li>`);
  for (const c of t.certs) rows.push(`<li><button data-t-doc="${esc(c.rel)}" type="button"><span class="dday ${c.daysLeft < 0 ? "dd-over" : c.daysLeft <= 7 ? "dd-soon" : "dd-near"}">${c.daysLeft < 0 ? "만료됨" : `D-${c.daysLeft}`}</span><span class="t-sub"><b>${esc(c.kind)}</b> 만료</span></button>${hideBtn(todoKey.cert(c))}</li>`);
  for (const x of t.ipSug.slice(0, 3)) rows.push(`<li><button data-t-view="ip" type="button"><span class="tag-k">대장</span><span class="t-sub"><b>${esc(x.appNo)}</b> ${esc(x.title || "")}</span></button>${hideBtn(todoKey.ip(x))}</li>`);
  const tidyKey = (name, n) => `tidy|${name}|${n}`;
  if (t.misplaced.length && !isHiddenTodo(tidyKey("misplaced", t.misplaced.length))) rows.push(`<li><button data-t-view="misplaced" type="button"><span class="tag-k">정리</span><span class="t-sub">제자리가 아닌 문서 ${t.misplaced.length}개</span></button><button class="btn xs" data-t-act="move-all" type="button">옮기기</button>${hideBtn(tidyKey("misplaced", t.misplaced.length))}</li>`);
  if (t.dupGroups.length && !isHiddenTodo(tidyKey("dup", t.dupGroups.length))) rows.push(`<li><button data-t-view="duplicates" type="button"><span class="tag-k">정리</span><span class="t-sub">내용이 똑같은 파일 ${t.dupGroups.length}묶음</span></button><button class="btn xs" data-t-act="dedupe" type="button">정리</button>${hideBtn(tidyKey("dup", t.dupGroups.length))}</li>`);
  if (t.unclassified.length && !isHiddenTodo(tidyKey("other", t.unclassified.length))) rows.push(`<li><button data-t-view="cat:other" type="button"><span class="tag-k">정리</span><span class="t-sub">미분류 문서 ${t.unclassified.length}개</span></button>${hideBtn(tidyKey("other", t.unclassified.length))}</li>`);
  for (const d of t.scanned.slice(0, 2)) rows.push(`<li><button data-t-doc="${esc(d.rel)}" type="button"><span class="tag-k">OCR</span><span class="t-sub">${esc(d.base)}</span></button>${hideBtn(todoKey.ocr(d))}</li>`);
  for (const d of t.ocrFailed.slice(0, 2)) rows.push(`<li><button data-t-doc="${esc(d.rel)}" type="button"><span class="tag-k warn">OCR</span><span class="t-sub">읽지 못함 · ${esc(d.base)}</span></button>${hideBtn(todoKey.ocr(d))}</li>`);
  return rows;
}
function dashTodo(t) {
  const rows = dashTodoRows(t);
  const nHidden = Object.keys(todoHidden).length;
  const now = ocrNow && byRel.get(ocrNow.rel);
  return dashPanel(
    "check",
    "할 일",
    `${now ? `<p class="hint">글자 읽는 중: <b>${esc(now.base)}</b>${ocrNow.of ? ` ${ocrNow.page}/${ocrNow.of}쪽` : ""}</p>` : ""}
    ${rows.length ? `<ul class="todo-list dash-todo">${rows.join("")}</ul>` : `<div class="dash-calm">${icon("check")}<span>급하게 챙길 것이 없습니다</span></div>`}
    ${nHidden ? `<p class="dash-foot">숨긴 항목 ${nHidden}개 · <button class="link-btn" data-t-act="unhide" type="button">다시 보기</button></p>` : ""}`,
    { n: rows.length || "", cls: "dash-todo-panel", right: t.deadlines.length > 2 ? `<button class="link-btn dash-more" data-t-hideall="due" type="button">마감 모두 확인함</button>` : "" }
  );
}

// 오른쪽: 작성 카드 (영상의 '스킬' 자리) — ▶ 를 누르면 Claude 에게 보낼 요청이 복사된다
function dashCardItems(t) {
  const items = cardsOf().map((c) => ({ kind: c.kind, name: c.name, updated: c.updated }));
  for (const m of t.missingCards) if (!items.some((x) => x.kind === m.kind && looseName(x.name) === looseName(m.name))) items.push({ kind: m.kind, name: m.name, missing: true });
  return items.sort((a, b) => !!b.missing - !!a.missing || (b.updated || 0) - (a.updated || 0));
}
function dashCards(t) {
  const items = dashCardItems(t);
  const KIND_SHORT = { topic: "주제", program: "사업", guide: "가이드" };
  const rows = items
    .map(
      (c) => `<li class="dash-card${c.missing ? " missing" : ""}" data-dash-card="${esc((c.name + " " + KIND_SHORT[c.kind]).toLowerCase())}">
      <button class="dash-card-main" data-c-edit data-c-kind="${c.kind}" data-c-name="${esc(cardKey(c.name))}" type="button" title="보기·고치기">
        <span class="tag-k k-${c.kind}">${KIND_SHORT[c.kind]}</span><b>${esc(cardKey(c.name))}</b>
        <small>${c.missing ? "아직 없음" : esc(relDate(c.updated))}</small>
      </button>
      <button class="dash-play" data-c-copy="${esc(cardPrompt(c.kind, c.name))}" type="button" title="${c.missing ? "Claude 로 만들기" : "Claude 로 새로 고치기"} — 요청 문장을 복사합니다">${icon("sparkle")}</button>
    </li>`
    )
    .join("");
  return dashPanel(
    "sparkle",
    "작성 카드",
    `<label class="dash-search">${icon("search")}<input id="dashCardQ" type="search" placeholder="카드 검색" value="${esc(dashCardQ)}" autocomplete="off" spellcheck="false"></label>
     ${items.length ? `<ul class="dash-cards" id="dashCardList">${rows}</ul>` : '<p class="dash-none">지원 현황에 주제·사업명을 적으면 카드를 만들 수 있습니다</p>'}`,
    { n: cardsOf().length || "", cls: "dash-cards-panel" }
  );
}
function dashFilterCards() {
  const q = dashCardQ.trim().toLowerCase();
  document.querySelectorAll("#dashCardList [data-dash-card]").forEach((li) => (li.hidden = !!q && !li.dataset.dashCard.includes(q)));
}

function renderTodoView() {
  document.querySelector(".toolbar").hidden = true;
  $("list").hidden = true;
  $("empty").hidden = true;
  const board = $("appsBoard");
  board.hidden = false;
  board.classList.add("dash-board");
  $("count").textContent = "";
  const t = todoData();
  const groups = brainGroups();
  const total = (S.docs || []).length;
  const legend = groups
    .filter((g) => !g.core)
    .map((g) => `<button class="brain-chip" data-t-view="${esc(g.view)}" data-brain="${esc(g.key)}" type="button"><span class="dot" style="background:${g.color}"></span>${esc(g.label)}<small>${g.n.toLocaleString()}</small></button>`)
    .join("");
  board.innerHTML = `<div class="dash">
    <div class="dash-col">${dashStats()}${dashCalendar()}${dashRecent()}${dashShortcuts()}</div>
    <div class="dash-col dash-center">
      <section class="dash-panel brain-panel">
        <h3>${icon("layers")}<span>세컨드 브레인</span><span class="brain-sum">문서 ${total.toLocaleString()} · 카드 ${cardsOf().length} · 분류 ${groups.length - 1}</span></h3>
        <div class="brain-stage" id="brainStage"><canvas id="brainCanvas" aria-label="분류별 문서 지도"></canvas><div class="brain-tip" id="brainTip" hidden></div></div>
        <div class="brain-legend">${legend}</div>
      </section>
    </div>
    <div class="dash-col">${dashTodo(t)}${dashCards(t)}${dashPanel("bot", "최근 Claude 활동", `<ul class="todo-list" id="todoAiLog"><li class="muted small">불러오는 중…</li></ul>`)}</div>
  </div>`;
  dashFilterCards();
  startBrain(groups);
  fillTodoAiLog();
}

// ---------- 세컨드 브레인: 분류 묶음마다 문서 수만큼 점으로 된 공, 가운데는 Claude 지식 카드 ----------
function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return `rgb(${c.join(",")})`;
}
function brainGroups() {
  const docs = S.docs || [];
  const by = new Map();
  for (const c of S.categories || []) {
    const key = c.group || c.id;
    if (!by.has(key)) by.set(key, { key, label: c.group || c.label, view: c.group ? "group:" + c.group : "cat:" + c.id, color: c.color, cats: [] });
    by.get(key).cats.push(c);
  }
  const out = [];
  for (const g of by.values()) {
    const ids = new Set(g.cats.map((c) => c.id));
    const mine = docs.filter((d) => ids.has(d.category));
    // 점 색: 그 문서의 세부 분류 색 (세부 분류 순서대로 모아 둔다)
    const colors = [];
    for (const c of g.cats) {
      const n = mine.filter((d) => d.category === c.id).length;
      for (let i = 0; i < n; i++) colors.push(lighten(c.color, 0.28));
    }
    out.push({ ...g, n: mine.length, colors, color: lighten(g.color, 0.15) });
  }
  const cards = cardsOf();
  out.push({ key: "_cards", label: "Claude 지식", view: "cards", n: cards.length, colors: cards.map(() => "rgb(255,214,140)"), color: "#ffd68c", core: true });
  return out.filter((g) => g.n > 0 || g.core);
}

let brainState = null;
function startBrain(groups) {
  const canvas = $("brainCanvas");
  const stage = $("brainStage");
  if (!canvas || !stage) return;
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = { canvas, stage, groups, hover: null, t0: brainState ? brainState.t0 : performance.now(), W: 0, H: 0, layout: [] };
  brainState = st;

  function layoutOf() {
    const W = st.W, H = st.H;
    const outer = groups.filter((g) => !g.core).sort((a, b) => b.n - a.n);
    const maxN = Math.max(1, ...outer.map((g) => g.n));
    const rMax = Math.min(W * 0.12, H * 0.155); // 좁은 창에서도 이웃 공과 겹치지 않게
    const cx = W / 2, cy = H / 2 - 8;
    // 큰 공과 작은 공을 번갈아 둘러 놓는다
    const order = [];
    let lo = 0, hi = outer.length - 1;
    while (lo <= hi) {
      order.push(outer[lo++]);
      if (lo <= hi) order.push(outer[hi--]);
    }
    const L = order.map((g, i) => {
      const a = -Math.PI / 2 + (i / order.length) * Math.PI * 2;
      const r = Math.max(14, rMax * Math.sqrt(g.n / maxN));
      return { g, x: cx + Math.cos(a) * W * 0.34, y: cy + Math.sin(a) * H * 0.32, r, pts: spherePts(Math.round(70 + 380 * (r / rMax) ** 2)) }; // 점 수는 공 크기에 맞춘다 (문서가 적은 분류도 촘촘한 공으로)
    });
    const core = groups.find((g) => g.core);
    if (core) L.push({ g: core, x: cx, y: cy, r: Math.max(18, rMax * 0.42), pts: spherePts(Math.max(24, core.n * 18)), core: true });
    return L;
  }

  function spherePts(m) {
    const pts = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < m; i++) {
      const y = 1 - (i / Math.max(1, m - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = ga * i;
      pts.push([Math.cos(th) * rad, y, Math.sin(th) * rad]);
    }
    return pts;
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    st.W = Math.max(200, r.width);
    st.H = Math.max(200, r.height);
    canvas.width = st.W * dpr;
    canvas.height = st.H * dpr;
    canvas.style.width = st.W + "px";
    canvas.style.height = st.H + "px";
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    st.layout = layoutOf();
    draw(performance.now());
  }

  function draw(now) {
    const ctx = canvas.getContext("2d");
    const { W, H } = st;
    ctx.clearRect(0, 0, W, H);
    const time = reduce ? 0 : (now - st.t0) / 1000;
    const core = st.layout.find((l) => l.core);
    // 가운데와 이어지는 가는 선
    if (core)
      for (const l of st.layout) {
        if (l.core) continue;
        const hov = st.hover === l;
        ctx.strokeStyle = hov ? "rgba(255,214,140,0.35)" : "rgba(140,160,220,0.08)";
        ctx.lineWidth = hov ? 1.2 : 1;
        ctx.beginPath();
        ctx.moveTo(core.x, core.y);
        ctx.lineTo(l.x, l.y);
        ctx.stroke();
      }
    for (const l of st.layout) {
      const hov = st.hover === l;
      const dim = st.hover && !hov ? 0.45 : 1;
      const r = l.r * (hov ? 1.06 : 1);
      const ang = time * (l.core ? 0.35 : 0.18 + (l.r % 7) * 0.012);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const tilt = 0.35, ct = Math.cos(tilt), stt = Math.sin(tilt);
      const cols = l.g.colors.length ? l.g.colors : [l.g.color];
      // 은은한 빛
      const glow = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, r * 1.6);
      glow.addColorStop(0, l.core ? "rgba(255,200,120,0.22)" : "rgba(120,150,255,0.07)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(l.x - r * 1.6, l.y - r * 1.6, r * 3.2, r * 3.2);
      for (let i = 0; i < l.pts.length; i++) {
        const [px, py, pz] = l.pts[i];
        const x1 = px * ca + pz * sa, z1 = -px * sa + pz * ca;
        const y2 = py * ct - z1 * stt, z2 = py * stt + z1 * ct;
        const depth = (z2 + 1) / 2; // 0 뒤 .. 1 앞
        const s = (l.core ? 1.6 : 1.1) + depth * (l.core ? 1.4 : 1.3);
        ctx.globalAlpha = (0.18 + depth * 0.82) * dim;
        ctx.fillStyle = cols[Math.floor((i / l.pts.length) * cols.length) % cols.length];
        ctx.fillRect(l.x + x1 * r - s / 2, l.y + y2 * r - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
      if (l.core) {
        ctx.fillStyle = "#fff4dc";
        ctx.beginPath();
        ctx.arc(l.x, l.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 이름표: 큰 공부터, 이미 그린 이름표와 겹치면 건너뛴다 (아래 범례와 마우스 설명에 다 있다)
    const boxes = [];
    ctx.textAlign = "center";
    for (const l of [...st.layout].sort((a, b) => (st.hover === b) - (st.hover === a) || b.r - a.r)) {
      const hov = st.hover === l;
      const dim = st.hover && !hov ? 0.45 : 1;
      const text = `${l.g.label} ${l.g.n.toLocaleString()}`;
      ctx.font = `${hov ? 600 : 500} 11.5px Pretendard, "Malgun Gothic", sans-serif`;
      const w = ctx.measureText(text).width + 8, y = l.y + l.r * (hov ? 1.06 : 1) + 16;
      const box = [l.x - w / 2, y - 12, l.x + w / 2, y + 4];
      if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      boxes.push(box);
      ctx.fillStyle = hov ? "rgba(255,255,255,0.95)" : `rgba(200,210,235,${0.62 * dim + 0.1})`;
      ctx.fillText(text, l.x, y);
    }
  }

  function hit(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null;
    for (const l of st.layout) {
      const d = Math.hypot(x - l.x, y - l.y);
      if (d <= l.r + 10 && (!best || d < best.d)) best = { l, d };
    }
    return best && best.l;
  }
  canvas.addEventListener("mousemove", (e) => {
    const h = hit(e);
    if (h !== st.hover) {
      st.hover = h;
      canvas.style.cursor = h ? "pointer" : "";
      if (reduce) draw(performance.now());
    }
    const tip = $("brainTip");
    if (h) {
      tip.hidden = false;
      tip.innerHTML = h.core
        ? `<b>Claude 지식</b> 작성 카드 ${h.g.n}장<br><small>눌러서 카드 목록 보기</small>`
        : `<b>${esc(h.g.label)}</b> 문서 ${h.g.n.toLocaleString()}개<br><small>${h.g.cats.map((c) => esc(c.label)).join(" · ")}</small>`;
      const r = stage.getBoundingClientRect();
      tip.style.left = Math.min(e.clientX - r.left + 14, st.W - 200) + "px";
      tip.style.top = e.clientY - r.top + 12 + "px";
    } else tip.hidden = true;
  });
  canvas.addEventListener("mouseleave", () => {
    st.hover = null;
    $("brainTip") && ($("brainTip").hidden = true);
    if (reduce) draw(performance.now());
  });
  canvas.addEventListener("click", (e) => {
    const h = hit(e);
    if (h) dashGo(h.g.view);
  });

  new ResizeObserver(() => stage.isConnected && resize()).observe(stage);
  resize();
  if (reduce) return;
  let last = 0;
  (function loop(now) {
    if (brainState !== st || !canvas.isConnected) return; // 다른 화면으로 가면 멈춘다
    if (!document.hidden && now - last > 33) {
      last = now;
      draw(now);
    }
    requestAnimationFrame(loop);
  })(performance.now());
}

// 대시보드에서 다른 화면으로
function dashGo(view) {
  if (view === "cards") return openSettings("claude");
  filter.view = view;
  if (typeof leaveDash === "function") leaveDash();
  renderSide();
  renderList();
  renderDetail();
}
function leaveDash() {
  const board = $("appsBoard");
  board.classList.remove("dash-board");
  document.querySelector(".toolbar").hidden = false;
}

const TOOL_NAMES = () => (typeof TOOL_LABEL === "object" ? TOOL_LABEL : {});
// 기록에 대상이 없는 활동은 무엇을 했는지 말로 적는다
const AI_LOG_PLAIN = { library_overview: "보관함 전체 훑어봄" };
// 최근 것부터 온 기록 → 같은 활동·같은 대상이 이어지면 한 줄로 (가장 최근 시각, 횟수)
function aiLogRows(log) {
  const rows = [];
  for (const l of log) {
    const raw = l.change_summary || l.query || l.path || "";
    const what = raw ? String(raw).split("/").pop() : AI_LOG_PLAIN[l.tool] || "";
    const last = rows[rows.length - 1];
    if (last && last.tool === l.tool && last.what === what) last.n++;
    else rows.push({ tool: l.tool, what, time: l.time, n: 1 });
  }
  return rows;
}
async function fillTodoAiLog() {
  const box = $("todoAiLog");
  if (!box) return;
  let log = [];
  try {
    log = await api.aiLog();
  } catch {}
  if (!$("todoAiLog")) return;
  const rows = aiLogRows(log).slice(0, 6);
  $("todoAiLog").innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<li class="ai-row"><span class="t-tool">${esc(TOOL_NAMES()[r.tool] || r.tool)}</span><span class="t-sub">${esc(r.what)}</span>${r.n > 1 ? `<span class="ai-n" title="이어서 ${r.n}번">×${r.n}</span>` : ""}<small>${esc(r.time ? relDate(Date.parse(r.time)) : "")}</small></li>`
        )
        .join("")
    : '<li class="muted small">아직 Claude 가 이 보관함을 쓰지 않았습니다.</li>';
}

function renderTodoDetail() {
  $("detail").innerHTML = `<div class="detail-empty">${icon("check")}<div>할 일에서 항목을 누르면 그 지원 건·문서로 갑니다.<br><small>왼쪽 '문서'에서 전체 문서를 볼 수 있습니다.</small></div></div>`;
}

// 작성 카드 검색: 목록만 거른다 (화면을 다시 그리면 입력 칸이 사라진다)
$("appsBoard").addEventListener("input", (e) => {
  if (filter.view !== "todo" || e.target.id !== "dashCardQ") return;
  dashCardQ = e.target.value;
  dashFilterCards();
});

$("appsBoard").addEventListener("click", async (e) => {
  if (filter.view !== "todo") return;
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.tHide) {
    hideTodo(b.dataset.tHide);
    renderSide(); // 왼쪽 '할 일' 숫자
    return renderTodoView();
  }
  if (b.dataset.tHideall) {
    const t = todoData();
    const k = b.dataset.tHideall;
    const list = { due: t.deadlines, ip: t.ipSug, card: t.missingCards, ocr: [...t.scanned, ...t.ocrFailed] }[k] || [];
    for (const x of list) hideTodo(todoKey[k](x));
    renderSide();
    return renderTodoView();
  }
  if (b.dataset.tAct === "unhide") {
    unhideAllTodo();
    renderSide();
    return renderTodoView();
  }
  if (b.dataset.tApp) return openApp(b.dataset.tApp);
  if (b.dataset.tDoc) {
    filter.view = "all";
    leaveDash();
    leaveAppsView();
    renderSide();
    return goto(b.dataset.tDoc);
  }
  if (b.dataset.tView) return dashGo(b.dataset.tView);
  if (b.dataset.dashMonth) {
    dashMonth += Number(b.dataset.dashMonth);
    return renderTodoView();
  }
  if (b.dataset.tAct === "move-all") return openMoveDialog(S.docs.filter((d) => d.misplaced));
  if (b.dataset.tAct === "dedupe") return openDupDialog();
});

// 앱을 켤 때 home.js 보다 먼저 그려졌으면 다시 그린다
if (filter.view === "todo" && S && S.docs) {
  renderSide();
  renderList();
  renderDetail();
}
