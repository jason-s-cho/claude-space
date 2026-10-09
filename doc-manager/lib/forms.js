// 양식 채우기: 워드(.docx)·한글(.hwpx) 양식의 글자만 바꾸고 서식(글꼴·표·칸 크기·문단 모양)은 그대로 둔다.
//
// 1) inspectForm: 문서를 '칸' 목록으로 보여 준다.
//    - 표 밖의 문단: p1, p2, …
//    - 표 칸: t1.r2.c3 (1번째 표의 2행 3열. 합친 칸은 왼쪽 위 칸 하나로)
//    칸마다 지금 글자와, 표 칸이면 같은 행의 왼쪽 제목·같은 열의 맨 위 제목을 붙여 준다.
// 2) fillForm: { id, text } 목록대로 글자를 바꾼 새 파일 내용을 만든다. (원본 파일은 건드리지 않는다)
//    줄바꿈(\n)은 같은 모양의 문단을 더 만들어 넣는다. 글자 모양은 그 칸에 있던 첫 글자의 모양을 따른다.
//
// 칸 번호는 문서 구조(문단·표 순서)로 정해지므로, 같은 파일이면 inspect 와 fill 에서 항상 같다.
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

const FORM_EXTS = [".docx", ".hwpx"];
const MAX_FILLS = 3000;
const MAX_TEXT = 30000; // 칸 하나에 넣을 수 있는 글자 수

// ---------- 공통 DOM 도우미 ----------

const isEl = (n) => n && n.nodeType === 1;
const kids = (el, name) => {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (isEl(n) && (!name || n.localName === name)) out.push(n);
  return out;
};
const kid = (el, name) => kids(el, name)[0] || null;

function parseXml(text) {
  const errors = [];
  const doc = new DOMParser({ onError: (level, msg) => level !== "warning" && errors.push(msg) }).parseFromString(text, "text/xml");
  if (errors.length || !doc.documentElement) throw new Error("문서 XML 을 읽을 수 없습니다: " + (errors[0] || "빈 문서"));
  return doc;
}

const clip = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

// 안내 문구 색: 회색(808080, A6A6A6 …). 기울임 + 검정이 아닌 색도 안내 문구로 본다 ("(기관명)", "※ 작성 요령").
function isGuideColor(hex, italic) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  const gray = Math.max(r, g, b) - Math.min(r, g, b) <= 12 && r >= 0x60 && r <= 0xd8;
  const black = r < 0x40 && g < 0x40 && b < 0x40;
  return gray || (italic && !black);
}

// ---------- 워드(.docx) ----------

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function docxRunText(r, out) {
  for (const c of kids(r)) {
    if (c.localName === "t") out.push(c.textContent);
    else if (c.localName === "tab") out.push("\t");
    else if (c.localName === "br" || c.localName === "cr") out.push("\n");
    else if (c.localName === "noBreakHyphen") out.push("-");
  }
}

function docxParaText(p) {
  const out = [];
  const visit = (el) => {
    for (const c of kids(el)) {
      if (c.localName === "r") docxRunText(c, out);
      else if (["hyperlink", "ins", "smartTag", "fldSimple", "customXml", "sdt", "sdtContent"].includes(c.localName)) visit(c);
    }
  };
  visit(p);
  return out.join("");
}

function docxStyle(p) {
  const pPr = kid(p, "pPr");
  const st = pPr && kid(pPr, "pStyle");
  return st ? st.getAttributeNS(W, "val") || st.getAttribute("w:val") : "";
}

const wAttr = (el, name) => (el ? el.getAttributeNS(W, name) || el.getAttribute("w:" + name) : "");

// 표 칸 안의 문단들 (내용 컨트롤 sdt 안쪽까지)
function docxBlocks(container) {
  const out = [];
  for (const c of kids(container)) {
    if (c.localName === "p" || c.localName === "tbl") out.push(c);
    else if (c.localName === "sdt") {
      const content = kid(c, "sdtContent");
      if (content) out.push(...docxBlocks(content));
    } else if (c.localName === "customXml") out.push(...docxBlocks(c));
  }
  return out;
}

