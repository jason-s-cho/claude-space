const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("../lib/classify");

const cat = (doc, opts) => classify(doc, opts).category;

test("국가과제 문서는 파일 이름으로 세부 종류를 가른다", () => {
  assert.strictEqual(cat({ name: "2025 소재부품 연구개발계획서_v3", dir: "국가과제" }), "gov_plan");
  assert.strictEqual(cat({ name: "그래핀 센서 최종보고서", dir: "" }), "gov_report");
  assert.strictEqual(cat({ name: "2026 기술수요조사서", dir: "" }), "gov_notice");
});

test("본문만으로도 분류한다", () => {
  const text = "과제번호 RS-2025-01\n주관연구개발기관 에이비씨\n정부지원연구개발비\n중간보고서\n연구개발 결과";
  assert.strictEqual(cat({ name: "제출본", dir: "", text }), "gov_report");
});

test("'보고서' 한 단어만으로는 국가과제로 보지 않는다", () => {
  assert.notStrictEqual(cat({ name: "월간 영업 보고서", dir: "" }), "gov_report");
});

test("IR · 회사소개 · 홈페이지 · 카탈로그", () => {
  assert.strictEqual(cat({ name: "ABC_IR deck_2026 final" }), "ir");
  assert.strictEqual(cat({ name: "회사소개서_국문" }), "company");
  assert.strictEqual(cat({ name: "홈페이지 메뉴구조 v2" }), "website");
  assert.strictEqual(cat({ name: "2024 제품 카탈로그" }), "catalog");
});

test("영문 약어는 단어 단위로만 찾는다 (IR ≠ IRB, first)", () => {
  assert.strictEqual(cat({ name: "IRB 승인 first draft" }), "other");
});

test("고객사 이름이 경로에 있으면 요청자료, 본문에만 있으면 태그만", () => {
  const opts = { partners: [{ name: "현대모비스", aliases: ["모비스"] }] };
  const r1 = classify({ name: "단가표", dir: "고객/모비스" }, opts);
  assert.strictEqual(r1.category, "request");
  assert.ok(r1.tags.includes("현대모비스"));
  const r2 = classify({ name: "회사소개서", dir: "", text: "주요 고객사: 현대모비스" }, opts);
  assert.strictEqual(r2.category, "company");
  assert.ok(r2.tags.includes("현대모비스"));
});

test("태그: 연도 · 기관 · 버전 · 내 규칙", () => {
  const r = classify(
    { name: "25년 KEIT 사업계획서 최종본", dir: "", text: "산업통상자원부 그래핀 소재" },
    { tagRules: [{ tag: "그래핀", keywords: ["그래핀", "graphene"] }, { tag: "센서", keywords: [] }] }
  );
  for (const t of ["2025", "KEIT", "산업통상자원부", "최종본", "그래핀"]) assert.ok(r.tags.includes(t), t);
  assert.ok(!r.tags.includes("센서"));
});

test("단서가 없으면 미분류", () => {
  const r = classify({ name: "메모", dir: "", text: "회의록" });
  assert.strictEqual(r.category, "other");
  assert.deepStrictEqual(r.reasons, []);
});

test("분류 키워드를 더하거나 뺄 수 있다", () => {
  const doc = { name: "2025 기술로드맵", dir: "" };
  assert.strictEqual(cat(doc), "other");
  assert.strictEqual(cat(doc, { keywordOverrides: { gov_plan: { add: [["기술로드맵", 6]] } } }), "gov_plan");
  assert.notStrictEqual(cat({ name: "회사소개서" }, { keywordOverrides: { company: { remove: ["회사소개서", "회사소개", "회사 소개"] } } }), "company");
});

