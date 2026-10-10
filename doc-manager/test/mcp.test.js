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
    assert.deepStrictEqual(tools, ["compare_versions", "convert_document", "fill_form", "find_related_documents", "get_application", "get_card", "get_knowledge", "get_program", "inspect_form", "library_overview", "list_applications", "list_versions", "prepare_new_version", "read_document", "record_application", "save_card", "save_knowledge_card", "save_new_version", "search_documents"]);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.deepStrictEqual(prompts, ["build_knowledge_card", "build_topic_card", "build_program_card", "build_writing_guide", "write_application_document"]);
    const wp = await client.getPrompt({ name: "write_application_document", arguments: { application: "그래핀 스텔스 × 소재부품", document: "수요조사서" } });
    assert.match(wp.messages[0].content.text, /수요조사서를 써 줘[\s\S]*inspect_form[\s\S]*fill_form/);
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

    // 양식 채우기: 칸 보기 → 채우기 → 새 파일(아직 색인 전)도 다시 볼 수 있다
    const report = "국가과제·지원사업/5 보고서/최종보고서.docx";
    const form = (await call("inspect_form", { path: report })).data;
    assert.deepStrictEqual(form.slots.map((x) => x.id), ["p1", "p2", "p3"]);
    const filled = (await call("fill_form", { path: report, fills: [{ id: "p3", text: "그래핀 스텔스 패널 성과\n시제품 3종" }], new_name: "2026 최종보고서_채움", change_summary: "성과 채움" })).data;
    assert.strictEqual(filled.new_path, "국가과제·지원사업/5 보고서/2026 최종보고서_채움.docx");
    assert.ok(fs.existsSync(path.join(root, ...filled.new_path.split("/"))));
    const again = (await call("inspect_form", { path: filled.new_path })).data;
    assert.deepStrictEqual(again.slots.map((x) => x.text), ["최종보고서", "주관기관 정부출연금", "그래핀 스텔스 패널 성과", "시제품 3종"]);
    assert.match((await call("fill_form", { path: report, fills: [{ id: "p1", text: "x" }], new_name: "2026 최종보고서_채움.docx" })).text, /이미 있습니다/);
    assert.match((await call("fill_form", { path: report, fills: [{ id: "p1", text: "x" }], new_name: "다른형식.hwpx" })).text, /같은 형식/);
    assert.match((await call("inspect_form", { path: "구매·견적/장비 견적.docx" })).text, /AI 제외/);
    // check·table_rows 도 받는다 (이 문서엔 네모·표가 없어서 알맞은 오류)
    assert.match((await call("fill_form", { path: report, fills: [{ id: "p1", check: "해당" }] })).text, /네모/);
    assert.match((await call("fill_form", { path: report, table_rows: [{ table: "t1", template_row: 2, rows: [["a"]] }] })).text, /없는 표/);
    // 바뀐 곳 비교: 채운 새 파일과 원본
    const cmp = (await call("compare_versions", { path_a: filled.new_path, path_b: report })).data;
    assert.strictEqual(cmp.older, report);
    assert.deepStrictEqual(cmp.stats, { 고친_문단: 0, 추가: 1, 삭제: 0, 같음: 3 });
    assert.deepStrictEqual(cmp.changes, [{ type: "추가", after: "시제품 3종" }]);
    // 지원 건: 만들기 → 단계 결과 → 문서 연결 → 목록·자세히 (AI 제외 문서는 연결도, 보이기도 안 됨)
    assert.strictEqual((await call("list_applications", {})).data.total, 0);
    const created = (await call("record_application", { action: "create", fields: { title: "광학투명 스텔스 패널", topic: "그래핀 스텔스", program: "소재부품기술개발", year: 2027 }, template: "국가 R&D (수요조사부터)" })).data;
    await call("record_application", { action: "stage", id: created.id, stage: "수요조사 제출", status: "통과", date: "2026-09-11" });
    await call("record_application", { action: "stage", id: created.id, stage: "RFP 반영", status: "탈락", note: "다른 수요와 통합되어 미반영" });
    await call("record_application", { action: "link", id: created.id, stage: "수요조사 제출", path: filled.new_path });
    assert.match((await call("record_application", { action: "link", id: created.id, stage: "수요조사 제출", path: "구매·견적/장비 견적.docx" })).text, /AI 제외/);
    const listed = (await call("list_applications", { query: "그래핀", state: "탈락" })).data;
    assert.strictEqual(listed.total, 1);
    assert.match(listed.applications[0].progress, /탈락 \(RFP 반영\)/);
    const one = (await call("get_application", { id: created.id })).data;
    assert.deepStrictEqual(one.stages[0].docs, [filled.new_path]);
    assert.strictEqual(one.stages[1].note, "다른 수요와 통합되어 미반영");
    assert.match((await call("record_application", { action: "stage", id: created.id, stage: "없는 단계", status: "통과" })).text, /단계가 없습니다/);
    // 사업 자료: 사업 전체에 공고문, 이 건에만 RFP. AI 제외 문서는 붙지도 보이지도 않는다
    const prog = (await call("record_application", { action: "ref_link", program: "소재부품기술개발", path: report, kind: "공고문" })).data;
    assert.deepStrictEqual(prog.reference_docs, [{ path: report, kind: "공고문" }]);
    await call("record_application", { action: "ref_link", id: created.id, path: filled.new_path, kind: "RFP" });
    assert.match((await call("record_application", { action: "ref_link", program: "소재부품기술개발", path: "구매·견적/장비 견적.docx" })).text, /AI 제외/);
    assert.match((await call("record_application", { action: "ref_link", program: "없는 사업", path: report })).text, /지원 건이 없습니다/);
    const withRefs = (await call("get_application", { id: created.id })).data;
    assert.deepStrictEqual(withRefs.program_reference_docs, [{ path: report, kind: "공고문" }]);
    assert.deepStrictEqual(withRefs.own_reference_docs, [{ path: filled.new_path, kind: "RFP" }]);
    assert.deepStrictEqual((await call("list_applications", {})).data.programs, [{ name: "소재부품기술개발", applications: 1, reference_docs: 1 }]);
    assert.strictEqual((await call("get_program", { program: "소재부품기술개발" })).data.applications.length, 1);
    assert.match((await call("get_program", { program: "없는 사업" })).text, /사업이 없습니다/);
    // 주제·사업 카드, 작성 가이드: 없으면 양식과 만드는 순서, 저장하면 지원 건에서 있다고 보인다
    const noCard = (await call("get_card", { kind: "topic", name: "그래핀 스텔스" })).data;
    assert.strictEqual(noCard.exists, false);
    assert.match(noCard.card, /^# 주제 카드: 그래핀 스텔스/);
    assert.match(noCard.note_for_ai, /save_card/);
    assert.match((await call("save_card", { kind: "topic", name: "그래핀 스텔스", content: noCard.card.replace("## 1. 한 줄 정의", "## 1. 한 줄 정의\n광학투명 전자파 차폐"), change_summary: "처음 만듦" })).data.saved, /^Claude 지식\/주제\/그래핀 스텔스\.md$/);
    assert.match((await call("get_card", { kind: "topic", name: "그래핀 스텔스" })).data.card, /광학투명 전자파 차폐/);
    assert.deepStrictEqual((await call("get_card", { kind: "topic" })).data.cards.map((c) => c.name), ["그래핀 스텔스"]);
    const cardsOf = (await call("get_application", { id: created.id })).data.cards;
    assert.deepStrictEqual([cardsOf.topic.exists, cardsOf.program.exists, cardsOf.guides["수요조사서"].exists, cardsOf.guides["사업계획서"].exists], [true, false, false, false]);
    assert.match((await call("get_card", { kind: "guide" })).data.note_for_ai, /수요조사서, 사업계획서/);
    assert.match((await call("get_card", { kind: "guide", name: "수요조사서" })).data.card, /^# 작성 가이드: 수요조사서/);
    assert.match((await call("save_card", { kind: "program", content: "x" })).text, /이름/);
    // 카드 폴더는 문서 목록에 섞이지 않는다
    assert.ok(!(await call("search_documents", { query: "광학투명 전자파 차폐" })).text.includes("Claude 지식"));
    // 형식 바꾸기: 이 시험 환경(리눅스·한글 없음)에서는 윈도우 전용이라고 알려 준다. 지원하지 않는 조합도 알려 준다.
    if (process.platform !== "win32") assert.match((await call("convert_document", { path: report, to: "pdf" })).text, /윈도우/);
    assert.match((await call("convert_document", { path: report, to: "hwpx" })).text, /\.pdf 로만/);
    const v2 = (await call("fill_form", { path: report, fills: [{ id: "p1", text: "최종보고서(수정)" }] })).data;
    assert.match(v2.new_path, /최종보고서_v\d+\.docx$/);

    // 기록
    const log = fs.readFileSync(path.join(root, ".docmanager", "ai-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.some((l) => l.tool === "search_documents" && l.query === "그래핀"));
    assert.ok(log.some((l) => l.tool === "save_new_version" && l.change_summary === "시장 규모 갱신" && l.new_path === saved.new_path));
    assert.ok(log.some((l) => l.tool === "read_document" && l.error));
    assert.ok(log.some((l) => l.tool === "save_knowledge_card" && l.change_summary === "처음 작성"));
    assert.ok(log.some((l) => l.tool === "fill_form" && l.change_summary === "성과 채움" && l.filled === 1));
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