function docxCells(tr) {
  const out = [];
  for (const c of kids(tr)) {
    if (c.localName === "tc") out.push(c);
    else if (c.localName === "sdt") {
      const content = kid(c, "sdtContent");
      if (content) out.push(...kids(content, "tc"));
    }
  }
  return out;
}

function walkDocx(doc, model) {
  const body = kid(doc.documentElement, "body");
  if (!body) throw new Error("워드 문서 본문을 찾을 수 없습니다");
  const table = (tbl) => {
    const tId = `t${++model.tables}`;
    const grid = new Map();
    const cells = [];
    kids(tbl, "tr").forEach((tr, ri) => {
      let col = 0;
      for (const tc of docxCells(tr)) {
        const tcPr = kid(tc, "tcPr");
        const span = parseInt(wAttr(tcPr && kid(tcPr, "gridSpan"), "val"), 10) || 1;
        const vm = tcPr && kid(tcPr, "vMerge");
        const cont = vm && wAttr(vm, "val") !== "restart";
        if (!cont) {
          const blocks = docxBlocks(tc);
          const nested = blocks.filter((b) => b.localName === "tbl");
          const paras = blocks.filter((b) => b.localName === "p");
          const text = paras.map(docxParaText).join("\n");
          grid.set(`${ri}:${col}`, text);
          if (nested.length) nested.forEach(table);
          else cells.push({ id: `${tId}.r${ri + 1}.c${col + 1}`, r: ri, c: col, text, node: { kind: "docx-cell", tc, paras } });
        }
        col += span;
      }
    });
    for (const cell of cells) model.slots.push({ ...cell, kind: "cell", table: tId, labels: labelsFor(grid, cell.r, cell.c) });
  };
  for (const b of docxBlocks(body)) {
    if (b.localName === "tbl") table(b);
    else model.slots.push({ id: `p${++model.paras}`, kind: "paragraph", text: docxParaText(b), style: docxStyle(b), node: { kind: "docx-p", p: b } });
  }
}

function docxRun(doc, rPr, text) {
  const r = doc.createElementNS(W, "w:r");
  if (rPr) r.appendChild(rPr.cloneNode(true));
  text.split("\t").forEach((seg, i) => {
    if (i) r.appendChild(doc.createElementNS(W, "w:tab"));
    if (seg) {
      const t = doc.createElementNS(W, "w:t");
      t.setAttribute("xml:space", "preserve");
      t.appendChild(doc.createTextNode(seg));
      r.appendChild(t);
    }
  });
  return r;
}

// 문단의 글자 모양: 글자가 있는 첫 런의 모양, 없으면 문단 기호의 글자 모양(빈 칸에 글자를 치면 Word 가 쓰는 모양).
// 그 글자가 안내 문구(회색·기울임 색 글자, '개체 틀 텍스트' 스타일)면 색·기울임은 빼고 쓴다.
// 결과: { rPr, restyled }
function docxRunProps(p) {
  const rPr = docxRawRunProps(p);
  if (!rPr) return { rPr: null, restyled: false };
  const out = rPr.cloneNode(true);
  const style = kid(out, "rStyle");
  const color = kid(out, "color");
  const italic = !!kid(out, "i");
  const placeholder = (style && /placeholder/i.test(wAttr(style, "val"))) || (color && isGuideColor(wAttr(color, "val"), italic)) || docxShowingPlaceholder(p);
  if (!placeholder) return { rPr: out, restyled: false };
  for (const c of kids(out)) if (["rStyle", "color", "i", "iCs"].includes(c.localName)) out.removeChild(c);
  return { rPr: kids(out).length ? out : null, restyled: true };
}

// 내용 컨트롤이 '안내 문구 보이는 중'(showingPlcHdr)인지
function docxShowingPlaceholder(p) {
  for (let n = p.parentNode; n && n.localName !== "body"; n = n.parentNode) {
    if (n.localName === "sdt") {
      const pr = kid(n, "sdtPr");
      return !!(pr && kid(pr, "showingPlcHdr"));
    }
  }
  return false;
}

