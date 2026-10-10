// 끌어다 놓은 파일을 문서 폴더에 복사하고 분류한다.
// 원본은 그대로 두고, 같은 이름이 있으면 덮어쓰지 않고 "이름 (2).docx" 로 저장한다.
// 내용까지 똑같은 파일이 이미 폴더에 있으면 복사하지 않는다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { extract, fileKind } = require("./extract");
const { classify, CATEGORIES } = require("./classify");
const indexer = require("./indexer");

// 윈도우에서 폴더 이름으로 쓸 수 없는 글자를 뺀다.
function safeName(s) {
  return s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "기타";
}

const names = (list) => new Set((list || []).map((p) => (typeof p === "string" ? p : p && p.name)).filter(Boolean));
const GOV = "국가과제·지원사업";

// 분류에 맞는 하위 폴더.
//   국가과제·지원사업/2024 K-방산 제품고도화/5 보고서   (등록한 과제면 과제 폴더 아래)
//   국가과제·지원사업/5 보고서                          (과제를 모를 때)
//   고객사·협력사/현대모비스
//   기술·시장 분석
function folderFor(category, tags, partners, projects) {
  const c = CATEGORIES.find((x) => x.id === category) || CATEGORIES.find((x) => x.id === "other");
  tags = tags || [];
  const parts = [];
  if (c.group === GOV) {
    parts.push(GOV);
    const project = tags.find((t) => names(projects).has(t));
    if (project) parts.push(project);
    parts.push(c.folder);
  } else {
    if (c.group) parts.push(c.group);
    parts.push(c.folder);
    if (category === "request") {
      const partner = tags.find((t) => names(partners).has(t));
      if (partner) parts.push(partner);
    }
  }
  return parts.map(safeName).join("/");
}

// 문서 폴더 안에 분류별 폴더를 만들어 둔다. 이미 있으면 그대로 두고, 파일은 옮기지 않는다.
// 결과: 새로 만든 폴더 수
function ensureCategoryFolders(root, partners, projects) {
  const dirs = CATEGORIES.map((c) => folderFor(c.id, [], []));
  for (const name of names(partners)) dirs.push(folderFor("request", [name], [name]));
  for (const name of names(projects)) {
    for (const c of CATEGORIES.filter((x) => x.group === GOV)) dirs.push(folderFor(c.id, [name], [], [name]));
  }
  let made = 0;
  for (const d of dirs) {
    const full = path.join(root, ...d.split("/"));
    if (fs.existsSync(full)) continue;
    try {
      fs.mkdirSync(full, { recursive: true });
      made++;
    } catch {}
  }
  return made;
}

// 예전 버전(0.1)이 만들어 둔 분류 폴더. 비어 있을 때만 지운다. (파일이 하나라도 있으면 그대로 둔다)
const LEGACY_FOLDERS = [
  "국가과제/수요조사서", "국가과제/과제계획서", "국가과제/과제보고서", "국가과제/기타 과제자료", "국가과제",
  "회사소개/IR 자료", "홍보/카탈로그", "대외/고객사·협력사 요청자료", "대외",
];

function removeLegacyFolders(root) {
  let removed = 0;
  const tryRemove = (full) => {
    try {
      fs.rmdirSync(full); // 비어 있지 않으면 실패한다
      removed++;
    } catch {}
  };
  for (const d of LEGACY_FOLDERS) {
    const full = path.join(root, ...d.split("/"));
    if (!fs.existsSync(full)) continue;
    // 고객사 하위 폴더(대외/고객사·협력사 요청자료/회사)도 비어 있으면 지운다
    if (d === "대외/고객사·협력사 요청자료") {
      try {
        for (const e of fs.readdirSync(full, { withFileTypes: true })) if (e.isDirectory()) tryRemove(path.join(full, e.name));
      } catch {}
    }
    tryRemove(full);
  }
  return removed;
}

// 이 문서가 들어가야 할 분류 폴더 (문서 폴더 기준 상대 경로)
function expectedFolder(category, tags, partners, projects) {
  return folderFor(category, tags || [], partners, projects);
}

// 지금 폴더가 분류 폴더이거나 그 아래 폴더면 제자리다 (분류 폴더 안에서 직접 나눠 둔 하위 폴더는 존중한다).
function isInPlace(dir, expected) {
  if (!expected) return true;
  return dir === expected || dir.startsWith(expected + "/");
}

/**
 * 여러 문서를 각자의 분류 폴더로 옮긴다. 하나가 실패해도 나머지는 계속한다.
 * folderOf(entry): 그 문서의 분류 폴더
 * 결과: { moved: [{ from, to }], failed: [{ rel, error }] }
 */
async function moveManyToFolders(index, rels, folderOf) {
  const moved = [], failed = [];
  for (const rel of rels) {
    const entry = index.files[rel];
    if (!entry) {
      failed.push({ rel, error: "알 수 없는 파일" });
      continue;
    }
    const folder = folderOf(entry);
    const dir = rel.split("/").slice(0, -1).join("/");
    if (isInPlace(dir, folder)) continue;
    try {
      moved.push({ from: rel, to: await moveToFolder(index, rel, folder) });
    } catch (e) {
      failed.push({ rel, error: String((e && e.message) || e) });
    }
  }
  return { moved, failed };
}

/**
 * 문서를 분류 폴더로 옮긴다. 같은 이름이 있으면 "이름 (2)"로.
 * 내가 고친 분류·태그·메모는 그대로 따라간다.
 * 결과: 새 상대 경로
 */
