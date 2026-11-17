// Claude 데스크톱 앱 설정(claude_desktop_config.json)에 워크데스크 커넥터를 넣고 빼기.
// 다른 커넥터 설정은 건드리지 않고 "doc-manager" 항목만 바꾼다. 바꾸기 전에 원래 파일을 .bak 으로 남긴다.
// 설정 파일이 깨져 있으면(JSON 이 아님) 덮어쓰지 않고 오류를 알린다.
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVER_KEY = "doc-manager";

// 설정 파일 위치. 윈도우 스토어판(MSIX) Claude 는 별도 위치를 쓰므로 있으면 함께 고친다.
function configPaths(env = process.env, platform = process.platform, home = os.homedir()) {
  const out = [];
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    out.push(path.join(appData, "Claude", "claude_desktop_config.json"));
    const pkgs = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Packages");
    try {
      for (const d of fs.readdirSync(pkgs)) {
        if (/^(AnthropicPBC\.)?Claude_/i.test(d)) out.push(path.join(pkgs, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      }
    } catch {}
  } else if (platform === "darwin") {
    // 맥·리눅스 경로는 어디서 만들든 '/' 로 (윈도우에서 시험할 때도 같은 결과)
    out.push(path.posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  } else {
    out.push(path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), "Claude", "claude_desktop_config.json"));
  }
  return out;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new Error(`Claude 설정 파일이 올바른 JSON 이 아니라서 고치지 않았습니다: ${file}`);
  }
}

function writeConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// 지금 연결 상태: 파일마다 { path, exists, connected, matches(지금 실행 파일을 가리키는지), error }
function status(entry, paths = configPaths()) {
  return paths.map((p) => {
    try {
      const cfg = readConfig(p);
      const cur = cfg.mcpServers && cfg.mcpServers[SERVER_KEY];
      return {
        path: p,
        exists: fs.existsSync(p),
        connected: !!cur,
        matches: !!cur && cur.command === entry.command && JSON.stringify(cur.args) === JSON.stringify(entry.args) && ((cur.env || {}).DOCMANAGER_USERDATA || "") === ((entry.env || {}).DOCMANAGER_USERDATA || ""),
      };
    } catch (e) {
      return { path: p, exists: true, connected: false, matches: false, error: e.message };
    }
  });
}

function connect(entry, paths = configPaths()) {
  const done = [];
  for (const p of paths) {
    const cfg = readConfig(p); // 깨진 파일이면 여기서 멈춘다
    cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_KEY]: entry };
    writeConfig(p, cfg);
    done.push(p);
  }
  return done;
}

function disconnect(paths = configPaths()) {
  const done = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const cfg = readConfig(p);
    if (!cfg.mcpServers || !cfg.mcpServers[SERVER_KEY]) continue;
    delete cfg.mcpServers[SERVER_KEY];
    writeConfig(p, cfg);
    done.push(p);
  }
  return done;
}

// Claude Code 용 명령 (터미널에 붙여 넣기)
function claudeCodeCommand(entry) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const envs = Object.entries(entry.env || {}).map(([k, v]) => `-e ${k}=${q(v)}`).join(" ");
  return `claude mcp add ${SERVER_KEY} --scope user ${envs} -- ${q(entry.command)} ${entry.args.map(q).join(" ")}`;
}

