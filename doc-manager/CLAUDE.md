# 워크데스크 (doc-manager) — 작업 메모

- 지금까지의 결정·기능·남은 일: `docs/작업-정리.md`를 먼저 읽는다. 사용법은 저장소 루트 `README.md`.
- 사용자와는 한국어로, 쉬운 말로 이야기한다.
- 지킬 것: 사용자 문서를 덮어쓰거나 지우지 않음(새 버전으로 저장, 지우기는 앱에서 휴지통으로만) · 'AI제외' 문서는 Claude 커넥터에 절대 노출하지 않음 · 개인정보 서류는 처음부터 AI제외 · 연차료 알림은 만들지 않음.
- `package.json`의 `name`(doc-manager), `build.appId`, MCP 서버 키 `doc-manager`, 릴리스 태그 `docmanager-v`, 문서 폴더의 `.docmanager`는 바꾸지 않는다 (설정·업데이트·Claude 연결이 끊긴다). 보이는 이름은 '워크데스크'.
- 화면 스크립트(app.js → apps.js → ip.js → home.js)는 전역을 같이 쓴다. 이름이 겹치지 않게 하고, 뒤에 읽히는 함수는 `typeof` 로 확인해서 부른다.
- 확인: `npm test`, 화면은 Playwright + Electron 으로 1366×768 스크린샷. 작업 브랜치에 푸시하면 테스트 빌드(Actions → Artifacts), 기본 브랜치에 머지하면 정식 릴리스.
