// 중복 파일: 이름·위치와 상관없이 내용이 완전히 같은 파일들.
// 크기가 같은 파일만 내용 지문(sha1)을 계산하고, 지문은 색인에 (크기·수정 시각과 함께) 기억해 두어 다시 계산하지 않는다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

const keyOf = (e) => `${e.size}:${e.mtimeMs}`;

/**
 * 내용이 같은 파일 묶음을 찾는다. 계산한 지문은 entry.sha1 / entry.sha1Key 에 남는다.
 * 결과: { groups: [[rel, rel, ...], ...], hashed: 새로 계산한 파일 수 }
 */
async function findDuplicates(index, { hash = hashFile } = {}) {
  const bySize = new Map();
  for (const e of Object.values(index.files)) {
    if (!e.size) continue; // 빈 파일은 같은 내용으로 치지 않는다
    if (!bySize.has(e.size)) bySize.set(e.size, []);
    bySize.get(e.size).push(e);
  }
  let hashed = 0;
  const byHash = new Map();
  for (const list of bySize.values()) {
    if (list.length < 2) continue;
    for (const e of list) {
      if (e.sha1Key !== keyOf(e) || !e.sha1) {
        try {
          e.sha1 = await hash(path.join(index.root, ...e.rel.split("/")));
          e.sha1Key = keyOf(e);
          hashed++;
        } catch {
          continue; // 읽을 수 없는 파일은 건너뛴다
        }
      }
      const k = e.size + ":" + e.sha1;
      if (!byHash.has(k)) byHash.set(k, []);
      byHash.get(k).push(e.rel);
    }
  }
  const groups = [...byHash.values()].filter((g) => g.length > 1).map((g) => g.sort());
  groups.sort((a, b) => a[0].localeCompare(b[0]));
  return { groups, hashed };
}

const hasEdits = (e) => !!(e.userCategory || (e.userTags && e.userTags.length) || e.note || e.starred);

/**
 * 묶음에서 남길 파일을 고른다: 분류 폴더(제자리)에 있는 것 → 태그·메모를 고친 것
 * → 같은 문서의 버전들이면 가장 최신 버전 이름(초안보다 _v3) → 먼저 만든 것 → 경로가 짧은 것.
 * inPlace(rel): 제자리인지 / versionRank(rel): 버전 묶음에서의 순서 (0 = 최신, 묶음이 없으면 Infinity)
 */
function suggestKeep(index, rels, inPlace = () => false, versionRank = () => Infinity) {
  const score = (rel) => {
    const e = index.files[rel] || {};
    return [inPlace(rel) ? 0 : 1, hasEdits(e) ? 0 : 1, versionRank(rel), e.birthtimeMs || e.mtimeMs || 0, rel.length];
  };
  return [...rels].sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
    return a.localeCompare(b);
  })[0];
}

/**
 * 지울 사본의 태그·메모·즐겨찾기·직접 고른 분류를 남길 파일에 합친다. (남길 파일에 이미 있는 것은 그대로)
 */
function mergeInto(keep, others) {
  for (const o of others) {
    if (!o) continue;
    if (o.userTags && o.userTags.length) keep.userTags = [...new Set([...(keep.userTags || []), ...o.userTags])];
    if (o.hiddenTags && o.hiddenTags.length) keep.hiddenTags = [...new Set([...(keep.hiddenTags || []), ...o.hiddenTags])];
    if (o.starred) keep.starred = true;
    if (o.userCategory && !keep.userCategory) keep.userCategory = o.userCategory;
    if (o.note && o.note.trim()) {
      const mine = (keep.note || "").trim();
      if (!mine) keep.note = o.note;
      else if (!mine.includes(o.note.trim())) keep.note = mine + "\n" + o.note.trim();
    }
  }
  return keep;
}

module.exports = { hashFile, findDuplicates, suggestKeep, mergeInto };