function docxRawRunProps(p) {
  const find = (el) => {
    for (const c of kids(el)) {
      if (c.localName === "r" && kids(c, "t").some((t) => t.textContent)) return kid(c, "rPr");
      if (["hyperlink", "ins", "smartTag", "sdt", "sdtContent", "customXml", "fldSimple"].includes(c.localName)) {
        const x = find(c);
        if (x !== undefined) return x;
      }
    }
    return undefined;
  };
  const r = find(p);
  if (r !== undefined) return r;
  const pPr = kid(p, "pPr");
  const mark = pPr && kid(pPr, "rPr");
  if (!mark) return null;
  // 문단 기호 전용 표시(삽입·삭제 기록 등)는 빼고 쓴다
  const rPr = mark.cloneNode(true);
  for (const c of kids(rPr)) if (["ins", "del", "moveFrom", "moveTo"].includes(c.localName)) rPr.removeChild(c);
  return rPr;
}

// 문단 p 의 글자를 lines 로 바꾼다. 둘째 줄부터는 같은 모양의 문단을 p 뒤에 만든다.
function docxSetParagraph(p, lines) {
  const doc = p.ownerDocument;
  const { rPr, restyled } = docxRunProps(p);
  for (const c of kids(p)) if (!["pPr", "bookmarkStart", "bookmarkEnd"].includes(c.localName)) p.removeChild(c);
  if (lines[0]) p.appendChild(docxRun(doc, rPr, lines[0]));
  let after = p;
  for (const line of lines.slice(1)) {
    const np = doc.createElementNS(W, "w:p");
    const pPr = kid(p, "pPr");
    if (pPr) np.appendChild(pPr.cloneNode(true));
    if (line) np.appendChild(docxRun(doc, rPr, line));
    after.parentNode.insertBefore(np, after.nextSibling);
    after = np;
  }
  // 안내 문구 보이는 중이던 내용 컨트롤은 이제 실제 내용이다
  for (let n = p.parentNode; n && n.localName !== "body"; n = n.parentNode) {
    if (n.localName === "sdt") {
      const pr = kid(n, "sdtPr");
      const ph = pr && kid(pr, "showingPlcHdr");
      if (ph) pr.removeChild(ph);
      break;
    }
  }
  return restyled;
}

// ---------- 한글(.hwpx) ----------

const HP = "http://www.hancom.co.kr/hwpml/2011/paragraph";
const TEXT_RUN_KIDS = new Set(["t", "ctrl", "secPr"]); // 이것만 있는 문단은 글자 칸으로 본다

function hwpxTText(t, out) {
  for (let n = t.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 || n.nodeType === 4) out.push(n.nodeValue);
    else if (isEl(n)) {
      if (n.localName === "tab") out.push("\t");
      else if (n.localName === "lineBreak") out.push("\n");
      else if (n.localName === "nbSpace" || n.localName === "fwSpace") out.push(" ");
      else if (n.localName === "hyphen") out.push("-");
    }
  }
}

function hwpxParaText(p) {
  const out = [];
  for (const r of kids(p, "run")) for (const t of kids(r, "t")) hwpxTText(t, out);
  return out.join("");
}

// 문단 안의 그림·도형·표 같은 개체 (있으면 글자 칸이 아니다)
function hwpxObjects(p) {
  const out = [];
  for (const r of kids(p, "run")) for (const c of kids(r)) if (!TEXT_RUN_KIDS.has(c.localName)) out.push(c);
  return out;
}

function walkHwpx(docs, model, styleNames) {
  const table = (tbl) => {
    const tId = `t${++model.tables}`;
    const grid = new Map();
    const cells = [];
    for (const tr of kids(tbl, "tr")) {
      for (const tc of kids(tr, "tc")) {
        const addr = kid(tc, "cellAddr");
        const r = parseInt(addr && addr.getAttribute("rowAddr"), 10) || 0;
        const c = parseInt(addr && addr.getAttribute("colAddr"), 10) || 0;
        const sub = kid(tc, "subList");
        const paras = sub ? kids(sub, "p") : [];
        const nested = [];
        for (const p of paras) for (const o of hwpxObjects(p)) if (o.localName === "tbl") nested.push(o);
        const text = paras.map(hwpxParaText).join("\n");
        grid.set(`${r}:${c}`, text);
        if (nested.length) nested.forEach(table);
        else if (paras.length && paras.every((p) => !hwpxObjects(p).length)) cells.push({ id: `${tId}.r${r + 1}.c${c + 1}`, r, c, text, node: { kind: "hwpx-cell", sub, paras } });
      }
    }
    for (const cell of cells) model.slots.push({ ...cell, kind: "cell", table: tId, labels: labelsFor(grid, cell.r, cell.c) });
  };
  for (const doc of docs) {
    for (const p of kids(doc.documentElement, "p")) {
      const objs = hwpxObjects(p);
      if (objs.length) {
        for (const o of objs) if (o.localName === "tbl") table(o);
        continue; // 그림·도형이 있는 문단은 건드리지 않는다
      }
      const style = styleNames.get(p.getAttribute("styleIDRef")) || "";
      model.slots.push({ id: `p${++model.paras}`, kind: "paragraph", text: hwpxParaText(p), style, node: { kind: "hwpx-p", p } });
    }
  }
}

