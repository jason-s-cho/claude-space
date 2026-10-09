// 색인과 분류 규칙을 문서 폴더 안(.docmanager/)에 저장한다.
// 그래서 폴더를 옮기거나 Google Drive 등으로 다른 PC에서 열어도 직접 고친 분류·태그·메모가 그대로 따라간다.
// 폴더에 쓸 수 없으면(읽기 전용 등) PC의 앱 데이터 폴더에 대신 저장한다.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DIR_NAME = ".docmanager";

// 문서 폴더를 따라가는 설정. 나머지(테마, 마지막 폴더, 최근 검색)는 PC마다 따로 둔다.
const FOLDER_KEYS = ["partners", "projects", "tagRules", "keywordOverrides", "techTags", "importLayout", "savedSearches", "aiExcludeCategories"];

function paths(root) {
  const dir = path.join(root, DIR_NAME);
  return { dir, index: path.join(dir, "index.json"), settings: path.join(dir, "settings.json") };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 반쯤 쓰인 파일이 남지 않도록 임시 파일에 쓴 뒤 바꿔 끼운다.
function writeJson(file, data, pretty = false) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// .docmanager 폴더를 만든다. 윈도우에서는 숨김 폴더로 만든다(점으로 시작해도 윈도우에서는 보이므로).
// 결과: 쓸 수 있으면 true
function ensureDir(root) {
  const { dir } = paths(root);
  try {
    const existed = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    if (!existed) {
      fs.writeFileSync(path.join(dir, "README.txt"),
        "문서 보관함 앱이 이 폴더의 분류·태그·메모와 분류 규칙을 저장하는 곳입니다.\r\n" +
        "지우면 직접 고친 분류·태그·메모가 사라집니다. (문서 파일에는 영향 없음)\r\n");
      if (process.platform === "win32") execFile("attrib", ["+h", dir], () => {});
    }
    return true;
  } catch {
    return false;
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * 문서 폴더의 설정을 읽는다. 아직 없으면 seed(지금 PC의 설정)로 시작한다.
 * 결과: { values, fromFolder }
 */
function loadFolderSettings(root, seed) {
  const data = readJson(paths(root).settings);
  if (data && typeof data === "object") return { values: pick(data, FOLDER_KEYS), fromFolder: true };
  return { values: pick(seed, FOLDER_KEYS), fromFolder: false };
}

function saveFolderSettings(root, settings) {
  if (!ensureDir(root)) return false;
  try {
    writeJson(paths(root).settings, pick(settings, FOLDER_KEYS), true);
    return true;
  } catch {
    return false;
  }
}

/**
 * 예전 버전(앱 데이터 폴더에 색인을 두던 0.2 이전)의 색인을 문서 폴더로 옮긴다.
 * 문서 폴더에 이미 색인이 있으면 건드리지 않는다. 옮긴 뒤 예전 파일은 index.json.moved 로 이름을 바꿔 둔다.
 * 결과: 옮겼으면 true
 */
function migrateLegacyIndex(root, legacyFile) {
  const target = paths(root).index;
  if (fs.existsSync(target)) return false;
  const old = readJson(legacyFile);
  if (!old || old.root !== root || !old.files) return false;
  if (!ensureDir(root)) return false;
  try {
    writeJson(target, old);
    fs.renameSync(legacyFile, legacyFile + ".moved");
    return true;
  } catch {
    return false;
  }
}

/**
 * 색인을 둘 파일. 문서 폴더에 쓸 수 있으면 그 안, 아니면 앱 데이터 폴더.
 * 결과: { file, inFolder }
 */
function indexLocation(root, fallbackFile) {
  if (ensureDir(root)) return { file: paths(root).index, inFolder: true };
  return { file: fallbackFile, inFolder: false };
}

// fs.watch 가 알려 준 파일 이름이 이 앱이 쓰는 폴더 안의 것인지 (자기가 쓴 파일 때문에 다시 훑지 않도록)
function isOwnFile(filename) {
  if (!filename) return false;
  return String(filename).split(/[\\/]/)[0] === DIR_NAME;
}

module.exports = { DIR_NAME, FOLDER_KEYS, paths, ensureDir, loadFolderSettings, saveFolderSettings, migrateLegacyIndex, indexLocation, isOwnFile, writeJson, readJson };
