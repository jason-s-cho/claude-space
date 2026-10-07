# claude-space

## schedule/ — 나의 일정 수첩

브라우저에서 쓰는 개인 일정 관리 도구입니다.

- 월간 달력(일요일 시작, 대한민국 공휴일·대체공휴일 표시)
- 날짜를 누르면 그날의 일정 목록, 두 번 누르면 새 일정 추가
- 일정마다 시간·분류(업무/개인/건강/약속/기타)·메모, 완료 체크
- 오늘 남은 일정·앞으로 7일 요약, 검색
- Google 캘린더 연동: 달력에 Google 캘린더 일정을 함께 표시(5분마다 갱신), 새 일정을 Google 캘린더에도 추가하고, 수정·삭제도 양쪽에 반영
- 일정 백업: 화면 아래 **내보내기**로 일정을 JSON 파일로 저장하고, **가져오기**로 불러옵니다. 가져오기는 기존 일정을 지우거나 덮어쓰지 않고, 같은 날짜·시간·제목이 이미 있으면 건너뜁니다. (PC나 브라우저를 옮길 때 사용. Google 캘린더 연결 정보는 백업에 포함되지 않습니다.)
- 단축키: `n` 새 일정, `Alt+←/→` 달 이동

claude.ai Artifact로 열면 일정이 서버에 저장되어 어느 기기에서나 같은 일정이 보입니다.
`schedule/index.html`을 브라우저로 직접 열면 그 브라우저의 localStorage에 저장됩니다.

Google 캘린더 연동은 claude.ai Artifact에서 Google Calendar 커넥터가 연결되어 있을 때만 동작합니다.

## desktop/ — 데스크톱 앱 (Electron)

`schedule/index.html`을 그대로 감싸서 Windows / macOS / Linux 설치형 앱으로 만듭니다.
빌드할 때 `schedule/index.html`이 `desktop/app/`으로 복사되므로, 웹 버전을 고치면 데스크톱 버전에도 반영됩니다.

**내 PC에서 실행해 보기**

```bash
cd desktop
npm install
npm start
```

**설치 파일 만들기**

- 내 PC에서: `npm run dist` → `desktop/dist/`에 설치 파일 생성 (자기 OS용만 만들어짐)
- GitHub에서 3개 OS 한꺼번에: Actions 탭 → *Desktop build* → Run workflow.
  `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0` 하면 Releases에 설치 파일이 올라갑니다.

**참고**

- Google 캘린더 연동은 claude.ai Artifact에서만 동작하며, 데스크톱 앱에서는 꺼진 상태로 일정 수첩 기능만 사용됩니다.
- 일정은 설치한 PC의 앱 데이터에 저장됩니다. PC마다 따로 저장되며 서로 동기화되지 않으니, PC를 옮길 때는 **내보내기 → 가져오기**를 쓰세요.
- 코드 서명이 없어서 처음 실행할 때 Windows SmartScreen / macOS Gatekeeper 경고가 뜰 수 있습니다.
- 달력 글꼴은 온라인일 때 Google Fonts를 쓰고, 오프라인이면 시스템 글꼴로 대체됩니다.
