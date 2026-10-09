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
    const info = { kind: "docx", tbl, rows: new Map() };
    model.tableInfo.set(tId, info);
    kids(tbl, "tr").forEach((tr, ri) => {
      let col = 0;
      const row = { tr, cells: [], vmerge: false };
      info.rows.set(ri, row);
      docxCells(tr).forEach((tc, tcIndex) => {
        const tcPr = kid(tc, "tcPr");
        const span = parseInt(wAttr(tcPr && kid(tcPr, "gridSpan"), "val"), 10) || 1;
        const vm = tcPr && kid(tcPr, "vMerge");
        if (vm) row.vmerge = true;
        const cont = vm && wAttr(vm, "val") !== "restart";
        if (!cont) {
          const blocks = docxBlocks(tc);
          const nested = blocks.filter((b) => b.localName === "tbl");
          const paras = blocks.filter((b) => b.localName === "p");
          const text = paras.map(docxParaText).join("\n");
          grid.set(`${ri}:${col}`, text);
          if (nested.length) nested.forEach(table);
          else {
            cells.push({ id: `${tId}.r${ri + 1}.c${col + 1}`, r: ri, c: col, text, node: { kind: "docx-cell", tc, paras } });
            row.cells.push({ tcIndex, id: `${tId}.r${ri + 1}.c${col + 1}` });
          }
        }
        col += span;
      });
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
    const info = { kind: "hwpx", tbl, rows: new Map(), spans: [] };
    model.tableInfo.set(tId, info);
    for (const tr of kids(tbl, "tr")) {
      kids(tr, "tc").forEach((tc, tcIndex) => {
        const addr = kid(tc, "cellAddr");
        const r = parseInt(addr && addr.getAttribute("rowAddr"), 10) || 0;
        const c = parseInt(addr && addr.getAttribute("colAddr"), 10) || 0;
        const spanEl = kid(tc, "cellSpan");
        const rowSpan = parseInt(spanEl && spanEl.getAttribute("rowSpan"), 10) || 1;
        info.spans.push({ r, rowSpan });
        if (!info.rows.has(r)) info.rows.set(r, { tr, cells: [], vmerge: false });
        const row = info.rows.get(r);
        if (rowSpan > 1) row.vmerge = true;
        const sub = kid(tc, "subList");
        const paras = sub ? kids(sub, "p") : [];
        const nested = [];
        for (const p of paras) for (const o of hwpxObjects(p)) if (o.localName === "tbl") nested.push(o);
        const text = paras.map(hwpxParaText).join("\n");
        grid.set(`${r}:${c}`, text);
        if (nested.length) nested.forEach(table);
        else if (paras.length && paras.every((p) => !hwpxObjects(p).length)) {
          cells.push({ id: `${tId}.r${r + 1}.c${c + 1}`, r, c, text, node: { kind: "hwpx-cell", sub, paras } });
          row.cells.push({ tcIndex, id: `${tId}.r${r + 1}.c${c + 1}` });
        }
      });
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
  const model = { ext, zip, parts: [], slots: [], paras: 0, tables: 0, tableInfo: new Map() };
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
  // 표마다 행 수와 첫 행(제목) — 행을 늘릴 때 어느 행을 본으로 쓸지 고르는 데 쓴다
  const slotText = new Map(m.slots.map((s) => [s.id, s.text]));
  const tables = [...m.tableInfo.entries()].map(([id, info]) => {
    const first = info.rows.get(0);
    return {
      id,
      rows: info.rows.size,
      first_row: first ? clip(first.cells.map((c) => (slotText.get(c.id) || "").replace(/\s+/g, " ").trim()).join(" | "), 160) : "",
      rows_not_copyable: [...info.rows.entries()].filter(([ri, r]) => r.vmerge || (info.kind === "hwpx" && info.spans.some((sp) => sp.r < ri && sp.r + sp.rowSpan - 1 >= ri))).map(([ri]) => ri + 1),
    };
  });
  return {
    format: m.ext === ".docx" ? "워드(.docx)" : "한글(.hwpx)",
    paragraphs: m.paras,
    tables: m.tables,
    table_list: tables.length ? tables : undefined,
    total: m.slots.length,
    slots: page,
    next_offset: offset + limit < m.slots.length ? offset + limit : null,
  };
}

// 표 칸(tc) 하나를 lines 로 채운다
function setCell(kind, tc, lines, header) {
  if (kind === "docx") {
    const paras = docxBlocks(tc).filter((b) => b.localName === "p");
    if (!paras.length) return false;
    const [first, ...rest] = paras;
    for (const p of rest) p.parentNode.removeChild(p);
    return docxSetParagraph(first, lines);
  }
  const sub = kid(tc, "subList");
  const paras = sub ? kids(sub, "p") : [];
  if (!paras.length) return false;
  const [first, ...rest] = paras;
  for (const p of rest) p.parentNode.removeChild(p);
  return hwpxSetParagraph(first, lines, header);
}

const toLines = (text) => String(text).replace(/\r\n?/g, "\n").split("\n");

// ---------- 체크 표시 (□ → ■) ----------

const CHECK = { "□": "■", "☐": "☑", "○": "●", "◯": "●", "❏": "■", "▢": "▣" };
const UNCHECK = { "■": "□", "☑": "☐", "☒": "☐", "●": "○", "▣": "▢", "◼": "□" };
const BOXES = new Set([...Object.keys(CHECK), ...Object.keys(UNCHECK)]);

// 칸 안의 글자 조각(Text 노드)들을 순서대로
function slotTextNodes(node) {
  const out = [];
  const visit = (el) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) {
        if (el.localName === "t") out.push(n);
      } else if (isEl(n) && n.localName !== "delText" && n.localName !== "instrText") visit(n);
    }
  };
  if (node.kind === "docx-p" || node.kind === "hwpx-p") visit(node.p);
  else for (const p of node.paras) visit(p);
  return out;
}