function hwpxRun(doc, charPr, text) {
  const run = doc.createElementNS(HP, "hp:run");
  run.setAttribute("charPrIDRef", charPr);
  const t = doc.createElementNS(HP, "hp:t");
  if (text) t.appendChild(doc.createTextNode(text.replace(/\t/g, "    ")));
  run.appendChild(t);
  return run;
}

// header.xml 의 글자 모양(색·기울임)과 스타일별 기본 글자 모양
function hwpxHeaderInfo(headerXml) {
  const info = { charPr: new Map(), styleChar: new Map(), styleName: new Map() };
  if (!headerXml) return info;
  let doc;
  try {
    doc = parseXml(headerXml);
  } catch {
    return info;
  }
  const all = (el, name, out = []) => {
    for (const c of kids(el)) {
      if (c.localName === name) out.push(c);
      else all(c, name, out);
    }
    return out;
  };
  for (const c of all(doc.documentElement, "charPr")) info.charPr.set(c.getAttribute("id"), { color: c.getAttribute("textColor"), italic: !!kid(c, "italic") });
  for (const st of all(doc.documentElement, "style")) {
    info.styleChar.set(st.getAttribute("id"), st.getAttribute("charPrIDRef") || "0");
    info.styleName.set(st.getAttribute("id"), st.getAttribute("name") || "");
  }
  return info;
}

// 글자를 넣을 자리가 누름틀(CLICK_HERE) 안인지
function hwpxInClickHere(p, run) {
  let open = false;
  for (const r of kids(p, "run")) {
    if (r === run) return open;
    for (const ctrl of kids(r, "ctrl")) {
      for (const c of kids(ctrl)) {
        if (c.localName === "fieldBegin" && c.getAttribute("type") === "CLICK_HERE") open = true;
        if (c.localName === "fieldEnd") open = false;
      }
    }
  }
  return false;
}

function hwpxSetParagraph(p, lines, header) {
  const doc = p.ownerDocument;
  const runs = kids(p, "run");
  const hasText = (t) => {
    const o = [];
    hwpxTText(t, o);
    return o.join("") !== "";
  };
  const textRun = runs.find((r) => kids(r, "t").some(hasText)) || null;
  let charPr = (textRun || runs[0])?.getAttribute("charPrIDRef") || "0";
  // 안내 문구(회색·기울임 색 글자, 누름틀 안내)였으면 그 문단 스타일의 기본 글자 모양으로 쓴다
  const cp = header && header.charPr.get(charPr);
  const guide = (textRun && hwpxInClickHere(p, textRun) && cp && (cp.italic || isGuideColor(cp.color, true))) || (cp && isGuideColor(cp.color, cp.italic));
  let restyled = false;
  if (guide && header) {
    charPr = header.styleChar.get(p.getAttribute("styleIDRef") || "0") || "0";
    restyled = true;
  }
  // 새 글자를 넣을 자리: 원래 글자가 있던 첫 런 자리 (누름틀·하이퍼링크 안쪽이면 그 안에 그대로 들어간다)
  const anchor = textRun ? textRun.nextSibling : null;
  for (const r of runs) {
    for (const t of kids(r, "t")) r.removeChild(t);
    if (!kids(r).length) r.parentNode.removeChild(r);
  }
  const fresh = hwpxRun(doc, charPr, lines[0]);
  if (anchor && anchor.parentNode === p) p.insertBefore(fresh, anchor);
  else {
    const seg = kid(p, "linesegarray");
    const lastRun = kids(p, "run").pop();
    if (lastRun) p.insertBefore(fresh, lastRun.nextSibling);
    else if (seg) p.insertBefore(fresh, seg);
    else p.appendChild(fresh);
  }
  // 줄 배치 정보는 글자가 바뀌면 맞지 않으므로 지운다 (한글이 열 때 다시 계산한다)
  for (const seg of kids(p, "linesegarray")) p.removeChild(seg);
  let after = p;
  for (const line of lines.slice(1)) {
    const np = doc.createElementNS(HP, "hp:p");
    for (let i = 0; i < p.attributes.length; i++) np.setAttribute(p.attributes[i].name, p.attributes[i].value);
    np.setAttribute("pageBreak", "0");
    np.setAttribute("columnBreak", "0");
    np.appendChild(hwpxRun(doc, charPr, line));
    after.parentNode.insertBefore(np, after.nextSibling);
    after = np;
  }
  return restyled;
}

