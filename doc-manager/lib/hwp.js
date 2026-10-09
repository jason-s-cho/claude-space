// 한글(.hwp, HWP 5.0) 문서에서 글자를 뽑는다. (한컴 공개 문서 'HWP 5.0 파일 형식' 기준)
//
// .hwp 는 OLE(복합 문서) 안에 여러 스트림이 들어 있다.
//   FileHeader          : 압축·암호·배포용 여부
//   BodyText/Section0.. : 본문. 보통 deflate 로 압축되어 있고, 그 안은 '레코드'의 연속
//   PrvText             : 한컴이 저장해 둔 미리보기 글자(앞부분 약 1천 자)
// 본문 레코드 중 PARA_TEXT(문단 글자)만 모아서 UTF-16 글자로 바꾼다.
// 암호가 걸렸거나 배포용 문서는 본문이 암호화되어 있으므로 미리보기 글자만 쓴다.
const zlib = require("zlib");
const CFB = require("cfb");

const HWPTAG_PARA_TEXT = 0x10 + 51;

function streamOf(cfb, name) {
  const e = CFB.find(cfb, name);
  return e && e.content ? Buffer.from(e.content) : null;
}

function readHeader(cfb) {
  const buf = streamOf(cfb, "FileHeader");
  if (!buf || buf.length < 40) throw new Error("한글 문서가 아닙니다");
  const sig = buf.toString("latin1", 0, 17);
  if (sig !== "HWP Document File") throw new Error("한글 문서가 아닙니다");
  const flags = buf.readUInt32LE(36);
  return { compressed: !!(flags & 1), encrypted: !!(flags & 2), distribution: !!(flags & 4) };
}

// 문단 글자(UTF-16LE). 32 미만의 코드는 '제어 문자'로, 종류에 따라 1글자 또는 8글자(16바이트)를 차지한다.
//   한 글자짜리: 0, 10(줄 바꿈), 13(문단 끝), 24~31
//   여덟 글자짜리: 나머지 (9 = 탭, 표·그림 같은 개체 자리 등)
function decodeParaText(buf, start, end) {
  let out = "";
  for (let i = start; i + 1 < end; ) {
    const c = buf.readUInt16LE(i);
    if (c >= 32) {
      out += String.fromCharCode(c);
      i += 2;
      continue;
    }
    if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) {
      if (c === 10 || c === 13) out += "\n";
      else if (c === 24) out += "-";
      else if (c >= 30) out += " ";
      i += 2;
    } else {
      if (c === 9) out += "\t";
      i += 16;
    }
  }
  return out;
}

function textFromSection(data) {
  const parts = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const h = data.readUInt32LE(pos);
    pos += 4;
    const tag = h & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (pos + 4 > data.length) break;
      size = data.readUInt32LE(pos);
      pos += 4;
    }
    const end = Math.min(pos + size, data.length);
    if (tag === HWPTAG_PARA_TEXT) parts.push(decodeParaText(data, pos, end));
    pos = end;
  }
  return parts.join("");
}

function inflate(buf) {
  try {
    return zlib.inflateRawSync(buf);
  } catch {
    return zlib.inflateSync(buf); // 드물게 zlib 머리말이 붙은 경우
  }
}

// 본문 구역 스트림들의 전체 경로 (Section0, Section1, … 순서). CFB.find 는 전체 경로나 이름만 받는다.
function sectionPaths(cfb) {
  return cfb.FullPaths
    .map((p) => ({ p, n: (p.match(/\/BodyText\/Section(\d+)$/) || [])[1] }))
    .filter((x) => x.n !== undefined)
    .sort((a, b) => Number(a.n) - Number(b.n))
    .map((x) => x.p);
}

function previewText(cfb) {
  const buf = streamOf(cfb, "PrvText");
  if (!buf) return "";
  // 미리보기는 표 칸을 <...> 로 감싸 두므로 꺾쇠를 뗀다
  return buf.toString("utf16le").replace(/\0+$/, "").replace(/[<>]/g, " ");
}

/**
 * buf: .hwp 파일 내용
 * 결과: { text, title, author, protected }  — protected 면 미리보기 글자만 들어 있다
 */
function extractHwp(buf) {
  let cfb;
  try {
    cfb = CFB.read(buf, { type: "buffer" });
  } catch {
    // HWP 3.0 같은 옛 형식은 OLE 가 아니다: 파일 이름으로만 분류
    throw new Error("읽을 수 없는 한글 형식입니다 (HWP 3.0 이전 문서일 수 있음)");
  }
  const head = readHeader(cfb);
  if (head.encrypted || head.distribution) {
    return { text: previewText(cfb), protected: true };
  }
  const parts = [];
  for (const name of sectionPaths(cfb)) {
    const raw = streamOf(cfb, name);
    if (!raw) continue;
    try {
      parts.push(textFromSection(head.compressed ? inflate(raw) : raw));
    } catch {
      // 한 구역이 깨져도 나머지는 읽는다
    }
  }
  let text = parts.join("\n");
  if (!text.trim()) text = previewText(cfb);
  return { text, protected: false };
}

module.exports = { extractHwp, decodeParaText };
