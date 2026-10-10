// 문서 보관함 Claude 커넥터 (MCP 서버, stdio).
// Claude 데스크톱 앱이나 Claude Code 가 이 프로그램을 실행해서 보관함을 검색·읽기·새 버전 저장한다.
//
// 실행: 앱 실행 파일을 Node 처럼 돌린다.
//   ELECTRON_RUN_AS_NODE=1  DOCMANAGER_USERDATA=<앱 데이터 폴더>  "<문서 보관함.exe>" "<app.asar>/mcp/server.js"
// (설정 → Claude 연결 에서 '연결' 을 누르면 Claude 데스크톱 설정에 이 내용이 자동으로 들어간다)
//
// 표준 출력(stdout)은 MCP 통신 전용이므로 여기서는 console.log 를 쓰지 않는다.
const os = require("os");
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { Library } = require("../lib/library");
const knowledge = require("../lib/knowledge");
const cards = require("../lib/cards");

const pkg = require("../package.json");

// 앱 데이터 폴더: 연결할 때 앱이 DOCMANAGER_USERDATA 로 알려 준다. 없으면 흔한 위치에서 찾는다.
function findUserData() {
  if (process.env.DOCMANAGER_USERDATA) return process.env.DOCMANAGER_USERDATA;
  const base =
    process.platform === "win32" ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  for (const name of ["문서 보관함", "doc-manager"]) {
    const dir = path.join(base, name);
    if (fs.existsSync(path.join(dir, "settings.json"))) return dir;
  }
  return path.join(base, "문서 보관함");
}

const lib = new Library({ userDataDir: findUserData() });

const INSTRUCTIONS = `이 서버는 사용자가 직접 작성한 업무 문서(국가과제·지원사업 계획서/보고서, IR·회사소개, 홍보, 기술·시장 분석, 고객사 자료, 견적 등)를 모아 둔 '문서 보관함'입니다.
- 문서를 새로 쓰거나 고치기 전에는 get_knowledge 로 '회사 지식 카드'(회사 개요·기술·성능 수치·과제 이력·고객사·자주 쓰는 표현)를 먼저 읽고, 그 사실과 표현을 우선 쓰세요.
- 먼저 library_overview 로 분류·과제·태그를 보고, search_documents 로 찾은 뒤 read_document 로 본문을 읽으세요. 긴 문서는 next_offset 으로 이어 읽습니다.
- 기본 검색 결과는 각 문서의 최신 버전만 보여 줍니다. 이전 버전이 필요하면 list_versions 를 쓰세요.
- '주제 카드'·'사업 카드'·'작성 가이드'는 이 보관함의 작성 카드입니다. 만들거나 고쳐 달라고 하면 get_card 로 양식을 받아 그 구조대로 채워 save_card 로 저장하세요 (작성 가이드는 문서 종류마다 한 장, 수요조사서·사업계획서의 항목 종류별 쓰는 법입니다).
- 사업에 내는 문서(수요조사서·사업계획서·발표자료)는 양식(inspect_form) × 주제 카드 × 사업 카드 × 작성 가이드(get_card)를 함께 보고 씁니다. 자세한 순서는 'write_application_document' 프롬프트와 같습니다: 바탕 자료 읽기 → 칸별 요약을 사용자에게 확인 → fill_form → record_application.
- 공고문·RFP·안내문을 읽다가 접수 마감·수요조사 마감 같은 날짜를 찾으면, 해당 지원 건 단계에 마감(record_application action: stage, due)을 적어 둘지 사용자에게 묻고 적으세요. 앱이 마감 전에 알려 줍니다.
- 사업에 내는 문서를 쓸 때는 list_applications 로 같은 주제·같은 사업의 지원 건을 찾아, 단계별 결과와 탈락 사유(평가 의견)를 읽고 같은 약점을 피하세요. 통과한 건의 표현은 다시 써도 됩니다. 수요조사가 RFP 에 반영됐으면 계획서는 그 RFP 문구에 맞춥니다. 쓰기 전에 get_program(또는 get_application 의 program_reference_docs)으로 그 사업의 공고문·RFP·평가 기준·작성 양식을 먼저 읽고, 공고의 요구 사항과 평가 항목에 맞춰 쓰세요. 문서를 다 쓰면 record_application 으로 지원 건과 단계 결과를 기록하세요.
- 새 버전을 저장했으면 compare_versions 로 원본과 바뀐 곳(특히 바뀐 숫자)을 확인해 사용자에게 짧게 알려 주세요.
- 새 문서나 계획서를 쓸 때는 find_related_documents 로 재사용할 만한 이전 자료(같은 과제·기술·키워드)를 찾으세요.
- 기존 파일은 절대 고칠 수 없습니다. 고친 결과는 항상 새 버전으로 저장합니다:
  · 파일을 직접 만들 수 있으면(예: docx/pptx 를 생성) save_new_version 에 base64 로 보냅니다.
  · 로컬 파일을 직접 편집할 수 있는 환경(Claude Code)이면 prepare_new_version 으로 복사본 경로를 받아 그 파일을 편집합니다.
- 기관 양식(워드 .docx, 한글 .hwpx)을 채울 때는 파일을 새로 만들지 말고 inspect_form 으로 칸 번호(p3, t1.r2.c3 …)와 표 제목을 확인한 뒤 fill_form 으로 글자만 채우세요. 서식·표·칸 크기가 그대로 유지되어 바로 제출할 수 있는 파일이 됩니다. 한글 .hwp·워드 .doc 양식은 convert_document 로 .hwpx/.docx 사본을 먼저 만드세요. 제출용 PDF 도 convert_document 로 만듭니다.
- 'AI제외' 태그나 사용자가 제외한 분류의 문서는 보이지 않습니다. 사용자가 그런 문서를 찾으면 제외 설정 때문일 수 있다고 알려 주세요.`;

