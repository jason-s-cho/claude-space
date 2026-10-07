# claude-space

## schedule/ — 나의 일정 수첩

브라우저에서 쓰는 개인 일정 관리 도구입니다.

- 월간 달력(일요일 시작, 대한민국 공휴일·대체공휴일 표시)
- 날짜를 누르면 그날의 일정 목록, 두 번 누르면 새 일정 추가
- 일정마다 시간·분류(업무/개인/건강/약속/기타)·메모, 완료 체크
- 오늘 남은 일정·앞으로 7일 요약, 검색
- Google 캘린더 연동: 달력에 Google 캘린더 일정을 함께 표시(5분마다 갱신), 새 일정을 Google 캘린더에도 추가하고, 수정·삭제도 양쪽에 반영
- 단축키: `n` 새 일정, `Alt+←/→` 달 이동

claude.ai Artifact로 열면 일정이 서버에 저장되어 어느 기기에서나 같은 일정이 보입니다.
`schedule/index.html`을 브라우저로 직접 열면 그 브라우저의 localStorage에 저장됩니다.

Google 캘린더 연동은 claude.ai Artifact에서 Google Calendar 커넥터가 연결되어 있을 때만 동작합니다.

## papers/ — 논문 서재

내 컴퓨터의 논문 폴더를 Google Scholar처럼 정리·검색하는 로컬 앱입니다.

- PDF를 끌어다 놓으면 DOI·arXiv·제목으로 Crossref/arXiv에서 서지 정보를 찾아 `저자 et al. - 연도 - 제목.pdf`로 저장
- 제목 / 저자 - 저널, 연도 - 출판사 형식 목록, APA·MLA·BibTeX 인용
- 제목·저자·저널·본문 검색, 기간·정렬

실행 방법은 [papers/README.md](papers/README.md)를 보세요.
