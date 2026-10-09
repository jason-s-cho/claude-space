const test = require("node:test");
const assert = require("node:assert");
const JSZip = require("jszip");
const forms = require("../lib/forms");
const { extract } = require("../lib/extract");
const fs = require("fs");
const os = require("os");
const path = require("path");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, { style, rPr = "", mark = "" } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${mark ? `<w:rPr>${mark}</w:rPr>` : ""}</w:pPr>${text ? `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t>${text}</w:t></w:r>` : ""}</w:p>`;
const tc = (inner, pr = "") => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${pr}</w:tcPr>${inner}</w:tc>`;

// 국가과제 신청서 비슷한 워드 양식: 제목, 표(합친 칸·세로 병합·빈 칸·내용 컨트롤), 본문 문단
async function docxForm() {
  const body =
    p("2027년 기술수요조사서", { style: "Title", rPr: "<w:b/>" }) +
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>` +
    `<w:tr>${tc(p("과제명", { rPr: "<w:b/>" }))}${tc(p("", { mark: '<w:sz w:val="22"/><w:color w:val="1F3864"/>' }), '<w:gridSpan w:val="2"/>')}</w:tr>` +
    `<w:tr>${tc(p("기관"), '<w:vMerge w:val="restart"/>')}${tc(p("주관"))}${tc(p("(기관명)", { rPr: '<w:i/><w:color w:val="808080"/>' }))}</w:tr>` +
    `<w:tr>${tc(p(""), "<w:vMerge/>")}${tc(p("참여"))}${tc(`<w:sdt><w:sdtPr/><w:sdtContent>${p("여기를 눌러 입력")}</w:sdtContent></w:sdt>`)}</w:tr>` +
    `</w:tbl>` +
    p("1. 개요", { style: "Heading1" }) +
    p("(개요를 작성하세요)", { rPr: '<w:rFonts w:ascii="맑은 고딕"/><w:sz w:val="20"/>' }) +
    `<w:sectPr/>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

// 한글 양식: 첫 문단(구역 설정 포함), 누름틀 문단, 표(합친 칸)
async function hwpxForm() {
  const HP = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"';
  const para = (runs, pr = "3") => `<hp:p id="0" paraPrIDRef="${pr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}<hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p>`;
  const cell = (r, c, text, span = 1) =>
    `<hp:tc name="" header="0" borderFillIDRef="4"><hp:subList id="" vertAlign="CENTER">${para(text ? `<hp:run charPrIDRef="5"><hp:t>${text}</hp:t></hp:run>` : '<hp:run charPrIDRef="6"/>', "16")}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${span}" rowSpan="1"/><hp:cellSz width="10000" height="282"/></hp:tc>`;
  const sec =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${HP}>` +
    para('<hp:run charPrIDRef="0"><hp:secPr id=""><hp:pagePr width="59528"/></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER"/></hp:ctrl></hp:run><hp:run charPrIDRef="9"><hp:t>사업계획서</hp:t></hp:run>') +
    para('<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="7" type="CLICK_HERE" name="날짜"/></hp:ctrl></hp:run><hp:run charPrIDRef="7"><hp:t>날짜를 입력</hp:t></hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="7"/></hp:ctrl><hp:t/></hp:run>') +
    para(`<hp:run charPrIDRef="0"><hp:tbl id="1" rowCnt="2" colCnt="2"><hp:tr>${cell(0, 0, "과제명")}${cell(0, 1, "")}</hp:tr><hp:tr>${cell(1, 0, "연구 목표", 2)}</hp:tr></hp:tbl><hp:t/></hp:run>`) +
    para('<hp:run charPrIDRef="3"/>') +
    `</hs:sec>`;
  const zip = new JSZip();
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file("version.xml", '<?xml version="1.0"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version"/>');
  zip.file("Contents/header.xml", '<?xml version="1.0"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"><hh:refList><hh:charProperties><hh:charPr id="5" textColor="#000000"/><hh:charPr id="6" textColor="#000000"/><hh:charPr id="7" textColor="#FF0000"><hh:italic/></hh:charPr><hh:charPr id="9" textColor="#2E74B5"/></hh:charProperties><hh:styles><hh:style id="0" type="PARA" name="바탕글" engName="Normal" charPrIDRef="1"/></hh:styles></hh:refList></hh:head>');
  zip.file("Contents/section0.xml", sec);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("워드 양식: 칸 목록 (합친 칸, 세로 병합, 내용 컨트롤, 제목 붙이기)", async () => {
  const r = await forms.inspectForm(await docxForm(), ".docx");
  const ids = r.slots.map((s) => s.id);
  assert.deepStrictEqual(ids, ["p1", "t1.r1.c1", "t1.r1.c2", "t1.r2.c1", "t1.r2.c2", "t1.r2.c3", "t1.r3.c2", "t1.r3.c3", "p2", "p3"]);
  const by = Object.fromEntries(r.slots.map((s) => [s.id, s]));
  assert.strictEqual(by["t1.r1.c2"].row_label, "과제명");
  assert.ok(by["t1.r1.c2"].empty);
  assert.strictEqual(by["t1.r3.c3"].text, "여기를 눌러 입력");
  assert.strictEqual(by["t1.r3.c3"].row_label, "참여");
  assert.strictEqual(by["t1.r3.c3"].row_header, undefined); // 세로 병합으로 왼쪽 칸이 비어 있음
  assert.strictEqual(by["p2"].style, "Heading1");
  assert.strictEqual(r.tables, 1);
});

test("워드 양식 채우기: 글자만 바뀌고 글자 모양·표 구조는 그대로", async () => {
  const src = await docxForm();
  const { buffer: out, restyled } = await forms.fillForm(src, ".docx", [
    { id: "t1.r1.c2", text: "그래핀 스텔스 패널 & <광대역>" },
    { id: "t1.r2.c3", text: "엠씨케이테크" },
    { id: "t1.r3.c3", text: "한국섬유기계융합연구원" },
    { id: "p3", text: "첫째 문단\n둘째 문단\t(탭)" },
  ]);
  const xml = await (await JSZip.loadAsync(out)).file("word/document.xml").async("string");
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));
  // 빈 칸은 문단 기호의 글자 모양(크기·색)을 따른다
  assert.match(xml, /<w:r><w:rPr><w:sz w:val="22"\/><w:color w:val="1F3864"\/><\/w:rPr><w:t xml:space="preserve">그래핀 스텔스 패널 &amp; &lt;광대역&gt;<\/w:t><\/w:r>/);
  // 회색 기울임 안내 글자 "(기관명)" 자리는 보통 글자 모양으로
  assert.match(xml, /<w:p><w:pPr\/><w:r><w:t xml:space="preserve">엠씨케이테크/);
  assert.deepStrictEqual(restyled, ["t1.r2.c3"]);
  assert.match(xml, /<w:sdtContent><w:p>.*한국섬유기계융합연구원/); // 내용 컨트롤 안에 그대로
  assert.match(xml, /<w:gridSpan w:val="2"\/>/);
  assert.strictEqual((xml.match(/<w:vMerge/g) || []).length, 2);
  // 줄바꿈은 같은 모양의 문단으로, 탭은 탭으로
  assert.match(xml, /<w:t xml:space="preserve">첫째 문단<\/w:t><\/w:r><\/w:p><w:p><w:pPr\/><w:r><w:rPr><w:rFonts w:ascii="맑은 고딕"\/><w:sz w:val="20"\/><\/w:rPr><w:t xml:space="preserve">둘째 문단<\/w:t><w:tab\/>/);
  const f = path.join(os.tmpdir(), `docmgr-form-${process.pid}.docx`);
  fs.writeFileSync(f, out);
  const text = (await extract(f)).text;
  fs.unlinkSync(f);
  assert.ok(text.includes("그래핀 스텔스 패널") && text.includes("둘째 문단") && !text.includes("(개요를 작성하세요)"));
  // 칸을 바꾼 뒤 다시 보면 문단 번호가 늘어난다 (둘째 문단)
  const again = await forms.inspectForm(out, ".docx");
  assert.strictEqual(again.slots.find((s) => s.id === "p4").text, "둘째 문단\t(탭)");
});

test("한글 양식: 칸 목록과 채우기 (구역 설정·누름틀·합친 칸 유지)", async () => {
  const src = await hwpxForm();
  const r = await forms.inspectForm(src, ".hwpx");
  assert.deepStrictEqual(r.slots.map((s) => s.id), ["p1", "p2", "t1.r1.c1", "t1.r1.c2", "t1.r2.c1", "p3"]);
  assert.strictEqual(r.slots[3].row_label, "과제명");
  const { buffer: out, restyled } = await forms.fillForm(src, ".hwpx", [
    { id: "p1", text: "2027 사업계획서" },
    { id: "p2", text: "2026. 10. 9." },
    { id: "t1.r1.c2", text: "그래핀 스텔스 패널" },
    { id: "t1.r2.c1", text: "목표 1\n목표 2" },
  ]);
  const zip = await JSZip.loadAsync(out);
  assert.strictEqual(Object.keys(zip.files)[0], "mimetype");
  assert.strictEqual(zip.files.mimetype._data.compression.magic, "\x00\x00"); // 압축 없이
  const xml = await zip.file("Contents/section0.xml").async("string");
  assert.match(xml, /<hp:secPr id=""><hp:pagePr width="59528"\/><\/hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER"\/><\/hp:ctrl><\/hp:run><hp:run charPrIDRef="9"><hp:t>2027 사업계획서<\/hp:t>/);
  // 누름틀 안쪽에 글자가 들어가고, 빨간 기울임 안내 글자 모양 대신 문단 스타일의 기본 글자 모양(1)을 쓴다
  assert.match(xml, /<hp:fieldBegin id="7" type="CLICK_HERE" name="날짜"\/><\/hp:ctrl><\/hp:run><hp:run charPrIDRef="1"><hp:t>2026. 10. 9.<\/hp:t><\/hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd/);
  assert.deepStrictEqual(restyled, ["p2"]); // 제목의 파란 글자(9)는 기울임이 아니라 그대로
  // 빈 칸은 그 칸의 글자 모양(charPrIDRef=6)
  assert.match(xml, /<hp:run charPrIDRef="6"><hp:t>그래핀 스텔스 패널<\/hp:t><\/hp:run>/);
  // 여러 줄은 같은 문단 모양으로, 합친 칸 정보는 그대로
  assert.match(xml, /<hp:t>목표 1<\/hp:t><\/hp:run><\/hp:p><hp:p id="0" paraPrIDRef="16"[^>]*><hp:run charPrIDRef="5"><hp:t>목표 2<\/hp:t>/);
  assert.match(xml, /<hp:cellSpan colSpan="2" rowSpan="1"\/>/);
  // 바꾼 문단의 줄 배치 정보는 지운다 (한글이 다시 계산), 안 바꾼 문단은 그대로
  assert.strictEqual((xml.match(/<hp:linesegarray>/g) || []).length, 3);
  const f = path.join(os.tmpdir(), `docmgr-form-${process.pid}.hwpx`);
  fs.writeFileSync(f, out);
  const text = (await extract(f)).text;
  fs.unlinkSync(f);
  assert.ok(text.includes("2027 사업계획서") && text.includes("목표 2") && !text.includes("날짜를 입력"));
});

test("양식 채우기: 잘못된 칸 번호면 아무것도 바꾸지 않고, .hwp 는 hwpx 로 저장하라고 알려 준다", async () => {
  const src = await docxForm();
  await assert.rejects(forms.fillForm(src, ".docx", [{ id: "p1", text: "a" }, { id: "t9.r1.c1", text: "b" }]), /없는 칸 번호입니다: t9\.r1\.c1/);
  await assert.rejects(forms.fillForm(src, ".docx", [{ id: "p1", text: "a" }, { id: "p1", text: "b" }]), /두 번/);
  await assert.rejects(forms.inspectForm(Buffer.from("x"), ".hwp"), /다른 이름으로 저장.*hwpx/);
  await assert.rejects(forms.inspectForm(Buffer.from("not a zip"), ".docx"), /열 수 없습니다/);
});

// 참여인력 표: 제목 행 + 빈 행 하나 + 합계 행
async function docxPeopleForm() {
  const row = (cells, pr = "") => `<w:tr>${cells.map((c) => tc(p(c, { rPr: c ? "<w:b/>" : "" }), pr)).join("")}</w:tr>`;
  const body =
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>` +
    row(["성명", "직위", "참여율"]) +
    `<w:tr>${tc(p("", { mark: '<w:sz w:val="18"/>' }))}${tc(p(""))}${tc(p(""))}</w:tr>` +
    row(["합계", "", ""]) +
    `</w:tbl>` +
    p("□ 해당   □ 미해당") +
    `<w:sdt><w:sdtPr><w14:checkbox xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:p><w:r><w:t>☐</w:t></w:r><w:r><w:t xml:space="preserve"> 동의함</w:t></w:r></w:p></w:sdtContent></w:sdt>` +
    `<w:sectPr/>`;
  const zip = await JSZip.loadAsync(await docxForm());
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("워드 양식: 표 행 늘리기와 체크 표시", async () => {
  const src = await docxPeopleForm();
  const r = await forms.inspectForm(src, ".docx");
  assert.deepStrictEqual(r.slots.map((s) => s.id).slice(0, 9), ["t1.r1.c1", "t1.r1.c2", "t1.r1.c3", "t1.r2.c1", "t1.r2.c2", "t1.r2.c3", "t1.r3.c1", "t1.r3.c2", "t1.r3.c3"]);
  const out = await forms.fillForm(src, ".docx", [{ id: "p1", check: "해당" }, { id: "p2", check: "동의함" }, { id: "t1.r3.c3", text: "150%" }], {
    tableRows: [{ table: "t1", template_row: 2, rows: [["홍길동", "책임", "50%"], ["김철수", "선임", "50%"], ["이영희"]] }],
  });
  assert.strictEqual(out.rows_added, 2);
  const again = await forms.inspectForm(out.buffer, ".docx");
  const text = Object.fromEntries(again.slots.map((s) => [s.id, s.text]));
  assert.deepStrictEqual(
    [1, 2, 3, 4, 5].map((r) => [1, 2, 3].map((c) => text[`t1.r${r}.c${c}`]).join("|")),
    ["성명|직위|참여율", "홍길동|책임|50%", "김철수|선임|50%", "이영희||", "합계||150%"]
  );
  assert.strictEqual(text.p1, "■ 해당   □ 미해당"); // '미해당' 안의 '해당' 은 건드리지 않는다
  assert.strictEqual(text.p2, "☑ 동의함");
  const xml = await (await JSZip.loadAsync(out.buffer)).file("word/document.xml").async("string");
  assert.match(xml, /<w14:checked w14:val="1"\/>/);
  // 복사한 행도 원래 빈 칸의 글자 모양(문단 기호 크기)을 따른다
  assert.strictEqual((xml.match(/<w:rPr><w:sz w:val="18"\/><\/w:rPr><w:t xml:space="preserve">/g) || []).length, 3);
  // 잘못된 요청은 아무것도 바꾸지 않는다
  await assert.rejects(forms.fillForm(src, ".docx", [], { tableRows: [{ table: "t1", template_row: 2, rows: [["a", "b", "c", "d"]] }] }), /칸은 3개인데 값이 4개/);
  await assert.rejects(forms.fillForm(src, ".docx", [{ id: "t1.r2.c1", text: "x" }], { tableRows: [{ table: "t1", template_row: 2, rows: [["a"]] }] }), /같은 행/);
  await assert.rejects(forms.fillForm(src, ".docx", [{ id: "p1", check: "없는말" }]), /네모/);
  await assert.rejects(forms.fillForm(src, ".docx", [], { tableRows: [{ table: "t9", template_row: 1, rows: [["a"]] }] }), /없는 표/);
});

test("한글 양식: 표 행 늘리면 아래 행 번호·행 수·표 높이를 맞춘다", async () => {
  const HP = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"';
  const para = (runs) => `<hp:p id="0" paraPrIDRef="3" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}</hp:p>`;
  const cell = (r, c, text, rowSpan = 1) =>
    `<hp:tc name="" header="0" borderFillIDRef="4"><hp:subList id="">${para(text ? `<hp:run charPrIDRef="5"><hp:t>${text}</hp:t></hp:run>` : '<hp:run charPrIDRef="6"/>')}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="${rowSpan}"/><hp:cellSz width="10000" height="1000"/></hp:tc>`;
  const tbl = `<hp:tbl id="1" rowCnt="4" colCnt="2"><hp:sz width="20000" height="4000"/><hp:tr>${cell(0, 0, "장비명")}${cell(0, 1, "수량")}</hp:tr><hp:tr>${cell(1, 0, "")}${cell(1, 1, "")}</hp:tr><hp:tr>${cell(2, 0, "비고", 2)}${cell(2, 1, "")}</hp:tr><hp:tr>${cell(3, 1, "")}</hp:tr></hp:tbl>`;
  const sec = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${HP}>${para(`<hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run>`)}${para('<hp:run charPrIDRef="0"><hp:t>□ 신규  □ 계속</hp:t></hp:run>')}</hs:sec>`;
  const zip = await JSZip.loadAsync(await hwpxForm());
  zip.file("Contents/section0.xml", sec);
  const src = await zip.generateAsync({ type: "nodebuffer" });
  const out = await forms.fillForm(src, ".hwpx", [{ id: "p1", check: ["계속"] }], { tableRows: [{ table: "t1", template_row: 2, rows: [["SEM", "1"], ["XRD", "2"], ["AFM", "1"]] }] });
  const x = await (await JSZip.loadAsync(out.buffer)).file("Contents/section0.xml").async("string");
  assert.match(x, /rowCnt="6"/);
  assert.match(x, /<hp:sz width="20000" height="6000"\/>/);
  const addrs = [...x.matchAll(/<hp:t>([^<]*)<\/hp:t><\/hp:run><\/hp:p><\/hp:subList><hp:cellAddr colAddr="(\d)" rowAddr="(\d)"/g)].map((m) => `${m[1]}@${m[3]}.${m[2]}`);
  assert.deepStrictEqual(addrs, ["장비명@0.0", "수량@0.1", "SEM@1.0", "1@1.1", "XRD@2.0", "2@2.1", "AFM@3.0", "1@3.1", "비고@4.0"]);
  assert.match(x, /<hp:cellAddr colAddr="1" rowAddr="5"\/>/); // 맨 아래 행도 밀렸다
  assert.match(x, /<hp:t>□ 신규  ■ 계속<\/hp:t>/);
  // 세로로 합친 칸이 있는 행은 본으로 쓸 수 없다
  await assert.rejects(forms.fillForm(src, ".hwpx", [], { tableRows: [{ table: "t1", template_row: 3, rows: [["a"]] }] }), /세로로 합친/);
  await assert.rejects(forms.fillForm(src, ".hwpx", [], { tableRows: [{ table: "t1", template_row: 4, rows: [["a"]] }] }), /세로로 합쳐/);
});
