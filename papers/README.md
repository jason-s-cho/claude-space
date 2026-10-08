# 논문 서재 (papers/)

내 컴퓨터의 논문·책 폴더를 Google Scholar처럼 정리하고 검색하는 앱입니다.
브라우저 화면으로 쓰지만 서버는 내 컴퓨터(127.0.0.1)에서만 돌아갑니다.

## 하는 일

- **끌어다 놓기**: PDF를 창에 끌어다 놓으면(여러 개도 됨) 논문 폴더에
  `저자 et al. - 연도 - 제목.pdf` 이름으로 저장합니다. 한글 저자는 `김철수 외 - 2021 - 제목.pdf`.
- **서지 정보 자동 채우기**
  1. PDF 안의 DOI → Crossref에서 제목·저자·저널·연도·권·호·쪽·출판사·초록
  2. arXiv 논문(ID가 본문이나 파일 이름에 있을 때) → arXiv
  3. 둘 다 없으면 첫 페이지에서 가장 큰 글씨(제목)를 찾아 Crossref에서 검색하고,
     결과의 제목이 PDF 첫 페이지에 실제로 있을 때만 채택
  4. 그래도 못 찾으면 PDF에서 추정한 값으로 저장하고 **확인 필요** 표시
- **보충자료(Supplementary) 묶기**: 보충자료 PDF는 본문 논문에 묶어
  `본문 파일 이름 - Supplementary.pdf`, `… - Supplementary 2.pdf`로 저장합니다. 탐색기에서도 본문 바로 옆에 놓입니다.
  - 파일 이름(`_SI`, `supp`, `MOESM1_ESM`, `mmc1` 등)이나 첫 페이지 머리말(`Supplementary Information`,
    `Supporting Information`, `Extended Data`, `Appendix`, `보충자료`, `부록` 등)로 알아봅니다.
  - 같은 DOI이거나, 본문 논문 제목이 보충자료 첫머리에 있으면 그 논문에 묶습니다.
  - 보충자료가 본문보다 먼저 들어와도 괜찮습니다. 나중에 본문이 들어오면 자동으로 묶입니다.
  - 목록의 **논문 위에 PDF를 놓으면** 무조건 그 논문의 보충자료로 묶습니다.
  - 잘못 분류됐으면 수정 창의 **분류**에서 본문/보충자료와 본문 논문을 바꿀 수 있습니다.
  - 본문 논문의 정보·파일 이름이 바뀌면 보충자료도 따라 바뀌고, 본문을 삭제하면 보충자료도 함께 trash로 갑니다.
  - **동영상**(mp4, mov 등)도 보충자료로 묶어 `본문 이름 - Supplementary Video.mp4`로 저장합니다.
    논문 위에 놓거나 논문 PDF와 함께 넣으면 그 논문에, `…_MOESM2_ESM.mp4`처럼 출판사 번호가 같은 보충자료가
    이미 있으면 그 논문에 묶고, 모르면 어느 논문인지 묻습니다. 목록에는 🎬로 보입니다.
  - 수정 창 아래 보충자료 목록에서 잘못 묶인 보충자료를 뺄 수 있습니다.
  - 보충자료 내용도 검색되며, 걸리면 본문 논문 결과에 `보충자료` 표시와 함께 나옵니다.
- **내 정리 자료**: 논문을 보며 만든 PowerPoint·Word·Excel·한글·메모·그림 등을 논문 위에 끌어다 놓거나
  수정 창의 ‘내 정리 자료 → 파일 추가’로 붙입니다. `논문 이름 - 정리 - 원래 파일 이름.pptx`로 논문 옆에 저장되고,
  카드의 ‘내 정리’에서 누르면 기본 프로그램으로 열립니다. Word·PowerPoint·Excel·hwpx·텍스트 안의 글도 검색됩니다.
  논문 이름이 바뀌면 따라 바뀌고, 논문을 빼면 함께 trash로 갑니다.
- **책**: 책 PDF는 앞 12쪽(표제지·판권 면)에서 ISBN을 찾아 Crossref(학술서, DOI 포함) → Google Books →
  Open Library 순서로 제목·저자(편저는 편집자)·출판사·연도·판·책 소개를 채웁니다.
  `Goodfellow et al. - 2016 - Deep Learning.pdf` 처럼 논문과 같은 규칙으로 저장하고,
  목록에는 `[책] 제목 / 저자 - 2판 2016 - 출판사 / ISBN · 쪽수`로 보입니다.
  - 논문에 찍힌 학술대회 논문집 ISBN을 책으로 오인하지 않도록, 40쪽 이상이거나 책 제목이 앞부분에 있을 때만 채택합니다.
  - 왼쪽 **종류**에서 전체/논문/책으로 걸러 볼 수 있고, ISBN으로도 검색됩니다.
  - 수정 창에서 ISBN을 넣고 **가져오기**를 누르면 책 정보를 다시 받아옵니다. 제목으로 찾으면 Google Books 후보도 함께 나옵니다.
  - 인용(APA·MLA·BibTeX `@book`)도 책 형식(판, 출판사, 편저 Ed./Eds.)으로 만듭니다.