// 연결 테스트: Claude 가 하는 것과 똑같이 커넥터를 실행해서 도구 목록과 보관함 요약을 받아 본다.
// 결과: { ok, tools, documents, error, stderr, ms }
async function selfTest(entry, { timeoutMs = 20000 } = {}) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const started = Date.now();
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, ...(entry.env || {}) }, stderr: "pipe" });
  let stderr = "";
  if (transport.stderr) transport.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  const client = new Client({ name: SELF_TEST_CLIENT, version: "1.0.0" });
  let timer;
  const timeout = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${timeoutMs / 1000}초 안에 응답이 없습니다`)), timeoutMs)));
  try {
    const run = (async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const r = await client.callTool({ name: "library_overview", arguments: {} });
      const text = (r.content && r.content[0] && r.content[0].text) || "";
      if (r.isError) throw new Error(text);
      let documents;
      try {
        documents = JSON.parse(text).documents;
      } catch {}
      return { tools: tools.map((t) => t.name), documents };
    })();
    const res = await Promise.race([run, timeout]);
    return { ok: true, ...res, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), stderr: stderr.trim(), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {}
  }
}

// Claude 데스크톱이 이 커넥터를 실행하며 남긴 기록(logs/mcp-server-doc-manager.log)의 끝부분.
// 파일이 없으면 Claude 가 이 설정 파일을 읽지 않았거나(다른 설치 위치·모드) 아직 다시 켜지 않은 것이다.
function claudeLogs(paths = configPaths(), lines = 12) {
  return paths.map((p) => {
    const file = path.join(path.dirname(p), "logs", `mcp-server-${SERVER_KEY}.log`);
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, "r");
      const size = Math.min(st.size, 64 * 1024); // 끝부분만
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      fs.closeSync(fd);
      const tail = buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
      return { file, exists: true, modified: st.mtime.toISOString(), tail };
    } catch {
      return { file, exists: false };
    }
  });
}

// 스토어판(MSIX) Claude 데스크톱이 깔려 있는지 (윈도우). 스토어판은 가상화된 파일 시스템 안에서 돌아서
// 사용자 폴더(AppData\Local\Programs)에 설치된 앱을 실행하지 못한다 (spawn ... ENOENT).
function msixClaude(env = process.env, home = os.homedir()) {
  const pkgs = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Packages");
  try {
    return fs.readdirSync(pkgs).some((d) => /^(AnthropicPBC\.)?Claude_/i.test(d));
  } catch {
    return false;
  }
}

// 이 실행 파일이 사용자용 설치 위치(AppData 아래)에 있는지
function perUserInstall(execPath, env = process.env, home = os.homedir()) {
  const norm = (x) => path.win32.normalize(String(x || "")).toLowerCase().replace(/\\+$/, "") + "\\";
  const roots = [env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), env.APPDATA || path.win32.join(home, "AppData", "Roaming")];
  return roots.some((r) => norm(execPath).startsWith(norm(r)));
}

// Claude 연결 화면에 띄울 설치 위치 경고 (문제가 없으면 null)
function installWarning(execPath, { platform = process.platform, env = process.env, home = os.homedir(), msix } = {}) {
  if (platform !== "win32") return null;
  if (!perUserInstall(execPath, env, home)) return null;
  const isMsix = msix === undefined ? msixClaude(env, home) : msix;
  if (!isMsix) return null;
  return {
    path: execPath,
    message: "워크데스크가 사용자 폴더(AppData)에 설치되어 있어서, 스토어판 Claude 데스크톱이 커넥터를 실행하지 못합니다 (Claude 설정 → 개발자 화면에 'spawn … ENOENT'). 최신 설치 파일을 실행하면 모든 사용자용(C:\\Program Files\\doc-manager)으로 설치됩니다. 그다음 윈도우 설정 → 앱에서 예전 설치를 지우고, 새로 설치한 워크데스크에서 '다시 연결'을 눌러 주세요.",
  };
}

// 커넥터가 시작될 때 남기는 실행 기록 (문서 폴더의 .docmanager/mcp-starts.json — 가상화되지 않는 곳).
// Claude 데스크톱의 기록 폴더는 설치판마다 위치가 달라 믿기 어렵다.
const STARTS_FILE = "mcp-starts.json";
function recordStart(dir, client, now = new Date()) {
  const file = path.join(dir, STARTS_FILE);
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(list)) list = [];
  } catch {}
  list.unshift({ time: now.toISOString(), client: (client && client.name) || "", version: (client && client.version) || "" });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list.slice(0, 20), null, 1));
  } catch {}
}
function readStarts(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, STARTS_FILE), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
// 연결 테스트(앱이 스스로 실행)는 빼고, 진짜 Claude 가 실행한 마지막 기록
const SELF_TEST_CLIENT = "doc-manager-self-test";
const lastClientStart = (list) => list.find((x) => x.client !== SELF_TEST_CLIENT) || null;

module.exports = { SERVER_KEY, configPaths, status, connect, disconnect, claudeCodeCommand, readConfig, selfTest, claudeLogs, msixClaude, perUserInstall, installWarning, recordStart, readStarts, lastClientStart, SELF_TEST_CLIENT };
