// 화면(app/)에서 쓸 수 있는 기능만 골라서 연결한다.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel) {
  return (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

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
  // 끌어다 놓은 파일의 실제 경로 (보안 설정 때문에 화면에서는 직접 알 수 없다)
  pathsOf: (files) => Array.from(files || []).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  importFiles: (paths) => ipcRenderer.invoke("import-files", paths),
  pickAndImport: () => ipcRenderer.invoke("pick-and-import"),
  moveToCategory: (rel) => ipcRenderer.invoke("move-to-category", rel),
  onState: on("state"),
  onProgress: on("progress"),
  onScanDone: on("scan-done"),
  onScanError: on("scan-error"),
});
