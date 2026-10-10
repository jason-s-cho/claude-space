const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// 설치판에 빠진 폴더가 있으면 그 기능이 설치판에서만 죽는다 (예: Claude 커넥터 mcp/).
test("설치 파일에 앱이 쓰는 폴더가 모두 들어간다", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const files = pkg.build.files;
  for (const dir of ["lib", "app", "mcp"]) assert.ok(files.includes(`${dir}/**/*`), `${dir}/ 가 build.files 에 없습니다`);
  for (const f of ["main.js", "preload.js"]) assert.ok(files.includes(f), f);
  // 앱 코드가 require 하는 로컬 폴더는 모두 목록에 있어야 한다
  const root = path.join(__dirname, "..");
  const sources = ["main.js", "preload.js", ...fs.readdirSync(path.join(root, "lib")).map((f) => "lib/" + f), "mcp/server.js"];
  for (const src of sources) {
    const code = fs.readFileSync(path.join(root, src), "utf8");
    for (const m of code.matchAll(/require\("(\.{1,2}\/[^"]+)"\)/g)) {
      const target = path.relative(root, path.resolve(path.dirname(path.join(root, src)), m[1])).split(path.sep)[0];
      if (target.endsWith(".json") || target.endsWith(".js")) continue; // package.json 등은 electron-builder 가 넣는다
      assert.ok(files.includes(`${target}/**/*`), `${src} 가 쓰는 ${target}/ 가 build.files 에 없습니다`);
    }
  }
});

test("화면 스크립트를 같이 읽어도 이름이 겹치지 않는다 (겹치면 뒤 파일이 통째로 안 읽힌다)", () => {
  const vm = require("vm");
  const html = fs.readFileSync(path.join(__dirname, "..", "app", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  assert.ok(scripts.length >= 2);
  const code = scripts.map((s) => fs.readFileSync(path.join(__dirname, "..", "app", s), "utf8")).join("\n;\n");
  assert.doesNotThrow(() => new vm.Script(code));
});
