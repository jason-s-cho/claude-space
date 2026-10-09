// 문서 파일에서 검색·분류용 텍스트를 뽑아낸다.
// docx / pptx / xlsx / hwpx 는 zip 안의 XML 이라 jszip 으로 직접 읽고,
// pdf 는 pdf.js, 옛 .doc 은 word-extractor 를 쓴다.
// .ppt / .xls / .hwp 같은 옛 바이너리 형식은 본문을 읽지 않고 파일 이름만으로 분류한다.
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const MAX_TEXT = 30000; // 문서 하나당 보관할 최대 글자 수

const SUPPORTED = {
  ".docx": "word", ".doc": "word",
  ".pptx": "ppt", ".ppt": "ppt",
  ".xlsx": "excel", ".xls": "excel",
  ".pdf": "pdf",
  ".hwpx": "hwp", ".hwp": "hwp",
};

function fileKind(filePath) {
  return SUPPORTED[path.extname(filePath).toLowerCase()] || null;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// 지정한 태그(<a:t>, <w:t> 등) 안의 글자를 모으고, 문단 태그가 끝날 때 줄을 바꾼다.
function textFromXml(xml, textTag, paraTag) {
  const out = [];
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|</${paraTag}>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[1] !== undefined ? decodeXml(m[1]) : "\n");
  return out.join("");
}

function sortByNumber(names) {
  const num = (n) => Number((n.match(/(\d+)\.xml$/) || [0, 0])[1]);
  return names.sort((a, b) => num(a) - num(b));
}

function zipFiles(zip, re) {
  return sortByNumber(Object.keys(zip.files).filter((n) => re.test(n)));
}

async function readZipText(zip, names, textTag, paraTag) {
  const parts = [];
  for (const n of names) parts.push(textFromXml(await zip.file(n).async("string"), textTag, paraTag));
  return parts.join("\n");
}

// docProps/core.xml 의 제목·작성자
async function officeMeta(zip) {
  const f = zip.file("docProps/core.xml");
  if (!f) return {};
  const xml = await f.async("string");
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
    return m ? decodeXml(m[1]).trim() : "";
  };
  return { title: get("dc:title"), author: get("dc:creator") };
}

async function extractDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = zipFiles(zip, /^word\/(document|header\d*|footer\d*)\.xml$/);
  return { text: await readZipText(zip, names, "w:t", "w:p"), ...(await officeMeta(zip)) };
}

async function extractPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = zipFiles(zip, /^ppt\/slides\/slide\d+\.xml$/);
  const notes = zipFiles(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  const text = await readZipText(zip, [...slides, ...notes], "a:t", "a:p");
  return { text, pages: slides.length, ...(await officeMeta(zip)) };
}

async function extractXlsx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const parts = [];
  // 시트 이름
  const wb = zip.file("xl/workbook.xml");
  if (wb) {
    const xml = await wb.async("string");
    for (const m of xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) parts.push(decodeXml(m[1]));
  }
  // 대부분의 글자는 sharedStrings 에 있고, 일부는 시트 안에 inlineStr 로 들어 있다.
  const ss = zip.file("xl/sharedStrings.xml");
  if (ss) parts.push(textFromXml(await ss.async("string"), "t", "si"));
  for (const n of zipFiles(zip, /^xl\/worksheets\/sheet\d+\.xml$/)) {
    const xml = await zip.file(n).async("string");
    if (xml.includes("inlineStr")) parts.push(textFromXml(xml, "t", "is"));
  }
  return { text: parts.join("\n"), ...(await officeMeta(zip)) };
}

async function extractHwpx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = zipFiles(zip, /^Contents\/section\d+\.xml$/);
  return { text: await readZipText(zip, names, "hp:t", "hp:p") };
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

async function extractPdf(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const parts = [];
    let length = 0;
    for (let i = 1; i <= doc.numPages && length < MAX_TEXT; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) line += "\n";
      }
      parts.push(line);
      length += line.length;
      page.cleanup();
    }
    let title = "", author = "";
    try {
      const meta = await doc.getMetadata();
      title = (meta.info && meta.info.Title) || "";
      author = (meta.info && meta.info.Author) || "";
    } catch {}
    return { text: parts.join("\n"), pages: doc.numPages, title, author };
  } finally {
    await doc.destroy();
  }
}

async function extractDoc(filePath) {
  const WordExtractor = require("word-extractor");
  const d = await new WordExtractor().extract(filePath);
  return { text: [d.getBody(), d.getHeaders({ includeFooters: true })].join("\n") };
}

function tidy(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_TEXT);
}

// 결과: { kind, text, title, author, pages, error }
async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const kind = fileKind(filePath);
  const result = { kind, text: "", title: "", author: "", pages: 0, error: "" };
  if (!kind) return result;
  try {
    let r = {};
    if (ext === ".doc") r = await extractDoc(filePath);
    else if ([".ppt", ".xls", ".hwp"].includes(ext)) r = {};
    else {
      const buf = await fs.promises.readFile(filePath);
      if (ext === ".docx") r = await extractDocx(buf);
      else if (ext === ".pptx") r = await extractPptx(buf);
      else if (ext === ".xlsx") r = await extractXlsx(buf);
      else if (ext === ".hwpx") r = await extractHwpx(buf);
      else if (ext === ".pdf") r = await extractPdf(buf);
    }
    Object.assign(result, r);
    result.text = tidy(result.text);
  } catch (e) {
    // 암호가 걸렸거나 손상된 파일: 파일 이름만으로 분류한다.
    result.error = String((e && e.message) || e).slice(0, 200);
  }
  return result;
}

module.exports = { extract, fileKind, SUPPORTED, textFromXml };
