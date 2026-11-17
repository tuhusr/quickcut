const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('qc', {
  pathFor: (file) => webUtils.getPathForFile(file),
  mediaUrl: (p) => `qc-media://f/${encodeURIComponent(p)}`,
  openFiles: () => ipcRenderer.invoke('open-files'),
  probe: (p) => ipcRenderer.invoke('probe', p),
  thumbs: (p, d) => ipcRenderer.invoke('thumbs', p, d),
  frames: (p, times) => ipcRenderer.invoke('frames', p, times),
  proxy: (p) => ipcRenderer.invoke('proxy', p),
  waveform: (p, d) => ipcRenderer.invoke('waveform', p, d),
  savePath: (name, ext) => ipcRenderer.invoke('save-path', name, ext),
  exportVideo: (segs, infos, settings, out) => ipcRenderer.invoke('export', segs, infos, settings, out),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  canSmartCut: (segs, infos, settings) => ipcRenderer.invoke('can-smart', segs, infos, settings),
  estimate: (segs, infos, settings) => ipcRenderer.invoke('estimate', segs, infos, settings),
  saveProject: (json, current, saveAs) => ipcRenderer.invoke('project-save', json, current, saveAs),
  openProject: (file) => ipcRenderer.invoke('project-open', file),
  autosaveWrite: (json) => ipcRenderer.invoke('autosave-write', json),
  autosaveRead: () => ipcRenderer.invoke('autosave-read'),
  exists: (p) => ipcRenderer.invoke('file-exists', p),
  gpuInfo: () => ipcRenderer.invoke('gpu-info'),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openFile: (p) => ipcRenderer.invoke('open-file', p),
  version: () => ipcRenderer.invoke('app-version'),
  updateState: () => ipcRenderer.invoke('update-state'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onExportProgress: on('export-progress'),
  onProxyProgress: on('proxy-progress'),
  onUpdate: on('update'),
  onOpenPaths: on('open-paths'),
});
