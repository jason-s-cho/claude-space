const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const c = require("../lib/convert");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-conv-"));
}

test("변환: 형식 조합·윈도우 전용·겹치지 않는 이름", async () => {
  assert.deepStrictEqual(c.targetsFor(".HWP"), [".hwpx", ".pdf"]);
  assert.deepStrictEqual(c.targetsFor(".docx"), [".pdf"]);
  assert.deepStrictEqual(c.targetsFor(".pptx"), []);
  const dir = tmpdir();
  const src = path.join(dir, "양식.hwp");
  fs.writeFileSync(src, "x");
  await assert.rejects(c.convert(src, "docx", { platform: "win32" }), /\.hwpx, \.pdf 로만/);
  await assert.rejects(c.convert(src, "hwpx", { platform: "darwin" }), /윈도우 PC에서만/);
  fs.writeFileSync(path.join(dir, "양식.pdf"), "old");
  assert.strictEqual(path.basename(c.outputPath(src, ".pdf")), "양식 (2).pdf");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("변환: 프로그램 결과에 따라 알맞은 안내", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "양식.hwp");
  fs.writeFileSync(src, "x");
  const fake = (reply, write = true) => async (_script, env) => {
    assert.strictEqual(env.DM_SRC, src);
    if (write) fs.writeFileSync(env.DM_DST, "out");
    return reply;
  };
  const r = await c.convert(src, ".hwpx", { platform: "win32", run: fake({ ok: true }) });
  assert.strictEqual(r.output, path.join(dir, "양식.hwpx"));
  await assert.rejects(c.convert(src, ".pdf", { platform: "win32", run: fake({ ok: false, code: "noapp" }, false) }), /한글\(한컴오피스\)를 실행할 수 없습니다/);
  await assert.rejects(c.convert(src, ".pdf", { platform: "win32", run: fake({ ok: false, error: "open-failed" }, false) }), /열지 못했습니다/);
  await assert.rejects(c.convert(src, ".pdf", { platform: "win32", run: fake({ ok: true }, false) }), /새 파일이 보이지 않습니다/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 실제 PowerShell 로 변환 스크립트를 돌린다 (한글·워드 대신 가짜 COM 객체). 윈도우 CI 에서는 PowerShell 5.1 로 돈다.
function powershell() {
  for (const exe of process.platform === "win32" ? ["powershell.exe"] : ["pwsh"]) {
    try {
      execFileSync(exe, ["-NoProfile", "-Command", "1"], { stdio: "ignore" });
      return exe;
    } catch {}
  }
  return null;
}
const ps = powershell();

test("변환 스크립트: PowerShell 에서 한글·워드 순서대로 부른다", { skip: !ps && "PowerShell 없음" }, async () => {
  const mock = fs.readFileSync(path.join(__dirname, "fixtures", "com-mock.ps1"), "utf8");
  const dir = tmpdir();
  const log = path.join(dir, "log.txt");
  const run = (fail) => (script, env) => c.runPowerShell(mock + "\n" + script, { ...env, DM_MOCKLOG: log, DM_MOCKFAIL: fail || "" }, { exe: ps });
  const src = path.join(dir, "2027 수요조사서 양식.hwp");
  fs.writeFileSync(src, "hwp");
  const r = await c.convert(src, ".hwpx", { platform: "win32", run: run() });
  assert.strictEqual(path.basename(r.output), "2027 수요조사서 양식.hwpx");
  await assert.rejects(c.convert(src, ".pdf", { platform: "win32", run: run("save") }), /저장하지 못했습니다/);
  const doc = path.join(dir, "견적.doc");
  fs.writeFileSync(doc, "doc");
  await c.convert(doc, ".pdf", { platform: "win32", run: run() });
  const lines = fs.readFileSync(log, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  assert.deepStrictEqual(lines.map((l) => l.replace(dir, "D").replace(/\\/g, "/")), [
    "open D/2027 수요조사서 양식.hwp [] [forceopen:true]",
    "saveas D/2027 수요조사서 양식.hwpx [HWPX]",
    "clear 1",
    "quit",
    "open D/2027 수요조사서 양식.hwp [] [forceopen:true]",
    "saveas D/2027 수요조사서 양식.pdf [PDF]",
    "clear 1",
    "quit",
    "word open D/견적.doc ro=True",
    "word saveas D/견적.pdf fmt=17",
    "word close 0",
    "word quit",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});