async function moveToFolder(index, rel, folder) {
  const root = index.root;
  const entry = index.files[rel];
  if (!entry) throw new Error("알 수 없는 파일");
  const src = path.join(root, ...rel.split("/"));
  const dir = path.join(root, ...folder.split("/"));
  if (!isInside(root, path.join(dir, "x"))) throw new Error("문서 폴더 밖으로는 옮길 수 없습니다");
  await fs.promises.mkdir(dir, { recursive: true });
  const { dest, duplicate } = await destinationFor(src, dir);
  if (duplicate) throw new Error("옮길 폴더에 같은 파일이 이미 있습니다");
  await fs.promises.rename(src, dest);
  const newRel = path.relative(root, dest).split(path.sep).join("/");
  delete index.files[rel];
  entry.rel = newRel;
  index.files[newRel] = entry;
  index.textDirty = true; // 본문 캐시는 경로로 찾으므로 다시 쓴다
  return newRel;
}

async function sameContent(a, b) {
  const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
  if (sa.size !== sb.size) return false;
  const hash = async (f) => crypto.createHash("sha1").update(await fs.promises.readFile(f)).digest("hex");
  return (await hash(a)) === (await hash(b));
}

// 같은 이름이 있으면 " (2)", " (3)" … 을 붙인다. 내용이 같은 파일이 있으면 그 경로를 돌려준다.
async function destinationFor(src, dir) {
  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? stem + ext : `${stem} (${i})${ext}`;
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) return { dest, duplicate: false };
    if (await sameContent(src, dest)) return { dest, duplicate: true };
  }
  throw new Error("같은 이름의 파일이 너무 많습니다");
}

// 놓은 것 중 폴더는 안의 문서 파일을 모두 꺼낸다.
async function expand(paths) {
  const files = [];
  const skipped = [];
  for (const p of paths) {
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      skipped.push({ name: path.basename(p), reason: "파일을 찾을 수 없음" });
      continue;
    }
    if (st.isDirectory()) {
      for (const f of await indexer.walk(p)) files.push(f.full);
    } else if (indexer.isTempName(path.basename(p))) {
      skipped.push({ name: path.basename(p), reason: "임시 파일" });
    } else if (!fileKind(p)) {
      skipped.push({ name: path.basename(p), reason: "지원하지 않는 형식" });
    } else files.push(p);
  }
  return { files, skipped };
}

function isInside(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * paths: 놓은 파일·폴더 경로
 * opts: { layout: "category" | "root", options: 분류 옵션, onProgress({ done, total, current }),
 *         folder: 넣을 폴더(문서 폴더 기준, 주면 분류와 상관없이 여기에), category: 이 분류로 정해 둔다(사용자가 고른 것처럼) }
 * 결과: { imported: [{ rel, category, from }], existing: [{ rel, name }], skipped: [{ name, reason }] }
 */
async function importFiles(index, paths, opts = {}) {
  const root = index.root;
  const { files, skipped } = await expand(paths);
  const imported = [];
  const existing = [];
  const progress = (done, current) => opts.onProgress && opts.onProgress({ done, total: files.length, current });
  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    const name = path.basename(src);
    progress(i, name);
    // 많이 넣을 때 화면이 멈추지 않도록 가끔 쉰다
    if (i && i % 5 === 0) await new Promise((r) => setImmediate(r));
    try {
      // 이미 문서 폴더 안에 있는 파일은 복사하지 않고 그대로 보여 준다.
      if (isInside(root, src)) {
        const rel = path.relative(root, src).split(path.sep).join("/");
        if (!index.files[rel]) await indexer.addFile(index, src, opts.options);
        if (opts.category && index.files[rel] && !index.files[rel].userCategory) index.files[rel].userCategory = opts.category;
        existing.push({ rel, name, reason: "이미 문서 폴더 안에 있음" });
        continue;
      }
      let dir = root;
      if (opts.folder) dir = path.join(root, ...opts.folder.split("/"));
      else if (opts.layout !== "root") {
        const x = await extract(src);
        // 원래 있던 폴더 이름도 단서로 쓴다. (예: …/고객사/현대모비스/단가표.xlsx)
        const from = path.dirname(src).split(path.sep).filter(Boolean).slice(-2).join("/");
        const c = classify({ name: path.basename(src, path.extname(src)), dir: from, text: x.text, title: x.title }, opts.options);
        dir = path.join(root, ...folderFor(c.category, c.tags, opts.options && opts.options.partners, opts.options && opts.options.projects).split("/"));
      }
      await fs.promises.mkdir(dir, { recursive: true });
      const { dest, duplicate } = await destinationFor(src, dir);
      const rel = path.relative(root, dest).split(path.sep).join("/");
      if (duplicate) {
        if (!index.files[rel]) await indexer.addFile(index, dest, opts.options);
        existing.push({ rel, name, reason: "같은 파일이 이미 있음" });
        continue;
      }
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      // 수정한 날짜는 원본 그대로 둔다.
      const st = await fs.promises.stat(src);
      await fs.promises.utimes(dest, st.atime, st.mtime);
      const entry = await indexer.addFile(index, dest, opts.options);
      if (opts.category) entry.userCategory = opts.category;
      imported.push({ rel, category: indexer.effective(entry).category, from: src });
    } catch (e) {
      skipped.push({ name, reason: String((e && e.message) || e).slice(0, 120) });
    }
  }
  progress(files.length, "");
  return { imported, existing, skipped };
}

module.exports = { isInPlace, moveManyToFolders, removeLegacyFolders, importFiles, folderFor, safeName, ensureCategoryFolders, expectedFolder, moveToFolder };
