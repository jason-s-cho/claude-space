// 다른 형식으로 저장: 이 PC에 설치된 한글·워드를 뒤에서 실행해 변환한다 (윈도우 전용).
//   한글: .hwp → .hwpx (양식 채우기용), .hwp/.hwpx → .pdf (제출용)
//   워드: .doc → .docx, .doc/.docx → .pdf
// 원본은 그대로 두고 같은 폴더에 새 파일을 만든다. 같은 이름이 있으면 "이름 (2).pdf" 처럼 비켜 간다.
// 한글은 보안 설정에 따라 '파일 접근 허용' 창을 띄울 수 있다 (허용을 눌러야 진행된다).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// 원본 확장자 → { 대상 확장자: [프로그램, 저장 형식] }
const TARGETS = {
  ".hwp": { ".hwpx": ["hwp", "HWPX"], ".pdf": ["hwp", "PDF"] },
  ".hwpx": { ".pdf": ["hwp", "PDF"] },
  ".doc": { ".docx": ["word", "16"], ".pdf": ["word", "17"] },
  ".docx": { ".pdf": ["word", "17"] },
};
const APP_NAME = { hwp: "한글(한컴오피스)", word: "MS 워드" };
const TIMEOUT_MS = 3 * 60 * 1000;

function targetsFor(ext) {
  return Object.keys(TARGETS[String(ext).toLowerCase()] || {});
}

// 같은 폴더에 겹치지 않는 새 파일 이름
function outputPath(src, toExt) {
  const dir = path.dirname(src);
  const stem = path.basename(src, path.extname(src));
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, i === 1 ? stem + toExt : `${stem} (${i})${toExt}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error("같은 이름의 파일이 너무 많습니다");
}

// 윈도우 PowerShell 5.1 에서도 도는 문법만 쓴다. 경로는 환경 변수로 받아 따옴표 문제를 피한다.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = $env:DM_SRC; $dst = $env:DM_DST; $fmt = $env:DM_FMT; $app = $env:DM_APP
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
try {
  if ($app -eq 'hwp') {
    try { $h = New-Object -ComObject HWPFrame.HwpObject } catch { Send @{ ok = $false; code = 'noapp'; error = $_.Exception.Message }; exit 0 }
    try {
      try { [void]$h.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule') } catch {}
      try { $h.XHwpWindows.Item(0).Visible = $false } catch {}
      $opened = $h.Open($src, '', 'forceopen:true')
      if (-not $opened) { throw 'open-failed' }
      $saved = $h.SaveAs($dst, $fmt, '')
      if (-not $saved) { throw 'save-failed' }
    } finally {
      try { [void]$h.Clear(1) } catch {}
      try { $h.Quit() } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($h) } catch {}
    }
  } else {
    try { $w = New-Object -ComObject Word.Application } catch { Send @{ ok = $false; code = 'noapp'; error = $_.Exception.Message }; exit 0 }
    try {
      $w.Visible = $false
      $w.DisplayAlerts = 0
      $d = $w.Documents.Open($src, $false, $true, $false)
      try { $d.SaveAs2($dst, [int]$fmt) } finally { $d.Close(0) }
    } finally {
      try { $w.Quit() } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) } catch {}
    }
  }
  Send @{ ok = $true }
} catch {
  Send @{ ok = $false; error = $_.Exception.Message }
}
`;

// PowerShell 로 스크립트 실행. 결과: 마지막 JSON 줄
function runPowerShell(script, env, { timeoutMs = TIMEOUT_MS, exe = "powershell.exe" } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("변환이 너무 오래 걸려 멈췄습니다. 한글·워드에 '허용' 창이나 다른 창이 떠 있는지 확인해 주세요."));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error("PowerShell 을 실행할 수 없습니다: " + e.message));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
      if (!line) return reject(new Error("변환 프로그램이 응답하지 않았습니다" + (err.trim() ? ": " + err.trim().split(/\r?\n/)[0] : "")));
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("변환 결과를 읽을 수 없습니다"));
      }
    });
  });
}

/**
 * src 를 toExt(".hwpx" / ".docx" / ".pdf") 로 저장한다.
 * 결과: { output: 새 파일 전체 경로, app }
 */
async function convert(src, toExt, { run = runPowerShell, platform = process.platform } = {}) {
  const fromExt = path.extname(src).toLowerCase();
  toExt = (String(toExt || "").startsWith(".") ? "" : ".") + String(toExt || "").toLowerCase();
  const t = (TARGETS[fromExt] || {})[toExt];
  if (!t) {
    const can = targetsFor(fromExt);
    throw new Error(can.length ? `${fromExt} 은 ${can.join(", ")} 로만 바꿀 수 있습니다` : `${fromExt || "이 형식"} 은 다른 형식으로 바꿀 수 없습니다`);
  }
  const [app, fmt] = t;
  if (platform !== "win32") throw new Error(`다른 형식으로 저장은 ${APP_NAME[app]}가 설치된 윈도우 PC에서만 됩니다`);
  if (!fs.existsSync(src)) throw new Error("파일이 없습니다: " + src);
  const output = outputPath(src, toExt);
  const r = await run(SCRIPT, { DM_SRC: src, DM_DST: output, DM_FMT: fmt, DM_APP: app });
  if (!r || !r.ok) {
    if (r && r.code === "noapp") throw new Error(`이 PC에서 ${APP_NAME[app]}를 실행할 수 없습니다. ${APP_NAME[app]}가 설치되어 있는지 확인해 주세요.`);
    const msg = String((r && r.error) || "");
    if (/open-failed/.test(msg)) throw new Error(`${APP_NAME[app]}가 파일을 열지 못했습니다. 암호가 걸렸거나 손상된 파일일 수 있습니다. (한글의 '접근 허용' 창에서 거부했을 때도 이렇게 됩니다)`);
    if (/save-failed/.test(msg)) throw new Error(`${APP_NAME[app]}가 새 파일을 저장하지 못했습니다. 한글 버전이 오래되어 이 형식을 지원하지 않을 수 있습니다.`);
    throw new Error(`${APP_NAME[app]}로 변환하지 못했습니다: ${msg || "알 수 없는 오류"}`);
  }
  let st = null;
  try {
    st = fs.statSync(output);
  } catch {}
  if (!st || !st.size) throw new Error(`${APP_NAME[app]}가 저장했다고 했지만 새 파일이 보이지 않습니다`);
  return { output, app: APP_NAME[app] };
}

module.exports = { convert, targetsFor, outputPath, runPowerShell, SCRIPT, TARGETS };
