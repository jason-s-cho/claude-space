const test = require("node:test");
const assert = require("node:assert");
const { checkForUpdate, newer } = require("../lib/updates");

const rel = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/jason-s-cho/claude-space/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  body: "바뀐 점",
  assets: [
    { name: `docmanager-${tag.replace(/^\D+/, "")}-win-x64.exe`, browser_download_url: `https://github.com/jason-s-cho/claude-space/releases/download/${tag}/a.exe` },
    { name: "a.exe.blockmap", browser_download_url: "x" },
    { name: "a.dmg", browser_download_url: "https://github.com/jason-s-cho/claude-space/releases/download/x/a.dmg" },
  ],
  ...extra,
});

test("버전 비교", () => {
  assert.ok(newer("0.2.41", "0.2.40"));
  assert.ok(newer("0.3.0", "0.2.99"));
  assert.ok(!newer("0.2.40", "0.2.40"));
  assert.ok(!newer("0.2.9", "0.2.10"));
  assert.ok(!newer("이상한", "0.2.1"));
});

test("새 버전 확인: 문서 보관함 릴리스만, 초안·시험판은 빼고, 이 컴퓨터용 설치 파일", async () => {
  const list = [rel("paper-v9.9.9"), rel("docmanager-v0.2.50", { draft: true }), rel("docmanager-v0.2.45", { prerelease: true }), rel("docmanager-v0.2.41"), rel("docmanager-v0.2.38")];
  const r = await checkForUpdate("0.2.40", { fetchJson: async () => list, platform: "win32" });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.latest, "0.2.41");
  assert.match(r.url, /a\.exe$/);
  const mac = await checkForUpdate("0.2.40", { fetchJson: async () => list, platform: "darwin" });
  assert.match(mac.url, /a\.dmg$/);
  assert.strictEqual((await checkForUpdate("0.2.41", { fetchJson: async () => list, platform: "win32" })).available, false);
  // 리눅스용 파일이 없으면 알리지 않는다
  assert.strictEqual((await checkForUpdate("0.2.1", { fetchJson: async () => list, platform: "linux" })).available, false);
  // 인터넷이 안 되면 오류만 돌려준다 (앱은 조용히 넘어간다)
  const off = await checkForUpdate("0.2.40", { fetchJson: async () => { throw new Error("offline"); } });
  assert.match(off.error, /offline/);
  assert.strictEqual((await checkForUpdate("0.2.40", { fetchJson: async () => [] })).latest, null);
});
