// 화면(app/)에서 쓸 수 있는 기능만 골라서 연결한다.
const { contextBridge, ipcRenderer } = require("electron");

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
  exportCsv: (rels) => ipcRenderer.invoke("export-csv", rels),
  onState: on("state"),
  onProgress: on("progress"),
  onScanDone: on("scan-done"),
  onScanError: on("scan-error"),
});