// ---------- 표 제목 찾기 ----------

// 같은 행 왼쪽에서 가장 가까운 글자 있는 칸, 같은 열 맨 위 칸
function labelsFor(grid, r, c) {
  const out = {};
  for (let cc = c - 1; cc >= 0; cc--) {
    const t = (grid.get(`${r}:${cc}`) || "").trim();
    if (t) {
      out.row = clip(t.replace(/\s+/g, " "), 60);
      break;
    }
  }
  const first = c > 0 ? (grid.get(`${r}:0`) || "").trim().replace(/\s+/g, " ") : "";
  if (first && clip(first, 60) !== out.row) out.header = clip(first, 60);
  if (r > 0) {
    const t = (grid.get(`0:${c}`) || "").trim();
    if (t) out.column = clip(t.replace(/\s+/g, " "), 60);
  }
  return out;
}

// ---------- 열기 / 보여 주기 / 채우기 ----------

async function load(buf, ext) {
  ext = ext.toLowerCase();
  if (!FORM_EXTS.includes(ext)) throw new Error(unsupportedMessage(ext));
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error("파일을 열 수 없습니다 (손상되었거나 암호가 걸린 파일일 수 있습니다)");
  }
  const model = { ext, zip, parts: [], slots: [], paras: 0, tables: 0 };
  if (ext === ".docx") {
    const f = zip.file("word/document.xml");
    if (!f) throw new Error("워드 문서 본문(word/document.xml)이 없습니다");
    const doc = parseXml(await f.async("string"));
    model.parts.push({ name: "word/document.xml", doc });
    walkDocx(doc, model);
  } else {
    const names = Object.keys(zip.files)
      .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (!names.length) throw new Error("한글 문서 본문(Contents/section0.xml)이 없습니다");
    const header = zip.file("Contents/header.xml");
    model.header = hwpxHeaderInfo(header ? await header.async("string") : "");
    const styleNames = model.header.styleName;
    for (const n of names) {
      const doc = parseXml(await zip.file(n).async("string"));
      model.parts.push({ name: n, doc });
    }
    walkHwpx(model.parts.map((p) => p.doc), model, styleNames);
  }
  // 기본 스타일 이름은 굳이 보여 주지 않는다
  for (const s of model.slots) if (/^(바탕글|Normal|본문|Body)$/i.test(s.style || "")) s.style = "";
  return model;
}

function unsupportedMessage(ext) {
  if (ext === ".hwp") return "한글 .hwp 파일은 직접 채울 수 없습니다. 한글에서 이 파일을 열고 '다른 이름으로 저장 → 파일 형식: 한글 표준 문서(*.hwpx)'로 저장한 뒤, 그 .hwpx 파일로 다시 시도해 주세요.";
  if (ext === ".doc") return "옛 워드 .doc 파일은 직접 채울 수 없습니다. 워드에서 '다른 이름으로 저장 → Word 문서(*.docx)'로 저장한 뒤 다시 시도해 주세요.";
  return `이 형식(${ext || "확장자 없음"})은 양식 채우기를 지원하지 않습니다. 워드(.docx)나 한글(.hwpx) 파일만 됩니다.`;
}