- **컬렉션**: ‘졸업논문’, ‘과제 제안서’처럼 묶음을 만들어 논문을 넣습니다(한 논문을 여러 곳에 넣어도 파일은 하나).
  컬렉션별로 보기·BibTeX 내보내기가 됩니다. 카드 체크 상자로 여러 편을 고르거나(Shift로 범위, ‘결과 모두 고르기’로 검색 결과 전체)
  제목을 왼쪽 컬렉션으로 끌어다 놓아 한꺼번에 넣을 수 있습니다.
- **읽음 상태·별점**: 카드에서 안 읽음/읽는 중/읽음과 별 1~5개를 매기고, 왼쪽 ‘읽기’와 ‘별점’ 정렬로 모아 봅니다.
- **국내 논문(KCI)**: 설정에 KCI Open API 키(open.kci.go.kr에서 무료 발급)를 넣으면 DOI 없는 한글 논문도 제목으로 찾아
  학술지·권·호·쪽·초록을 채웁니다. 수정 창에서 KCI 논문 ID(ART…)로도 가져옵니다.
- **PDF 없이 추가**: ‘DOI·ISBN으로 추가’에 DOI·arXiv ID·ISBN·KCI ID를 넣으면 서지 정보만 먼저 등록하고,
  arXiv·오픈 액세스에 무료 PDF가 있으면 받아 붙입니다. 나중에 PDF를 그 카드에 끌어다 놓으면 붙습니다.
- **Scholar 형식 목록**: 제목 / `저자 - 저널, 연도 - 출판사` / 초록, 그리고 인용(APA·MLA·BibTeX)·수정·폴더에서 보기·DOI
- **인용 수**: 논문·책마다 `인용 1,234회`를 표시하고, 누르면 그 문헌을 인용한 목록(OpenAlex·Semantic Scholar)이 열립니다.
  OpenAlex → Semantic Scholar → Crossref 순서로 찾습니다(DOI·arXiv ID, 없으면 제목과 연도로 확인).
  정렬에 **인용순**이 있고, 앱을 켤 때 확인한 지 30일이 지난 항목은 뒤에서 자동으로 다시 받아옵니다.
  왼쪽 **인용 수 새로 고침**으로 전체를 바로 갱신할 수도 있습니다.
  Google Scholar는 공식 API가 없어 쓰지 않으므로, 숫자가 Scholar보다 대체로 조금 적게 나옵니다.
- **보기**: 한 화면에 10개씩 보이고 아래 쪽 번호로 넘깁니다. 왼쪽 **보기 → 한 화면에** 다이얼(− / +)로
  10~50개까지 10개 단위로 바꿀 수 있습니다. **초록**은 숨김 / 짧게(3줄, 논문마다 ‘초록 더 보기’) / 전체 중에서 고릅니다.
  검색어가 본문·보충자료에서 걸린 대목은 초록을 숨겨도 보여 줍니다. 고른 설정은 다음에 열 때도 그대로입니다.
- **종류**: 학술지 논문 · 학술대회 논문 · 책 · 보고서 · 학위논문 · 기타로 나눠 보고(왼쪽 종류), 수정 창 맨 위 분류에서 바꿉니다.
- **내 논문·책**: 설정에 ‘내 이름(저자 표기)’을 적어 두면 내가 쓴 논문·책에 ★ 내 저작 표시가 붙고,
  왼쪽 ‘★ 내 논문·책’으로 따로 모아 봅니다. 수정 창에서 직접 켜고 끌 수도 있습니다.
- **검색**: 전체·제목·저자·저널·**본문** 범위, `"따옴표 구절"`, 기간(○○년부터 / 직접 지정), 관련도·추가한 순·연도순·제목순 정렬
- **수정**: DOI·arXiv ID를 넣거나 제목 일부로 Crossref 후보를 골라 다시 받아오기. 저장하면 파일 이름도 맞춰 바뀝니다.
- **중복 방지**: 같은 파일(내용 해시)이나 같은 DOI는 다시 넣지 않습니다. 단, 프리프린트가 있는 논문에 같은 DOI의
  출판본을 넣으면 출판본을 본 PDF로 삼고 프리프린트는 `… - Preprint.pdf`(다른 판)로 남깁니다.
  이미 두 항목으로 들어간 같은 논문은 왼쪽 ‘중복 의심’에서 골라 하나로 합칩니다.
