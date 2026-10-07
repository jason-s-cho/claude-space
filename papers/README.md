# 논문 서재 (papers/)

내 컴퓨터의 논문 폴더를 Google Scholar처럼 정리하고 검색하는 앱입니다.
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
- **Scholar 형식 목록**: 제목 / `저자 - 저널, 연도 - 출판사` / 초록, 그리고 인용(APA·MLA·BibTeX)·수정·폴더에서 보기·DOI
- **검색**: 전체·제목·저자·저널·**본문** 범위, `"따옴표 구절"`, 기간(○○년부터 / 직접 지정), 관련도·추가한 순·연도순·제목순 정렬
- **수정**: DOI·arXiv ID를 넣거나 제목 일부로 Crossref 후보를 골라 다시 받아오기. 저장하면 파일 이름도 맞춰 바뀝니다.
- **중복 방지**: 같은 파일(내용 해시)이나 같은 DOI는 다시 넣지 않습니다.
- **폴더 다시 읽기**: 탐색기/Finder로 폴더에 직접 넣은 PDF도 등록하고, 사라진 파일은 목록에서 정리합니다.
- **삭제**: 목록에서 빼면 PDF는 `논문폴더/.papershelf/trash`로 옮겨집니다(바로 지우지 않음).
- BibTeX 전체 내보내기(`library.bib`)

## 실행

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
