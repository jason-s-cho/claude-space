const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cc = require("../lib/claude-config");

const entry = { command: "C:\\Program Files\\문서 보관함\\문서 보관함.exe", args: ["C:\\Program Files\\문서 보관함\\resources\\app.asar\\mcp\\server.js"], env: { ELECTRON_RUN_AS_NODE: "1", DOCMANAGER_USERDATA: "C:\\Users\\me\\AppData\\Roaming\\문서 보관함" } };

test("Claude 데스크톱 설정: 다른 커넥터는 그대로 두고 넣고 빼기", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-cc-"));
  const file = path.join(dir, "Claude", "claude_desktop_config.json");
  // 설정 파일이 없어도 만든다
  assert.deepStrictEqual(cc.connect(entry, [file]), [file]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["doc-manager"], entry);
  // 기존 설정이 있으면 다른 항목은 보존하고 .bak 을 남긴다
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { other: { command: "x" } } }));
  cc.connect(entry, [file]);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(cfg.globalShortcut, "Ctrl+Space");
  assert.deepStrictEqual(cfg.mcpServers.other, { command: "x" });
  assert.ok(cfg.mcpServers["doc-manager"]);
  assert.ok(fs.existsSync(file + ".bak"));
  let st = cc.status(entry, [file])[0];
  assert.ok(st.connected && st.matches);
  // 실행 파일 위치가 바뀌면 '다시 연결' 필요
  st = cc.status({ ...entry, command: "D:\\다른곳\\app.exe" }, [file])[0];
  assert.ok(st.connected && !st.matches);
  // 앱 데이터 폴더가 다르면 커넥터가 다른 설정을 읽으므로 역시 '다시 연결'
  st = cc.status({ ...entry, env: { ...entry.env, DOCMANAGER_USERDATA: "C:\\Users\\me\\AppData\\Roaming\\doc-manager" } }, [file])[0];
  assert.ok(st.connected && !st.matches);
  // 해제: 내 항목만 지운다
  cc.disconnect([file]);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(!after.mcpServers["doc-manager"]);
  assert.deepStrictEqual(after.mcpServers.other, { command: "x" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("깨진 설정 파일은 덮어쓰지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-cc-"));
  const file = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(file, "{ 잘못된 json");
  assert.throws(() => cc.connect(entry, [file]), /올바른 JSON/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "{ 잘못된 json");
  assert.ok(cc.status(entry, [file])[0].error);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("설정 파일 위치 (윈도우 스토어판 포함)와 Claude Code 명령", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-home-"));
  const local = path.join(home, "Local");
  fs.mkdirSync(path.join(local, "Packages", "Claude_pzs8sxrjxfjjc"), { recursive: true });
  const win = cc.configPaths({ APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: local }, "win32", home);
  assert.strictEqual(win[0], path.join(home, "Roaming", "Claude", "claude_desktop_config.json"));
  assert.strictEqual(win[1], path.join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
  assert.match(cc.configPaths({}, "darwin", "/Users/me")[0], /Library\/Application Support\/Claude\/claude_desktop_config\.json$/);
  const cmd = cc.claudeCodeCommand(entry);
  assert.match(cmd, /^claude mcp add doc-manager --scope user -e ELECTRON_RUN_AS_NODE="1" -e DOCMANAGER_USERDATA=".+" -- ".+문서 보관함\.exe" ".+server\.js"$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("연결 테스트: 커넥터를 실행해 도구 목록과 보관함 요약을 받는다", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-st-root-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-st-ud-"));
  fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ root }));
  const ok = await cc.selfTest({ command: process.execPath, args: [path.join(__dirname, "..", "mcp", "server.js")], env: { DOCMANAGER_USERDATA: ud } });
  assert.ok(ok.ok, ok.error);
  assert.ok(ok.tools.includes("search_documents"));
  assert.strictEqual(ok.documents, 0);
  // 실행 파일이 없으면 오류를 알려 준다 (멈추지 않고)
  const bad = await cc.selfTest({ command: path.join(ud, "없는.exe"), args: [] }, { timeoutMs: 5000 });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
});

test("Claude 가 남긴 커넥터 기록의 끝부분을 읽는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-cl-"));
  const cfg = path.join(dir, "claude_desktop_config.json");
  assert.strictEqual(cc.claudeLogs([cfg])[0].exists, false);
  fs.mkdirSync(path.join(dir, "logs"));
  fs.writeFileSync(path.join(dir, "logs", "mcp-server-doc-manager.log"), Array.from({ length: 30 }, (_, i) => `줄 ${i}`).join("\r\n"));
  const [log] = cc.claudeLogs([cfg], 3);
  assert.ok(log.exists);
  assert.strictEqual(log.tail, "줄 27\n줄 28\n줄 29");
  fs.rmSync(dir, { recursive: true, force: true });
});