const server = new McpServer({ name: "doc-manager", title: "문서 보관함", version: pkg.version }, { instructions: INSTRUCTIONS });

const asText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// 도구 하나를 등록한다: 오류는 Claude 가 읽을 수 있는 메시지로, 사용 기록은 ai-log 로.
function tool(name, config, fn, logOf) {
  server.registerTool(name, config, async (args) => {
    try {
      const result = await fn(args || {});
      lib.log(name, logOf ? logOf(args || {}, result) : {});
      return asText(result);
    } catch (e) {
      lib.log(name, { ...(logOf ? logOf(args || {}, null) : {}), error: String((e && e.message) || e) });
      return { isError: true, content: [{ type: "text", text: String((e && e.message) || e) }] };
    }
  });
}

const pathArg = z.string().describe("문서 경로. search_documents 결과의 path 값을 그대로 넣습니다 (예: 회사소개/IR·투자/엠씨케이테크_IR_260406.pptx)");

tool(
  "library_overview",
  {
    title: "보관함 둘러보기",
    description: "문서 보관함의 분류별 문서 수, 등록된 과제·고객사, 많이 쓰인 태그, 검색 문법을 보여 줍니다. 처음에 한 번 부르면 무엇이 있는지 알 수 있습니다.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => lib.overview(),
  () => ({})
);

tool(
  "search_documents",
  {
    title: "문서 검색",
    description:
      "파일 이름·폴더·태그·핵심 키워드·본문에서 문서를 찾습니다. " +
      '문법: 단어 여러 개는 모두 포함, "구절"(띄어쓰기 무시), A|B, -제외어, #태그, 분류:보고서, 연도:2025, 형식:ppt|word|excel|pdf|hwp, 폴더:이름, 이름:최종, 키워드:그래핀. ' +
      "빈 검색어면 최근 문서부터 보여 줍니다. 기본은 문서마다 최신 버전만 보여 줍니다.",
    inputSchema: {
      query: z.string().describe("검색어 (예: '그래핀 스텔스 분류:IR', '#2024 K-방산 제품고도화 분류:보고서')"),
      limit: z.number().int().min(1).max(50).optional().describe("최대 결과 수 (기본 15)"),
      include_old_versions: z.boolean().optional().describe("이전 버전도 함께 보려면 true"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit, include_old_versions }) => lib.search(query, { limit: limit || 15, latestOnly: !include_old_versions }),
  (a, r) => ({ query: a.query, results: r ? r.results.map((x) => x.path) : undefined })
);

tool(
  "read_document",
  {
    title: "문서 읽기",
    description: `문서 본문을 글자로 읽습니다 (Word·PowerPoint·Excel·PDF·한글). 한 번에 최대 ${20000}자씩이며, next_offset 이 있으면 그 값으로 다시 불러 이어 읽습니다.`,
    inputSchema: {
      path: pathArg,
      offset: z.number().int().min(0).optional().describe("이어 읽을 위치 (이전 결과의 next_offset)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ path: rel, offset }) => lib.read(rel, { offset: offset || 0 }),
  (a) => ({ path: a.path, offset: a.offset || 0 })
);

tool(
  "list_versions",
  {
    title: "버전 기록",
    description: "같은 문서의 여러 버전(초안·v01·날짜·(2) 등)을 최신순으로 보여 줍니다. 어느 것이 최신본인지 확인할 때 씁니다.",
    inputSchema: { path: pathArg },
    annotations: { readOnlyHint: true },
  },
  async ({ path: rel }) => lib.versions(rel),
  (a) => ({ path: a.path })
);

tool(
  "find_related_documents",
  {
    title: "관련 문서 찾기",
    description: "이 문서와 같은 과제·고객사·기술 태그를 쓰거나 핵심 키워드가 겹치는 다른 문서를 찾습니다. 새 계획서·IR을 쓸 때 재사용할 이전 자료를 찾는 데 씁니다.",
    inputSchema: { path: pathArg, limit: z.number().int().min(1).max(30).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ path: rel, limit }) => lib.related(rel, { limit: limit || 10 }),
  (a, r) => ({ path: a.path, results: r ? r.related.map((x) => x.path) : undefined })
);

tool(
  "save_new_version",
  {
    title: "새 버전으로 저장",
    description:
      "고친 문서 파일을 원본과 같은 폴더에 다음 버전 이름(…_v02, 오늘 날짜, …_v2)으로 저장합니다. 원본과 기존 파일은 절대 덮어쓰지 않습니다. " +
      "파일 전체 내용을 base64 로 보냅니다. 형식을 바꿔 저장하려면 file_extension 을 줍니다 (예: PDF 를 보고 docx 로 다시 쓴 경우). 저장하면 문서 보관함이 자동으로 분류하고 버전 기록에 묶습니다.",
    inputSchema: {
      path: pathArg.describe("고친 원본 문서의 경로"),
      content_base64: z.string().describe("새 파일 전체 내용 (base64)"),
      file_extension: z.string().optional().describe("원본과 다른 형식으로 저장할 때 확장자 (예: docx, pptx, xlsx, hwpx)"),
      change_summary: z.string().optional().describe("무엇을 고쳤는지 한두 문장 (기록에 남습니다)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ path: rel, content_base64, file_extension }) => lib.saveNewVersion(rel, content_base64, { ext: file_extension }),
  (a, r) => ({ path: a.path, new_path: r ? r.new_path : undefined, change_summary: a.change_summary })
);

tool(
  "prepare_new_version",
  {
    title: "새 버전 복사본 만들기",
    description:
      "원본을 다음 버전 이름으로 복사하고 그 파일의 전체 경로(absolute_path)를 돌려줍니다. 로컬 파일을 직접 편집할 수 있을 때(Claude Code 등) 이 복사본을 고치면 됩니다. 원본은 그대로 남습니다.",
    inputSchema: { path: pathArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ path: rel }) => lib.prepareNewVersion(rel),
  (a, r) => ({ path: a.path, new_path: r ? r.new_path : undefined })
);

tool(
  "inspect_form",
  {
    title: "양식 칸 보기",
    description:
      "워드(.docx)·한글(.hwpx) 양식을 칸 목록으로 보여 줍니다. 표 밖 문단은 p1, p2 …, 표 칸은 t1.r2.c3(1번째 표 2행 3열) 형식의 id 이고, " +
      "칸마다 지금 글자(text), 빈 칸 여부(empty), 문단 스타일(style, 예: 개요 1·Heading1), 표 칸이면 같은 행 왼쪽 제목(row_label)·맨 앞 열(row_header)·같은 열 맨 위 제목(column_label)을 줍니다. " +
      "'(입력)', '여기에 작성', '○○○' 같은 안내 문구나 빈 칸이 채울 곳입니다. table_list 에는 표마다 행 수·첫 행(제목)·복사할 수 없는 행(세로로 합친 칸)이 있습니다. " +
      "칸이 많으면 next_offset 으로 이어 봅니다. 긴 본문 전체는 read_document 로 읽으세요. " +
      "한글 .hwp·옛 워드 .doc 은 지원하지 않습니다(사용자에게 .hwpx/.docx 로 저장해 달라고 하세요).",
    inputSchema: {
      path: pathArg.describe("양식 문서 경로 (search_documents 결과의 path, 또는 fill_form 이 돌려준 new_path)"),
      offset: z.number().int().min(0).optional().describe("이어 볼 위치 (이전 결과의 next_offset)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ path: rel, offset }) => lib.inspectForm(rel, { offset: offset || 0 }),
  (a) => ({ path: a.path, offset: a.offset || 0 })
);

tool(
  "fill_form",
  {
    title: "양식 채우기",
    description:
      "inspect_form 의 칸 id 대로 글자를 바꿔 새 파일로 저장합니다. 글꼴·크기·표·칸 크기·문단 모양·누름틀은 그대로 두고 글자만 바꾸므로 기관 양식을 그대로 제출용으로 만들 수 있습니다. " +
      "원본은 절대 바뀌지 않습니다. text 의 줄바꿈(\\n)은 같은 모양의 문단을 더 만듭니다. 회색·기울임 안내 문구 자리는 보통 글자 모양으로 바꿔 씁니다. " +
      "체크 표시: text 대신 check(또는 uncheck)에 보기 이름을 주면 그 앞의 □ 를 ■ 로 바꿉니다 (예: '□ 해당 □ 미해당' 칸에 check: '해당'). " +
      "행이 모자란 표(참여인력·장비·예산·특허 목록 등)는 table_rows 로: template_row 행을 본으로 rows 의 첫 값 묶음은 그 행에, 나머지는 그 행을 복사해 바로 아래에 넣습니다 (값은 그 행의 칸에 왼쪽부터; 합계 행 등 아래 행은 밀려 내려갑니다). " +
      "한 번에 모든 칸을 채우세요 (줄을 늘리면 뒤쪽 문단 번호가 바뀌므로, 새 파일을 다시 고치려면 inspect_form 을 새 경로로 다시 부릅니다). " +
      "없는 칸 번호가 하나라도 있으면 아무것도 저장하지 않습니다.",
    inputSchema: {
      path: pathArg.describe("채울 양식 문서 경로"),
      fills: z
        .array(
          z.object({
            id: z.string().describe("칸 id (예: p12, t1.r2.c3)"),
            text: z.string().optional().describe("넣을 글자. 빈 문자열이면 칸을 비웁니다"),
            check: z.union([z.string(), z.array(z.string())]).optional().describe("앞의 □ 를 ■ 로 바꿀 보기 이름 (예: '해당', ['신규', '계속'])"),
            uncheck: z.union([z.string(), z.array(z.string())]).optional().describe("앞의 ■ 를 □ 로 되돌릴 보기 이름"),
          })
        )
        .max(3000)
        .optional()
        .describe("바꿀 칸 목록 (칸마다 text, check, uncheck 중 하나)"),
      table_rows: z
        .array(
          z.object({
            table: z.string().describe("표 id (예: t3)"),
            template_row: z.number().int().min(1).describe("본으로 쓸 행 번호 (1부터, 보통 첫 빈 행)"),
            rows: z.array(z.array(z.string())).min(1).max(500).describe("행마다 칸 값 목록 (왼쪽부터)"),
          })
        )
        .optional()
        .describe("행을 늘려 채울 표들"),
      new_name: z.string().optional().describe("새 파일 이름 (예: 2027_소부장_수요조사서_엠씨케이테크.hwpx). 원본과 같은 폴더에 저장. 빼면 다음 버전 이름(…_v2)"),
      change_summary: z.string().optional().describe("무엇을 채웠는지 한두 문장 (기록에 남습니다)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ path: rel, fills, table_rows, new_name }) => lib.fillForm(rel, fills || [], { newName: new_name, tableRows: table_rows || [] }),
  (a, r) => ({ path: a.path, new_path: r ? r.new_path : undefined, filled: a.fills ? a.fills.length : 0, rows_added: r ? r.rows_added : undefined, change_summary: a.change_summary })
);

tool(
  "compare_versions",
  {
    title: "바뀐 곳 비교",
    description:
      "두 문서(보통 list_versions 로 찾은 같은 문서의 두 버전)의 본문을 문단 단위로 비교해 고친·추가·삭제된 문단과 바뀐 숫자를 보여 줍니다. 먼저 고친 쪽을 이전(older)으로 놓습니다. " +
      "'이번 버전에서 뭐가 바뀌었어?', '수치가 바뀐 곳 확인해 줘', 새 버전을 저장한 뒤 바뀐 곳을 사용자에게 요약할 때 씁니다. 서식·그림은 비교하지 않습니다.",
    inputSchema: { path_a: pathArg, path_b: pathArg },
    annotations: { readOnlyHint: true },
  },
  async ({ path_a, path_b }) => lib.compareVersions(path_a, path_b),
  (a, r) => ({ path: a.path_a, path_b: a.path_b, changes: r ? r.changes.length : undefined })
);

tool(
  "convert_document",
  {
    title: "다른 형식으로 저장",
    description:
      "사용자 PC에 설치된 한글·워드로 문서를 다른 형식의 새 파일로 저장합니다 (원본은 그대로, 같은 폴더). " +
      "한글 .hwp → .hwpx(양식 채우기용) 또는 .pdf, 한글 .hwpx → .pdf, 워드 .doc → .docx 또는 .pdf, 워드 .docx → .pdf. " +
      "한글은 '파일 접근 허용' 창을 띄울 수 있으니, 오래 걸리면 사용자에게 허용을 눌러 달라고 알려 주세요. 윈도우에서만 됩니다.",
    inputSchema: {
      path: pathArg.describe("바꿀 문서 경로 (search_documents 의 path, 또는 fill_form 이 돌려준 new_path)"),
      to: z.enum(["hwpx", "docx", "pdf"]).describe("만들 형식"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ path: rel, to }) => lib.convertDocument(rel, to),
  (a, r) => ({ path: a.path, to: a.to, new_path: r ? r.new_path : undefined })
);

tool(
  "list_applications",
  {
    title: "지원 건 목록",
    description:
      "사업 지원 이력: 한 주제(기술)를 한 사업에 낸 '지원 건'마다 단계(예: 수요조사 제출 → RFP 반영 → 사업계획서 제출 → 서류평가 → 발표평가 → 선정·협약)별 결과(통과·탈락·진행)·날짜·평가 의견을 보여 줍니다. " +
      "비슷한 주제를 다른 사업에 낸 이력, 어느 단계에서 왜 떨어졌는지, 다가오는 마감(upcoming_deadlines)을 확인할 때 씁니다. 자세한 의견과 연결 문서는 get_application.",
    inputSchema: {
      query: z.string().optional().describe("과제명·주제·사업명·기관·메모에서 찾을 글자 (예: 그래핀 스텔스, 소재부품)"),
      state: z.enum(["준비", "진행 중", "탈락", "선정"]).optional(),
      year: z.number().int().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, state, year }) => lib.listApplications({ query, state, year }),
  (a, r) => ({ query: a.query, results: r ? r.total : undefined })
);

tool(
  "get_application",
  {
    title: "지원 건 자세히",
    description: "지원 건 하나의 단계별 결과·날짜·평가 의견(탈락 사유 포함)·연결 문서 경로를 모두 보여 줍니다. 연결 문서는 read_document 로 읽을 수 있습니다.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => lib.getApplication(id),
  (a) => ({ path: a.id })
);

tool(
  "get_program",
  {
    title: "사업 자료 보기",
    description:
      "사업(예: 소재부품기술개발사업) 하나에 넣어 둔 참고 자료(공고문·RFP·작성 양식·평가 기준 등) 경로와 그 사업의 지원 건을 보여 줍니다. " +
      "그 사업에 낼 문서를 쓰기 전에 부르고, 공고문·RFP·평가 기준은 read_document 로, 작성 양식은 inspect_form 으로 먼저 읽으세요.",
    inputSchema: { program: z.string().describe("사업명 (list_applications 의 programs)") },
    annotations: { readOnlyHint: true },
  },
  async ({ program }) => lib.getProgram(program),
  (a, r) => ({ query: a.program, results: r ? r.reference_docs.length : undefined })
);

tool(
  "record_application",
  {
    title: "지원 건 기록",
    description:
      "지원 건을 만들거나 고칩니다. action: " +
      "create(새 지원 건: fields 와 template 또는 stages) · update(fields 고치기) · stage(단계 결과·마감 기록: stage, status, date, note, due) · " +
      "stages(단계 목록 통째로 바꾸기: 더하기·빼기·이름·순서) · link/unlink(단계에 문서 연결: stage, path) · templates(단계 틀 목록 바꾸기) · " +
      "ref_link/ref_unlink(공고문·RFP 같은 참고 자료 연결: path, kind, 사업 전체면 program, 이 건만이면 id). " +
      "결과(status)는 진행·통과·탈락·제외(이 건에는 없는 단계) 중 하나. 탈락했으면 note 에 사유·평가 의견을 꼭 남기세요. 사용자에게 확인받은 사실만 기록하세요.",
    inputSchema: {
      action: z.enum(["create", "update", "stage", "stages", "link", "unlink", "templates", "ref_link", "ref_unlink"]),
      program: z.string().optional().describe("ref_link/ref_unlink 때 사업명 (사업 전체의 자료로 붙일 때)"),
      kind: z.enum(["공고문", "RFP", "작성 양식", "평가 기준", "참고 자료"]).optional().describe("ref_link 때 자료 종류"),
      id: z.string().optional().describe("지원 건 id (create·templates 는 필요 없음)"),
      fields: z
        .object({ title: z.string().optional(), topic: z.string().optional(), program: z.string().optional(), agency: z.string().optional(), year: z.number().int().optional(), memo: z.string().optional() })
        .optional()
        .describe("title: 과제명, topic: 주제(기술), program: 사업명, agency: 전문기관"),
      template: z.string().optional().describe("create 때 단계 틀 이름 (list_applications 의 templates)"),
      stage: z.string().optional().describe("단계 이름"),
      status: z.enum(["", "진행", "통과", "탈락", "제외"]).optional(),
      date: z.string().optional().describe("YYYY-MM-DD"),
      note: z.string().optional().describe("평가 의견·탈락 사유·메모"),
      due: z.string().optional().describe("stage 의 마감: YYYY-MM-DD 또는 YYYY-MM-DD HH:MM (공고의 접수 마감 등). 빈 문자열이면 지움"),
      path: z.string().optional().describe("link/unlink 할 문서 경로 (search_documents 의 path 또는 fill_form 의 new_path)"),
      stages: z.array(z.object({ name: z.string(), status: z.string().optional(), date: z.string().optional(), note: z.string().optional(), docs: z.array(z.string()).optional() })).optional(),
      templates: z.array(z.object({ name: z.string(), stages: z.array(z.string()) })).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (a) => {
    const op = { type: a.action, id: a.id };
    if (a.action === "create") Object.assign(op, { fields: a.fields || {}, template: a.template, stages: a.stages });
    else if (a.action === "update") op.fields = a.fields || {};
    else if (a.action === "stage") Object.assign(op, { stage: a.stage, patch: { status: a.status, date: a.date, note: a.note, due: a.due } });
    else if (a.action === "stages") op.stages = a.stages;
    else if (a.action === "link" || a.action === "unlink") {
      // 연결은 보관함에 있는(그리고 AI 에 보여도 되는) 문서나 방금 만든 문서만
      const rel = a.action === "link" ? lib.formSource(a.path).v.rel : String(a.path || "");
      Object.assign(op, { stage: a.stage, rel });
    } else if (a.action === "ref_link" || a.action === "ref_unlink") {
      const rel = a.action === "ref_link" ? lib.formSource(a.path).v.rel : String(a.path || "");
      Object.assign(op, { program: a.id ? undefined : a.program, rel, kind: a.kind });
    } else if (a.action === "templates") op.templates = a.templates;
    for (const k of Object.keys(op.patch || {})) if (op.patch[k] === undefined) delete op.patch[k];
    return lib.saveApplication(op);
  },
  (a, r) => ({ path: a.id || (r && r.id), action: a.action, stage: a.stage, status: a.status })
);

tool(
  "get_knowledge",
  {
    title: "회사 지식 카드 읽기",
    description:
      "사용자 회사의 핵심 사실을 정리한 '회사 지식 카드'를 읽습니다: 회사 개요, 핵심 기술·제품, 대표 성능 수치, 과제 이력, 고객사, 자주 쓰는 표현, 확인 필요 항목. " +
      "문서를 쓰거나 고치기 전에, 또는 회사에 관한 질문에 답하기 전에 먼저 부르세요. 카드가 없으면 빈 양식과 만드는 순서를 돌려줍니다.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => lib.getKnowledge(),
  (a, r) => ({ exists: r ? r.exists : undefined })
);

tool(
  "save_knowledge_card",
  {
    title: "회사 지식 카드 저장",
    description:
      "회사 지식 카드 전체 내용(마크다운)을 저장합니다. 이전 내용은 기록으로 남고, '## 사용자 메모' 부분은 사용자 것이 그대로 유지됩니다. " +
      "사용자가 지식 카드를 만들거나 새로 고쳐 달라고 할 때, 또는 새로 알게 된 사실을 카드에 넣어 달라고 할 때 씁니다.\n" +
      knowledge.BUILD_STEPS,
    inputSchema: {
      content: z.string().describe("카드 전체 내용 (마크다운). get_knowledge 의 양식 구조를 따릅니다."),
      change_summary: z.string().optional().describe("무엇을 새로 넣거나 바꿨는지 한두 문장 (기록에 남습니다)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ content }) => lib.saveKnowledge(content),
  (a) => ({ path: `${knowledge.DIR_NAME}/${knowledge.CARD_NAME}`, change_summary: a.change_summary })
);

const cardKind = z.enum(["topic", "program", "guide"]).describe("topic: 주제 카드(주제마다), program: 사업 카드(사업마다), guide: 작성 가이드(문서 종류마다: 수요조사서, 사업계획서)");
const cardName = z.string().optional().describe("topic 은 주제, program 은 사업명, guide 는 문서 종류(수요조사서 또는 사업계획서)");

tool(
  "get_card",
  {
    title: "주제·사업 카드, 작성 가이드 읽기",
    description:
      "사업 문서를 쓸 때 읽는 카드: 주제 카드(기술의 핵심 내용·수치·차별점·실적·검증된 문장·지원 이력), 사업 카드(사업의 평가 항목·강조점·양식 특징·우리 지원 교훈), 작성 가이드(문서 종류마다: 수요조사서·사업계획서의 항목 종류별 쓰는 법). " +
      "주제·사업명은 지원 건의 topic·program 을 그대로 쓰세요. name 없이 부르면 그 종류의 카드 목록을 돌려줍니다. 카드가 없으면 빈 양식과 만드는 순서를 돌려줍니다.",
    inputSchema: { kind: cardKind, name: cardName },
    annotations: { readOnlyHint: true },
  },
  async ({ kind, name }) => lib.getCard(kind, name),
  (a, r) => ({ query: [a.kind, a.name].filter(Boolean).join(": "), exists: r ? r.exists : undefined })
);

tool(
  "save_card",
  {
    title: "주제·사업 카드, 작성 가이드 저장",
    description:
      "주제 카드·사업 카드·작성 가이드의 전체 내용(마크다운)을 저장합니다. 이전 내용은 기록으로 남고 '## 사용자 메모' 는 사용자 것이 유지됩니다. " +
      "사용자가 카드를 만들거나 고쳐 달라고 할 때, 또는 문서를 쓰다 새로 확인한 사실을 넣자고 했을 때 씁니다. get_card 가 주는 양식 구조를 따르세요.",
    inputSchema: {
      kind: cardKind,
      name: cardName,
      content: z.string().describe("카드 전체 내용 (마크다운)"),
      change_summary: z.string().optional().describe("무엇을 새로 넣거나 바꿨는지 한두 문장 (기록에 남습니다)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ kind, name, content }) => lib.saveCard(kind, name, content),
  (a, r) => ({ path: r ? r.saved : [a.kind, a.name].filter(Boolean).join(": "), change_summary: a.change_summary })
);

// Claude 데스크톱의 '+' 메뉴에서 고를 수 있는 작업
server.registerPrompt(
  "build_knowledge_card",
  { title: "회사 지식 카드 만들기", description: "문서 보관함의 자료를 읽고 회사 지식 카드를 만들거나 새로 고칩니다." },
  () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "문서 보관함의 자료로 회사 지식 카드를 만들어 줘(이미 있으면 새로 고쳐 줘).\n\n" + knowledge.BUILD_STEPS },
      },
    ],
  })
);

const userPrompt = (text) => ({ messages: [{ role: "user", content: { type: "text", text } }] });

server.registerPrompt(
  "build_topic_card",
  { title: "주제 카드 만들기", description: "한 주제(기술)의 문서와 지원 이력을 읽고 주제 카드를 만들거나 새로 고칩니다.", argsSchema: { topic: z.string().describe("주제 (예: 그래핀 투명 전자파 차폐재)") } },
  ({ topic }) => userPrompt(`'${topic}' 주제 카드를 만들어 줘(이미 있으면 새로 고쳐 줘).\n\n` + cards.BUILD_STEPS.topic)
);

server.registerPrompt(
  "build_program_card",
  { title: "사업 카드 만들기", description: "사업 자료(공고문·평가 기준)와 그 사업의 지원 이력으로 사업 카드를 만들거나 새로 고칩니다.", argsSchema: { program: z.string().describe("사업명 (예: 소재부품기술개발사업)") } },
  ({ program }) => userPrompt(`'${program}' 사업 카드를 만들어 줘(이미 있으면 새로 고쳐 줘).\n\n` + cards.BUILD_STEPS.program)
);

server.registerPrompt(
  "build_writing_guide",
  {
    title: "작성 가이드 만들기",
    description: "통과한 수요조사서·사업계획서와 탈락 사유를 읽고 그 문서 종류의 항목별 작성 가이드를 만들거나 새로 고칩니다.",
    argsSchema: { document: z.string().describe("문서 종류: 수요조사서 또는 사업계획서") },
  },
  ({ document }) => userPrompt(`문서 보관함 자료로 '${document}' 작성 가이드를 만들어 줘(이미 있으면 새로 고쳐 줘).\n\n` + cards.BUILD_STEPS.guide)
);

server.registerPrompt(
  "write_application_document",
  {
    title: "사업 문서 쓰기",
    description: "지원 건(주제 × 사업)의 수요조사서·사업계획서 양식을 회사 지식 카드·주제 카드·사업 카드·작성 가이드·공고문·지난 탈락 사유를 바탕으로 채웁니다.",
    argsSchema: {
      application: z.string().optional().describe("지원 건 (과제명이나 주제·사업명)"),
      document: z.string().optional().describe("쓸 문서 (예: 수요조사서, 사업계획서)"),
    },
  },
  ({ application, document }) =>
    userPrompt(`${application ? `'${application}' 지원 건의 ` : ""}${document || "사업 문서"}를 써 줘.\n\n` + cards.WRITE_STEPS)
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write("문서 보관함 커넥터를 시작하지 못했습니다: " + ((e && e.stack) || e) + "\n");
  process.exit(1);
});