/**
 * 칸 안에서 label 바로 앞의 네모(□)를 채운다(check) / 비운다(uncheck). 글자 모양은 그대로 둔다.
 * 예: "□ 해당  □ 미해당" 에서 check "해당" → "■ 해당  □ 미해당"
 */
function setCheck(node, label, on) {
  const nodes = slotTextNodes(node);
  let all = "";
  const spans = nodes.map((n) => {
    const start = all.length;
    all += n.data;
    return { n, start };
  });
  // label 이 여러 번 나오면 바로 앞에 네모가 있는 첫 자리 ("해당" 이 "미해당" 안에도 있으므로)
  let from = 0;
  while (true) {
    const at = all.indexOf(label, from);
    if (at < 0) throw new Error(`'${label}' 앞에 네모(□)가 있는 곳을 찾지 못했습니다`);
    let i = at - 1;
    while (i >= 0 && /\s/.test(all[i])) i--;
    if (i >= 0 && BOXES.has(all[i]) && (at === 0 || !/[가-힣A-Za-z0-9]/.test(all[at - 1]) || BOXES.has(all[at - 1]))) {
      const map = on ? CHECK : UNCHECK;
      const ch = all[i];
      const next = map[ch] || ch; // 이미 그 상태면 그대로
      const span = spans.filter((s) => s.start <= i).pop();
      const off = i - span.start;
      const v = span.n.data.slice(0, off) + next + span.n.data.slice(off + 1);
      span.n.data = v; // xmldom 은 data 를 저장한다 (nodeValue 만 바꾸면 반영되지 않음)
      span.n.nodeValue = v;
      docxSyncCheckbox(span.n, on);
      return;
    }
    from = at + 1;
  }
}

// 워드 체크 상자 컨트롤(w14:checkbox)이면 체크 값도 맞춘다
function docxSyncCheckbox(textNode, on) {
  for (let n = textNode.parentNode; n && n.localName !== "body"; n = n.parentNode) {
    if (n.localName !== "sdt") continue;
    const pr = kid(n, "sdtPr");
    const box = pr && kids(pr).find((c) => c.localName === "checkbox");
    const checked = box && kid(box, "checked");
    if (checked) checked.setAttribute(checked.prefix ? checked.prefix + ":val" : "val", on ? "1" : "0");
    return;
  }
}

// ---------- 표 행 늘리기 ----------

