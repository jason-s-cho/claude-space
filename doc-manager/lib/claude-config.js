// Claude 데스크톱 앱 설정(claude_desktop_config.json)에 문서 보관함 커넥터를 넣고 빼기.
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
        matches: !!cur && cur.command === entry.command && JSON.stringify(cur.args) === JSON.stringify(entry.args),
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

module.exports = { SERVER_KEY, configPaths, status, connect, disconnect, claudeCodeCommand, readConfig };