/**
 * 양식의 칸 목록. offset/limit 로 나눠 볼 수 있다.
 * 결과: { format, total, slots: [{ id, kind, text, empty, style?, table?, row_label?, column_label? }], next_offset }
 */
async function inspectForm(buf, ext, { offset = 0, limit = 300 } = {}) {
  const m = await load(buf, ext);
  const page = m.slots.slice(offset, offset + limit).map((s) => {
    const o = { id: s.id, kind: s.kind === "cell" ? "표 칸" : "문단", text: clip(s.text), empty: !s.text.trim() || undefined };
    if (s.text.length > 300) o.text_truncated = true;
    if (s.style) o.style = s.style;
    if (s.labels && s.labels.row) o.row_label = s.labels.row;
    if (s.labels && s.labels.header) o.row_header = s.labels.header;
    if (s.labels && s.labels.column) o.column_label = s.labels.column;
    return o;
  });
  return {
    format: m.ext === ".docx" ? "워드(.docx)" : "한글(.hwpx)",
    paragraphs: m.paras,
    tables: m.tables,
    total: m.slots.length,
    slots: page,
    next_offset: offset + limit < m.slots.length ? offset + limit : null,
  };
}

/**
 * fills: [{ id, text }] 대로 바꾼 새 파일 내용. 없는 칸 번호가 하나라도 있으면 아무것도 바꾸지 않고 오류.
 * 결과: { buffer, filled, restyled: 안내 문구 모양(회색·기울임)이라 보통 글자 모양으로 바꿔 쓴 칸들 }
 */
async function fillForm(buf, ext, fills) {
  if (!Array.isArray(fills) || !fills.length) throw new Error("바꿀 칸이 없습니다");
  if (fills.length > MAX_FILLS) throw new Error(`한 번에 바꿀 수 있는 칸은 ${MAX_FILLS}개까지입니다`);
  const m = await load(buf, ext);
  const byId = new Map(m.slots.map((s) => [s.id, s]));
  const seen = new Set();
  const missing = [];
  for (const f of fills) {
    if (!f || typeof f.id !== "string") throw new Error("칸마다 id 와 text 가 필요합니다");
    if (typeof f.text !== "string") throw new Error(`${f.id}: text 가 필요합니다`);
    if (f.text.length > MAX_TEXT) throw new Error(`${f.id}: 칸 하나에 ${MAX_TEXT}자까지 넣을 수 있습니다`);
    if (seen.has(f.id)) throw new Error(`${f.id}: 같은 칸을 두 번 바꾸려고 했습니다`);
    seen.add(f.id);
    if (!byId.has(f.id)) missing.push(f.id);
  }
  if (missing.length) throw new Error(`없는 칸 번호입니다: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""} (inspect_form 으로 다시 확인해 주세요)`);

  const restyled = [];
  for (const f of fills) {
    const lines = f.text.replace(/\r\n?/g, "\n").split("\n");
    const n = byId.get(f.id).node;
    let r;
    if (n.kind === "docx-p") r = docxSetParagraph(n.p, lines);
    else if (n.kind === "hwpx-p") r = hwpxSetParagraph(n.p, lines, m.header);
    else {
      // 표 칸: 첫 문단을 본으로 남기고 나머지 문단은 지운 뒤 채운다
      const [first, ...rest] = n.paras;
      for (const p of rest) p.parentNode.removeChild(p);
      r = n.kind === "docx-cell" ? docxSetParagraph(first, lines) : hwpxSetParagraph(first, lines, m.header);
    }
    if (r) restyled.push(f.id);
  }

  const ser = new XMLSerializer();
  for (const part of m.parts) m.zip.file(part.name, ser.serializeToString(part.doc));
  if (m.ext === ".hwpx" && m.zip.file("mimetype")) {
    // hwpx 는 mimetype 이 압축 없이 맨 앞에 있어야 한다 (자리는 그대로 두고 압축만 끈다)
    m.zip.file("mimetype", await m.zip.file("mimetype").async("string"), { compression: "STORE" });
  }
  const buffer = await m.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { buffer, filled: fills.length, restyled };
}

module.exports = { FORM_EXTS, inspectForm, fillForm, unsupportedMessage };