- **폴더 다시 읽기**: 탐색기/Finder로 폴더에 직접 넣은 PDF도 등록하고, 사라진 파일은 목록에서 정리합니다.
- **삭제**: 목록에서 빼면 PDF는 `논문폴더/.papershelf/trash`로 옮겨집니다(바로 지우지 않음).
- BibTeX 전체 내보내기(`library.bib`)

## 설치 (권장)

GitHub 저장소의 **Releases** 페이지에서 내 컴퓨터에 맞는 파일을 받아 설치합니다. Python은 필요 없습니다.

- **Windows**: `PaperShelf-Setup-….exe` → 실행해서 설치 (관리자 권한 불필요).
  "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**.
- **macOS**: Apple 칩(M1 이후)은 `…-mac-apple-silicon.dmg`, Intel Mac은 `…-mac-intel.dmg`.
  DMG를 열어 `논문 서재`를 Applications로 끌어 놓습니다. 처음 열 때 막히면
  **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**.

설치판은 브라우저 없이 **‘논문 서재’ 자체 창**으로 뜹니다(Windows: Edge WebView2, macOS: WebKit 엔진 사용,
주소창·탭 없음). 창을 닫으면 프로그램이 끝납니다. PDF는 컴퓨터의 기본 PDF 프로그램으로, DOI 같은 바깥 링크는
기본 브라우저로 열립니다. 이미 켜져 있을 때 다시 실행하면 기존 창을 앞으로 불러옵니다.
Windows 설치 때 "시작할 때 자동 실행"을 고르면 최소화한 채로 시작합니다.
WebView2가 없는 오래된 Windows에서는 브라우저 + 알림 영역 아이콘 방식으로 동작하며, `--browser` 옵션으로 이 방식을 고를 수도 있습니다.

설치 파일은 `papers/` 아래 코드가 바뀌어 GitHub에 올라갈 때마다 GitHub Actions
(`.github/workflows/papershelf.yml`)가 새로 만들어 Releases에 올립니다.
직접 만들려면: `pip install -r requirements-build.txt && pyinstaller packaging/papershelf.spec`
(Windows 설치 파일은 이어서 Inno Setup으로 `packaging/papershelf.iss`).

## 소스로 실행

Python 3.9 이상이 필요합니다. 추가로 쓰는 패키지는 `pypdf` 하나입니다.

- **Windows**: `run.bat` 더블클릭
- **macOS**: `run.command` 더블클릭 (처음 한 번 `chmod +x run.command` 필요할 수 있음)
- 직접 실행:

```sh
pip install -r requirements.txt
python app.py                       # 논문 폴더: ~/Papers (처음 기본값)
python app.py --library "D:\논문"     # 폴더 지정 (다음부터는 기억함)
```

브라우저가 `http://127.0.0.1:8765/`로 자동으로 열립니다. 논문 폴더는 화면의 **설정**에서도 바꿀 수 있습니다.

옵션: `--port 8765`, `--offline`(Crossref·arXiv 조회 안 함), `--no-browser`.

## 저장 위치

```
논문폴더/
├── LeCun et al. - 2015 - Deep learning.pdf
├── LeCun et al. - 2015 - Deep learning - Supplementary.pdf
├── LeCun et al. - 2015 - Deep learning - 정리 - 발표 자료.pptx
├── Vaswani et al. - 2017 - Attention Is All You Need.pdf
└── .papershelf/
    ├── library.db    ← 서지 정보·본문 색인 (SQLite)
    └── trash/        ← 서재에서 뺀 PDF
```

색인이 논문 폴더 안에 있으므로 폴더째 옮기거나 클라우드 드라이브에 두어도 그대로 쓸 수 있습니다.
마지막으로 쓴 폴더 위치는 `~/.papershelf.json`에 기억합니다.

## 파일 구성

- `app.py` — 로컬 웹 서버와 API
- `library.py` — 파일 이름 정하기·이동, SQLite 색인, 검색
- `metadata.py` — PDF 읽기, DOI/arXiv/제목 추출, Crossref·arXiv 조회, 인용 형식
- `static/index.html` — 화면
- `static/fonts/` — 내장 글꼴 Pretendard (SIL Open Font License 1.1, `LICENSE-Pretendard.txt`)
- `desktop.py` — 자체 창(pywebview)
- `tray.py` — 브라우저 모드의 알림 영역·메뉴 막대 아이콘
- `packaging/` — 설치 파일 빌드 설정(PyInstaller, Inno Setup)