/**
 * template_row 행을 본으로 rows 만큼 채운다: 첫 값 묶음은 그 행에, 나머지는 그 행을 복사해 바로 아래에 넣는다.
 * 값은 그 행의 칸(합친 칸은 하나)에 왼쪽부터 차례로 들어간다. 복사한 행에서 값을 주지 않은 칸은 비운다.
 */
function addTableRows(m, op, header) {
  const info = m.tableInfo.get(op.table);
  if (!info) throw new Error(`없는 표입니다: ${op.table}`);
  const ri = op.template_row - 1;
  const row = info.rows.get(ri);
  if (!row) throw new Error(`${op.table} 에 ${op.template_row}행이 없습니다`);
  if (!row.cells.length) throw new Error(`${op.table} ${op.template_row}행에는 채울 칸이 없습니다`);
  if (row.vmerge) throw new Error(`${op.table} ${op.template_row}행에는 세로로 합친 칸이 있어 복사할 수 없습니다. 합친 칸이 없는 행을 본으로 고르세요`);
  if (info.kind === "hwpx" && info.spans.some((sp) => sp.r < ri && sp.r + sp.rowSpan - 1 >= ri)) throw new Error(`${op.table} ${op.template_row}행은 위쪽 칸과 세로로 합쳐져 있어 복사할 수 없습니다`);
  for (const vals of op.rows) if (vals.length > row.cells.length) throw new Error(`${op.table} ${op.template_row}행의 칸은 ${row.cells.length}개인데 값이 ${vals.length}개입니다`);

  const cellsOf = (tr) => (info.kind === "docx" ? docxCells(tr) : kids(tr, "tc"));
  const original = row.tr.cloneNode(true); // 채우기 전 모양 그대로 복사해 둔다
  const restyled = [];
  const fillRow = (tr, vals, clearRest) => {
    const tcs = cellsOf(tr);
    row.cells.forEach((cell, k) => {
      if (k < vals.length) {
        if (setCell(info.kind, tcs[cell.tcIndex], toLines(vals[k]), header)) restyled.push(cell.id);
      } else if (clearRest) setCell(info.kind, tcs[cell.tcIndex], [""], header);
    });
  };
  fillRow(row.tr, op.rows[0], false);
  const added = op.rows.length - 1;
  let after = row.tr;
  op.rows.slice(1).forEach((vals, k) => {
    const tr = original.cloneNode(true);
    after.parentNode.insertBefore(tr, after.nextSibling);
    after = tr;
    if (info.kind === "hwpx") for (const tc of kids(tr, "tc")) kid(tc, "cellAddr").setAttribute("rowAddr", String(ri + 1 + k));
    fillRow(tr, vals, true);
  });
  if (info.kind === "hwpx" && added) {
    // 아래 행들의 행 번호를 밀고, 표의 행 수와 높이를 늘린다
    for (let t = after.nextSibling; t; t = t.nextSibling) {
      if (!isEl(t) || t.localName !== "tr") continue;
      for (const tc of kids(t, "tc")) {
        const a = kid(tc, "cellAddr");
        a.setAttribute("rowAddr", String((parseInt(a.getAttribute("rowAddr"), 10) || 0) + added));
      }
    }
    const tbl = info.tbl;
    tbl.setAttribute("rowCnt", String((parseInt(tbl.getAttribute("rowCnt"), 10) || 0) + added));
    const rowH = Math.max(0, ...kids(row.tr, "tc").map((tc) => parseInt((kid(tc, "cellSz") || { getAttribute: () => 0 }).getAttribute("height"), 10) || 0));
    const sz = kid(tbl, "sz");
    if (sz && rowH) sz.setAttribute("height", String((parseInt(sz.getAttribute("height"), 10) || 0) + rowH * added));
  }
  return { added, restyled };
}

/**
 * fills: [{ id, text }] 대로 바꾼 새 파일 내용. 없는 칸 번호가 하나라도 있으면 아무것도 바꾸지 않고 오류.
 * 결과: { buffer, filled, restyled: 안내 문구 모양(회색·기울임)이라 보통 글자 모양으로 바꿔 쓴 칸들 }
 */
