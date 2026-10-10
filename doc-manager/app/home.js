// ---------- 할 일: 앱을 켜면 처음 보는 화면 ----------
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

// 왼쪽 메뉴 '할 일' 옆 숫자: 바로 챙겨야 하는 것 (7일 안 마감·지난 마감, 30일 안 만료 증빙)
function todoCount() {
  if (!S.docs) return 0;
  const t = todoData();
  return t.deadlines.filter((u) => u.daysLeft <= 7).length + t.certs.length; // 대장에 넣을 번호는 급하지 않아 세지 않는다
}

// allKind: 이 카드 항목을 한 번에 숨기는 '모두 확인함' (항목이 2개 넘을 때만)
function todoCard(iconName, title, n, body, foot = "", allKind = "") {
  const all = allKind && n > 2 ? `<button class="link-btn todo-all" data-t-hideall="${allKind}" type="button">모두 확인함</button>` : "";
  return `<section class="todo-card"><h3>${icon(iconName)}${title}${n ? `<small>${n}</small>` : ""}${all}</h3>${body}${foot ? `<div class="todo-foot">${foot}</div>` : ""}</section>`;
}

function renderTodoView() {
  $("activeFilters").innerHTML = `<span class="title">할 일</span><span class="muted small">오늘 챙길 것을 모아 보여 줍니다</span>`;
  document.querySelector(".toolbar-right").hidden = true;
  $("list").hidden = true;
  $("empty").hidden = true;
  const board = $("appsBoard");
  board.hidden = false;
  $("count").textContent = "";
  const t = todoData();
  const cards = [];

  if (t.deadlines.length)
    cards.push(
      todoCard(
        "calendar",
        "다가오는 마감",
        t.deadlines.length,
        `<ul class="todo-list">${t.deadlines
          .map((u) => `<li><button data-t-app="${esc(u.id)}" type="button"><span class="dday ${ddayClass(u.daysLeft)}">${ddayText(u.daysLeft)}</span><b>${esc(u.stage)}</b><span class="t-sub">${esc(u.title)}</span><small>${esc(dueShort(u.due))}</small></button>${hideBtn(todoKey.due(u))}</li>`)
          .join("")}</ul>`,
        "",
        "due"
      )
    );

  if (t.certs.length)
    cards.push(
      todoCard(
        "badge",
        "만료되는 회사 증빙",
        t.certs.length,
        `<ul class="todo-list">${t.certs
          .map((c) => `<li><button data-t-doc="${esc(c.rel)}" type="button"><span class="dday ${c.daysLeft < 0 ? "dd-over" : c.daysLeft <= 7 ? "dd-soon" : "dd-near"}">${c.daysLeft < 0 ? "만료됨" : `D-${c.daysLeft}`}</span><b>${esc(c.kind)}</b><small>${esc(c.validUntil)}까지</small></button>${hideBtn(todoKey.cert(c))}</li>`)
          .join("")}</ul>`,
        "새로 발급받아 넣으면 최신본이 바뀝니다"
      )
    );

  if (t.ipSug.length)
    cards.push(
      todoCard(
        "bulb",
        "대장에 없는 지식재산 번호",
        t.ipSug.length,
        `<ul class="todo-list">${t.ipSug
          .slice(0, 5)
          .map((x) => `<li><button data-t-view="ip" type="button"><span class="ip-right">${esc(x.right)}</span><b>${esc(x.appNo)}</b><span class="t-sub">${esc(x.title || "")}</span></button>${hideBtn(todoKey.ip(x))}</li>`)
          .join("")}</ul>`,
        `<button class="btn sm" data-t-view="ip" type="button">지식재산 대장에서 넣기</button>`,
        "ip"
      )
    );

  // 정리할 문서
  const tidy = [];
  const tidyKey = (name, n) => `tidy|${name}|${n}`; // 개수가 늘면 다시 나온다
  if (t.misplaced.length && !isHiddenTodo(tidyKey("misplaced", t.misplaced.length))) tidy.push(`<li><button data-t-view="misplaced" type="button">${icon("move")}<b>제자리가 아닌 문서</b><small>${t.misplaced.length}개</small></button><button class="btn sm" data-t-act="move-all" type="button">모두 옮기기</button>${hideBtn(tidyKey("misplaced", t.misplaced.length))}</li>`);
  if (t.dupGroups.length && !isHiddenTodo(tidyKey("dup", t.dupGroups.length))) tidy.push(`<li><button data-t-view="duplicates" type="button">${icon("copy")}<b>내용이 똑같은 파일</b><small>${t.dupGroups.length}묶음</small></button><button class="btn sm" data-t-act="dedupe" type="button">중복 정리</button>${hideBtn(tidyKey("dup", t.dupGroups.length))}</li>`);
  if (t.unclassified.length && !isHiddenTodo(tidyKey("other", t.unclassified.length))) tidy.push(`<li><button data-t-view="cat:other" type="button">${icon("question")}<b>미분류 문서</b><small>${t.unclassified.length}개</small></button>${hideBtn(tidyKey("other", t.unclassified.length))}</li>`);
  if (tidy.length) cards.push(todoCard("folder", "정리할 문서", "", `<ul class="todo-list tidy">${tidy.join("")}</ul>`));

  // 글자 읽기 (스캔 PDF)
  if (t.scanned.length || t.ocrFailed.length || ocrNow) {
    const now = ocrNow && byRel.get(ocrNow.rel);
    cards.push(
      todoCard(
        "search",
        "스캔 PDF 글자 읽기",
        t.scanned.length || "",
        `${now ? `<p class="hint">지금 읽는 중: <b>${esc(now.base)}</b>${ocrNow.of ? ` ${ocrNow.page}/${ocrNow.of}쪽` : ""}</p>` : ""}
        <ul class="todo-list">${[...t.scanned.slice(0, 4).map((d) => [d, "읽을 차례"]), ...t.ocrFailed.slice(0, 3).map((d) => [d, "읽지 못함"])]
          .map(([d, st]) => `<li><button data-t-doc="${esc(d.rel)}" type="button"><b>${esc(d.base)}</b><small>${st}</small></button>${hideBtn(todoKey.ocr(d))}</li>`)
          .join("")}</ul>`,
        S.platform === "win32" ? "" : "글자 읽기는 윈도우에서만 됩니다",
        "ocr"
      )
    );
  }

  if (t.missingCards.length)
    cards.push(
      todoCard(
        "sparkle",
        "아직 없는 작성 카드",
        t.missingCards.length,
        `<ul class="card-rows">${t.missingCards.slice(0, 5).map((c) => cardRowHtml(c.kind, c.name).replace(/<\/li>\s*$/, `${hideBtn(todoKey.card(c))}</li>`)).join("")}</ul>`,
        "진행 중인 지원 건에 쓰이는 주제·사업·문서 종류입니다",
        "card"
      )
    );

  if (t.recent.length)
    cards.push(
      todoCard(
        "clock",
        "이번 주에 바뀐 문서",
        "",
        `<ul class="todo-list">${t.recent.map((d) => `<li><button data-t-doc="${esc(d.rel)}" type="button"><b>${esc(d.base)}</b><small>${esc(relDate(d.mtimeMs))}</small></button></li>`).join("")}</ul>`
      )
    );

  cards.push(todoCard("bot", "최근 Claude 활동", "", `<ul class="todo-list" id="todoAiLog"><li class="muted small">불러오는 중…</li></ul>`));

  const urgent = t.deadlines.length + t.certs.length + t.ipSug.length;
  const nHidden = Object.keys(todoHidden).length;
  board.innerHTML = `${urgent ? "" : `<div class="todo-calm">${icon("check")}<div><b>급하게 챙길 것이 없습니다.</b><br><small>30일 안의 마감·만료가 생기면 여기에 먼저 나옵니다.</small></div></div>`}
    <div class="todo-grid">${cards.join("")}</div>
    ${nHidden ? `<p class="todo-hidden-note">확인함으로 숨긴 항목 ${nHidden}개 · <button class="link-btn" data-t-act="unhide" type="button">다시 보기</button></p>` : ""}`;
  fillTodoAiLog();
}

