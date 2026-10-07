const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

// 앱이 두 번 실행되면 기존 창을 앞으로 가져온다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 420,
    minHeight: 600,
    title: "나의 일정 수첩",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "app", "index.html"));

  // 외부 링크는 앱 안이 아니라 기본 브라우저에서 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (isWebUrl(url)) shell.openExternal(url);
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  // 윈도우·리눅스는 메뉴 막대를 없앤다. 맥은 복사/붙여넣기 때문에 기본 메뉴를 유지한다.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