async function fillForm(buf, ext, fills = [], { tableRows = [] } = {}) {
  fills = fills || [];
  tableRows = tableRows || [];
  if (!fills.length && !tableRows.length) throw new Error("바꿀 칸이 없습니다");
  if (fills.length > MAX_FILLS) throw new Error(`한 번에 바꿀 수 있는 칸은 ${MAX_FILLS}개까지입니다`);
  const m = await load(buf, ext);
  const byId = new Map(m.slots.map((s) => [s.id, s]));
  const seen = new Set();
  const missing = [];
  for (const f of fills) {
    if (!f || typeof f.id !== "string") throw new Error("칸마다 id 와 text(또는 check/uncheck)가 필요합니다");
    const modes = ["text", "check", "uncheck"].filter((k) => f[k] !== undefined && f[k] !== null);
    if (modes.length !== 1) throw new Error(`${f.id}: text, check, uncheck 중 하나만 주세요`);
    if (f.text !== undefined && f.text !== null && typeof f.text !== "string") throw new Error(`${f.id}: text 는 글자여야 합니다`);
    if (typeof f.text === "string" && f.text.length > MAX_TEXT) throw new Error(`${f.id}: 칸 하나에 ${MAX_TEXT}자까지 넣을 수 있습니다`);
    if (seen.has(f.id)) throw new Error(`${f.id}: 같은 칸을 두 번 바꾸려고 했습니다 (체크 여러 개는 check 에 목록으로)`);
    seen.add(f.id);
    if (!byId.has(f.id)) missing.push(f.id);
  }
  if (missing.length) throw new Error(`없는 칸 번호입니다: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""} (inspect_form 으로 다시 확인해 주세요)`);
  // 표 행 늘리기 확인: 같은 행을 칸 채우기와 함께 바꾸면 헷갈리므로 막는다
  const rowKeys = new Set();
  for (const op of tableRows) {
    if (!op || typeof op.table !== "string" || !Number.isInteger(op.template_row) || !Array.isArray(op.rows) || !op.rows.length) throw new Error("표 행 채우기에는 table, template_row, rows 가 필요합니다");
    if (op.rows.length > 500) throw new Error("표 행은 한 번에 500줄까지 넣을 수 있습니다");
    for (const vals of op.rows) if (!Array.isArray(vals) || vals.some((v) => typeof v !== "string" || v.length > MAX_TEXT)) throw new Error(`${op.table}: rows 는 글자 목록의 목록이어야 합니다`);
    const key = `${op.table}.r${op.template_row}`;
    if (rowKeys.has(key)) throw new Error(`${key}: 같은 행을 두 번 본으로 쓸 수 없습니다`);
    rowKeys.add(key);
    const clash = fills.find((f) => f.id.startsWith(key + ".c"));
    if (clash) throw new Error(`${clash.id}: 표 행 채우기(${key})와 같은 행입니다. 그 행의 값은 rows 에 넣어 주세요`);
  }

  const restyled = [];
  for (const f of fills) {
    const n = byId.get(f.id).node;
    if (f.check !== undefined || f.uncheck !== undefined) {
      const labels = [].concat(f.check !== undefined ? f.check : f.uncheck);
      for (const label of labels) {
        try {
          setCheck(n, String(label), f.check !== undefined);
        } catch (e) {
          throw new Error(`${f.id}: ${e.message}`);
        }
      }
      continue;
    }
    const lines = toLines(f.text);
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
  // 표 행: 아래쪽 행부터 처리해야 위쪽 행 번호가 그대로다
  let rowsAdded = 0;
  const ordered = [...tableRows].sort((a, b) => (a.table === b.table ? b.template_row - a.template_row : 0));
  for (const op of ordered) {
    const r = addTableRows(m, op, m.header);
    rowsAdded += r.added;
    restyled.push(...r.restyled);
  }

  const ser = new XMLSerializer();
  for (const part of m.parts) m.zip.file(part.name, ser.serializeToString(part.doc));
  if (m.ext === ".hwpx" && m.zip.file("mimetype")) {
    // hwpx 는 mimetype 이 압축 없이 맨 앞에 있어야 한다 (자리는 그대로 두고 압축만 끈다)
    m.zip.file("mimetype", await m.zip.file("mimetype").async("string"), { compression: "STORE" });
  }
  const buffer = await m.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { buffer, filled: fills.length, rows_added: rowsAdded, restyled };
}

module.exports = { FORM_EXTS, inspectForm, fillForm, unsupportedMessage };
