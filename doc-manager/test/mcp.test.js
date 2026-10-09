const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const indexer = require("../lib/indexer");
const store = require("../lib/store");

async function docx(file, paragraphs) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

// 시험용 보관함: 앱이 만든 것과 같은 색인(.docmanager/index.json)과 설정
async function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-mcp-root-"));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-mcp-ud-"));
  const long = "그래핀 스텔스 패널의 전파 흡수 성능을 정리한다. ".repeat(1800); // 4만 자가 넘는 본문
  await docx(path.join(root, "회사소개/IR·투자/엠씨케이테크_IR_초안.docx"), ["IR 투자유치 그래핀 스텔스", "Series A"]);
  await docx(path.join(root, "회사소개/IR·투자/엠씨케이테크_IR_260406.docx"), ["IR 투자유치 그래핀 스텔스 최신", "Series A", long]);
  await docx(path.join(root, "국가과제·지원사업/5 보고서/최종보고서.docx"), ["최종보고서", "주관기관 정부출연금", "그래핀 스텔스 패널 성과"]);
  await docx(path.join(root, "구매·견적/장비 견적.docx"), ["견적서 비밀 단가"]);
  const old = new Date("2026-08-30T00:00:00Z");
  fs.utimesSync(path.join(root, "회사소개/IR·투자/엠씨케이테크_IR_초안.docx"), old, old);
  const index = indexer.emptyIndex(root);
  await indexer.scan(index, {});
  index.files["구매·견적/장비 견적.docx"].userTags = ["AI제외"];
  store.ensureDir(root);
  indexer.saveIndex(store.paths(root).index, index);
  fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ root }));
  return { root, ud };
}

async function connect(ud) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "mcp", "server.js")],
    env: { ...process.env, DOCMANAGER_USERDATA: ud },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return { error: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
  };
  return { client, call };
}