test("실제 파일 이름: IR · 구매견적 · 기술시장분석", () => {
  assert.strictEqual(cat({ name: "엠씨케이테크_그래핀_스텔스소재_투자검토자료_초안" }), "ir");
  assert.strictEqual(cat({ name: "엠씨케이테크_IR_260406" }), "ir");
  assert.strictEqual(cat({ name: "MCK_센서패키징_장비견적관리표" }), "purchase");
  assert.strictEqual(cat({ name: "PFAS_규제강화_기술개발동향_보고서" }), "analysis");
  assert.strictEqual(cat({ name: "Black_Semiconductor_Analysis" }), "analysis");
  // 소문자 ir 은 IR 자료가 아니다 (적외선)
  assert.notStrictEqual(cat({ name: "graphene_ir_sensitivity" }), "ir");
});

test("국가과제 단계: 협약 · 회의 · 정산", () => {
  assert.strictEqual(cat({ name: "수정사업계획서", dir: "별첨 1-1. 수정사업계획서(양식)" }), "gov_agreement");
  assert.strictEqual(cat({ name: "사업비 카드 신청서", dir: "별첨 2-2. 사업비 카드 개설" }), "gov_agreement");
  assert.strictEqual(cat({ name: "자료", dir: "251105 2세부 사전미팅" }), "gov_meeting");
  assert.strictEqual(cat({ name: "2025 사업비 정산 집행내역", dir: "", text: "주관기관 협약 사업비" }), "gov_settle");
  assert.strictEqual(cat({ name: "2026 창업지원사업 공고문" }), "gov_notice");
  // 국가과제 단서 없이 '회의록'만 있으면 국가과제 회의로 보지 않는다
  assert.notStrictEqual(cat({ name: "주간 회의록" }), "gov_meeting");
});

test("등록한 과제: 과제 이름 태그와 국가과제 분류", () => {
  const opts = { projects: [{ name: "2024 K-방산 제품고도화", aliases: ["K-방산", "제품고도화"] }] };
  const r = classify({ name: "최종보고서", dir: "[완료] 2024년 [K-방산] 제품고도화 지원사업" }, opts);
  assert.strictEqual(r.category, "gov_report");
  assert.strictEqual(r.project, "2024 K-방산 제품고도화");
  for (const t of ["2024 K-방산 제품고도화", "2024", "완료", "방산"]) assert.ok(r.tags.includes(t), t);
});

test("날짜: YYMMDD · YYYYMMDD 에서 연도", () => {
  assert.ok(classify({ name: "엠씨케이테크_IR_260406" }).tags.includes("2026"));
  assert.ok(classify({ name: "발표", dir: "250926 워크샵" }).tags.includes("2025"));
  assert.ok(classify({ name: "메모", dir: "20250508" }).tags.includes("2025"));
  // 날짜가 될 수 없는 6자리 숫자는 무시
  assert.ok(!classify({ name: "모델 123456" }).tags.some((t) => /^20\d\d$/.test(t)));
  assert.ok(!classify({ name: "부품 251399" }).tags.includes("2025"));
});

test("기술 분야 태그 (끌 수 있음)", () => {
  const r = classify({ name: "그래핀 스텔스 소재 투명발열 필름" });
  for (const t of ["그래핀", "스텔스·RAM", "투명발열체·TCF"]) assert.ok(r.tags.includes(t), t);
  assert.ok(!classify({ name: "그래핀 소재" }, { techTags: false }).tags.includes("그래핀"));
  assert.ok(!classify({ name: "수정사업계획서" }).tags.includes("수정본"));
});

test("고객사를 등록해도 견적·거래명세표·세금계산서는 구매·견적에 남고 고객사 태그만 붙는다", () => {
  const partners = [{ name: "중앙대학교", aliases: ["중앙대"] }];
  for (const name of ["260126_견적서_중앙대학교(GOPET 12L).pdf", "20260223 거래명세표-중앙대학교(GoPET 12L).xlsx", "260223_전자세금계산서_중앙대학교.pdf", "가격증빙자료_260123.hwp"]) {
    const r = classify({ rel: name, name, text: "" }, { partners });
    assert.strictEqual(r.category, "purchase", name);
  }
  const r = classify({ rel: "x/260223_전자세금계산서_중앙대학교.pdf", name: "260223_전자세금계산서_중앙대학교.pdf", text: "" }, { partners });
  assert.ok(r.tags.includes("중앙대학교"));
  assert.strictEqual(classify({ rel: "중앙대학교 요청사항 회신.docx", name: "중앙대학교 요청사항 회신.docx", text: "" }, { partners }).category, "request");
});

