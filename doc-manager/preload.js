// 화면(app/)에서 쓸 수 있는 기능만 골라서 연결한다.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel) {
  return (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

// 끌어다 놓은 파일의 실제 경로.
// File 객체는 contextBridge 를 건너가면 File 이 아니게 되어(목록은 비고, 하나씩 넘겨도 오류) 경로를 알 수 없다.
// 그래서 여기(preload)에서 drop 이벤트를 먼저 받아 진짜 File 로 경로를 읽어 두고, 화면은 그 결과만 가져간다.
let droppedPaths = [];
window.addEventListener(
  "drop",
  (e) => {
    droppedPaths = [];
    const files = e.dataTransfer ? e.dataTransfer.files : [];
    for (let i = 0; i < files.length; i++) {
      try {
        const p = webUtils.getPathForFile(files[i]);
        if (p) droppedPaths.push(p);
      } catch {}
    }
  },
  true // 화면의 drop 처리보다 먼저
);

contextBridge.exposeInMainWorld("docs", {
  getState: () => ipcRenderer.invoke("get-state"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  rescan: () => ipcRenderer.invoke("rescan"),
  search: (q) => ipcRenderer.invoke("search", q),
  getText: (rel) => ipcRenderer.invoke("get-text", rel),
  updateDoc: (rel, patch) => ipcRenderer.invoke("update-doc", rel, patch),
  openFile: (rel) => ipcRenderer.invoke("open-file", rel),
  showInFolder: (rel) => ipcRenderer.invoke("show-in-folder", rel),
  openRoot: () => ipcRenderer.invoke("open-root"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  saveSearches: (s) => ipcRenderer.invoke("save-searches", s),
  exportCsv: (rels) => ipcRenderer.invoke("export-csv", rels),
  // 방금 끌어다 놓은 파일들의 실제 경로 (위의 drop 처리에서 읽어 둔 것)
  droppedPaths: () => droppedPaths.slice(),
  importFiles: (paths) => ipcRenderer.invoke("import-files", paths),
  pickAndImport: () => ipcRenderer.invoke("pick-and-import"),
  moveToCategory: (rel) => ipcRenderer.invoke("move-to-category", rel),
  onState: on("state"),
  onProgress: on("progress"),
  onScanDone: on("scan-done"),
  onScanError: on("scan-error"),
});