test("Claude 커넥터: 둘러보기·검색·읽기·버전·관련 문서·새 버전 저장, AI 제외와 기록", async () => {
  const { root, ud } = await makeLibrary();
  const { client, call } = await connect(ud);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepStrictEqual(tools, ["find_related_documents", "get_knowledge", "library_overview", "list_versions", "prepare_new_version", "read_document", "save_knowledge_card", "save_new_version", "search_documents"]);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.deepStrictEqual(prompts, ["build_knowledge_card"]);
    const pr = await client.getPrompt({ name: "build_knowledge_card" });
    assert.match(pr.messages[0].content.text, /save_knowledge_card/);

    // 회사 지식 카드: 없으면 양식, 저장하면 문서 폴더에, 사용자 메모는 지킨다
    let kn = (await call("get_knowledge")).data;
    assert.strictEqual(kn.exists, false);
    assert.match(kn.card, /## 사용자 메모/);
    fs.mkdirSync(path.join(root, "Claude 지식"));
    fs.writeFileSync(path.join(root, "Claude 지식", "회사 지식 카드.md"), "# 회사 지식 카드\n\n## 사용자 메모\n- 내 메모\n");
    const ks = (await call("save_knowledge_card", { content: "# 회사 지식 카드\n## 2. 핵심 기술·제품\n- 그래핀 스텔스 패널 [출처: 회사소개/IR·투자/엠씨케이테크_IR_260406.docx]\n", change_summary: "처음 작성" })).data;
    assert.ok(ks.previous_kept && ks.user_section_restored);
    kn = (await call("get_knowledge")).data;
    assert.ok(kn.exists && kn.card.includes("그래핀 스텔스 패널") && kn.card.includes("- 내 메모"));

    const ov = (await call("library_overview")).data;
    assert.strictEqual(ov.documents, 2); // IR 두 버전은 하나로
    assert.strictEqual(ov.files_including_old_versions, 3);
    assert.strictEqual(ov.hidden_by_ai_exclusion, 1);

    // 검색: 기본은 최신본만, AI제외 문서는 안 보임
    let s = (await call("search_documents", { query: "그래핀" })).data;
    const paths = s.results.map((r) => r.path);
    assert.ok(paths.includes("회사소개/IR·투자/엠씨케이테크_IR_260406.docx"));
    assert.ok(!paths.includes("회사소개/IR·투자/엠씨케이테크_IR_초안.docx"));
    s = (await call("search_documents", { query: "그래핀", include_old_versions: true })).data;
    assert.ok(s.results.some((r) => r.path.endsWith("IR_초안.docx")));
    assert.strictEqual((await call("search_documents", { query: "견적" })).data.total, 0);

    // 읽기: 색인(3만 자)보다 긴 본문을 이어 읽기
    const ir = "회사소개/IR·투자/엠씨케이테크_IR_260406.docx";
    const p1 = (await call("read_document", { path: ir })).data;
    assert.strictEqual(p1.text.length, 20000);
    assert.ok(p1.total_chars > 40000);
    const p3 = (await call("read_document", { path: ir, offset: 40000 })).data;
    assert.strictEqual(p3.next_offset, null);
    assert.strictEqual(p3.offset, 40000);

    // 제외 문서·폴더 밖 경로는 열 수 없음
    assert.match((await call("read_document", { path: "구매·견적/장비 견적.docx" })).text, /AI 제외/);
    assert.ok((await call("read_document", { path: "../../etc/passwd" })).error);

    // 버전 기록과 관련 문서
    const v = (await call("list_versions", { path: ir })).data;
    assert.strictEqual(v.latest, ir);
    assert.strictEqual(v.versions.length, 2);
    const rel = (await call("find_related_documents", { path: ir })).data;
    assert.ok(rel.related.some((r) => r.path === "국가과제·지원사업/5 보고서/최종보고서.docx"));
    assert.ok(!rel.related.some((r) => r.path.endsWith("IR_초안.docx"))); // 같은 문서의 다른 버전은 빼고

    // 새 버전 저장: 원본은 그대로, 다음 이름으로
    const before = fs.readFileSync(path.join(root, ir));
    const content = Buffer.from("새로 고친 내용").toString("base64");
    const saved = (await call("save_new_version", { path: ir, content_base64: content, change_summary: "시장 규모 갱신" })).data;
    assert.match(saved.new_path, /^회사소개\/IR·투자\/엠씨케이테크_IR_\d{6}(_v\d+)?\.docx$/);
    assert.notStrictEqual(saved.new_path, ir);
    assert.ok(fs.readFileSync(path.join(root, ir)).equals(before));
    assert.strictEqual(fs.readFileSync(path.join(root, saved.new_path), "utf8"), "새로 고친 내용");
    // 형식 바꿔 저장, 지원하지 않는 형식은 거부
    const asHwpx = (await call("save_new_version", { path: ir, content_base64: content, file_extension: "hwpx" })).data;
    assert.match(asHwpx.new_path, /\.hwpx$/);
    assert.ok((await call("save_new_version", { path: ir, content_base64: content, file_extension: "exe" })).error);
    assert.ok((await call("save_new_version", { path: ir, content_base64: "" })).error);

    // 복사본 만들기 (Claude Code 용)
    const prep = (await call("prepare_new_version", { path: "국가과제·지원사업/5 보고서/최종보고서.docx" })).data;
    assert.ok(fs.existsSync(prep.absolute_path));
    assert.match(prep.new_path, /최종보고서_v2\.docx$/);

    // 기록
    const log = fs.readFileSync(path.join(root, ".docmanager", "ai-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.some((l) => l.tool === "search_documents" && l.query === "그래핀"));
    assert.ok(log.some((l) => l.tool === "save_new_version" && l.change_summary === "시장 규모 갱신" && l.new_path === saved.new_path));
    assert.ok(log.some((l) => l.tool === "read_document" && l.error));
    assert.ok(log.some((l) => l.tool === "save_knowledge_card" && l.change_summary === "처음 작성"));
  } finally {
    await client.close();
    for (const d of [root, ud]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("Claude 커넥터: 문서 폴더를 아직 고르지 않았으면 알려 준다", async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "docmgr-mcp-ud-"));
  const { client, call } = await connect(ud);
  try {
    const r = await call("library_overview");
    assert.ok(r.error);
    assert.match(r.text, /문서 폴더를 고르지 않았습니다/);
  } finally {
    await client.close();
    fs.rmSync(ud, { recursive: true, force: true });
  }
});