const TOOL_NAMES = () => (typeof TOOL_LABEL === "object" ? TOOL_LABEL : {});
async function fillTodoAiLog() {
  const box = $("todoAiLog");
  if (!box) return;
  let log = [];
  try {
    log = await api.aiLog();
  } catch {}
  if (!$("todoAiLog")) return;
  const rows = log.slice(0, 6); // 최근 것부터 온다
  $("todoAiLog").innerHTML = rows.length
    ? rows
        .map((l) => {
          const what = l.change_summary || l.query || l.path || "";
          return `<li class="ai-row"><span class="t-tool">${esc(TOOL_NAMES()[l.tool] || l.tool)}</span><span class="t-sub">${esc(String(what).split("/").pop())}</span><small>${esc(l.time ? relDate(Date.parse(l.time)) : "")}</small></li>`;
        })
        .join("")
    : '<li class="muted small">아직 Claude 가 이 보관함을 쓰지 않았습니다.</li>';
}

function renderTodoDetail() {
  $("detail").innerHTML = `<div class="detail-empty">${icon("check")}<div>할 일에서 항목을 누르면 그 지원 건·문서로 갑니다.<br><small>왼쪽 '문서'에서 전체 문서를 볼 수 있습니다.</small></div></div>`;
}

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
    leaveAppsView();
    renderSide();
    return goto(b.dataset.tDoc);
  }
  if (b.dataset.tView) {
    filter.view = b.dataset.tView;
    renderSide();
    renderList();
    return renderDetail();
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