test("회사 증빙: 기본 서류 · 인증·확인서 · 실적·재무", () => {
  const cat = (name, text = "") => classify({ name, dir: "", text }).category;
  assert.strictEqual(cat("사업자등록증_엠씨케이테크"), "cert_basic");
  assert.strictEqual(cat("법인등기부등본_2026"), "cert_basic");
  assert.strictEqual(cat("벤처기업확인서"), "cert_auth");
  assert.strictEqual(cat("기업부설연구소 인정서"), "cert_auth");
  assert.strictEqual(cat("ISO 9001 인증서"), "cert_auth");
  assert.strictEqual(cat("수출실적증명서 2025"), "cert_perf");
  assert.strictEqual(cat("2025 표준재무제표"), "cert_perf");
  assert.strictEqual(cat("국세완납증명서"), "cert_perf");
  // 협약서 본문에 '사업자등록증 첨부'가 있어도 협약서다
  assert.strictEqual(cat("협약서", "사업자등록증 첨부 주관기관 협약 정부출연금"), "gov_agreement");
});

test("지식재산: 특허 출원 · 특허 등록 · 상표·디자인 (특허 동향 분석은 기술·시장 분석)", () => {
  const cat = (name, text = "") => classify({ name, dir: "", text }).category;
  assert.strictEqual(cat("특허출원서_그래핀 차폐"), "ip_patent_app");
  assert.strictEqual(cat("출원번호통지서"), "ip_patent_app");
  assert.strictEqual(cat("의견제출통지서 대응 의견서"), "ip_patent_app");
  assert.strictEqual(cat("특허증_그래핀"), "ip_patent_reg");
  assert.strictEqual(cat("등록결정서"), "ip_patent_reg");
  assert.strictEqual(cat("상표등록증_MCK"), "ip_mark");
  assert.strictEqual(cat("디자인등록증"), "ip_mark");
  assert.strictEqual(cat("그래핀 특허동향 분석"), "analysis");
});

test("개인정보 서류(등기부등본·주주명부, 주민등록번호)는 기본으로 Claude 에 보내지 않는다", () => {
  const tags = (name, text = "") => classify({ name, dir: "", text }).tags;
  assert.ok(tags("법인등기부등본_2026").includes("AI제외"));
  assert.ok(tags("등기사항전부증명서(말소사항포함)").includes("AI제외"));
  assert.ok(tags("주주명부").includes("AI제외"));
  assert.ok(tags("임원 명단", "대표이사 홍길동 800101-1234567").includes("AI제외"));
  assert.ok(!tags("임원 명단", "대표이사 홍길동 800101-1******").includes("AI제외")); // 가린 번호는 괜찮다
  assert.ok(!tags("사업자등록증").includes("AI제외"));
  assert.ok(!tags("출원번호통지서", "출원번호 10-2024-0123456").includes("AI제외"));
});

test("회사 증빙 · 인사: 직원 서류, 급여·계약 서류는 기본으로 Claude 제외", () => {
  const r = (name, text = "") => classify({ name, dir: "", text });
  for (const n of ["재직증명서_홍길동", "경력증명서", "졸업증명서_김철수", "국가기술자격증 사본", "이력서_연구원", "건강보험 자격득실확인서"]) assert.strictEqual(r(n).category, "cert_hr", n);
  for (const n of ["근로계약서_홍길동", "2025 급여명세서", "원천징수영수증_2024"]) {
    assert.strictEqual(r(n).category, "cert_hr", n);
    assert.ok(r(n).tags.includes("AI제외"), n);
  }
  assert.ok(!r("재직증명서_홍길동").tags.includes("AI제외"));
  assert.strictEqual(r("사업자등록증").category, "cert_basic"); // 다른 증빙은 그대로
});
