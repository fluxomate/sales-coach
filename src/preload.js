const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coach', {
  startSession: (context) => ipcRenderer.invoke('session:start', { context }),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  setFocus: (name) => ipcRenderer.invoke('session:setFocus', name),
  sendAudio: (chunk) => ipcRenderer.send('audio:chunk', chunk),
  closeApp: () => ipcRenderer.invoke('app:close'),
  onSuggestion: (cb) => ipcRenderer.on('suggestion', (_e, s) => cb(s)),
  onTranscript: (cb) => ipcRenderer.on('transcript', (_e, t) => cb(t)),
  onFact: (cb) => ipcRenderer.on('fact', (_e, f) => cb(f)),
  onSections: (cb) => ipcRenderer.on('sections', (_e, arr) => cb(arr)),
  onSttError: (cb) => ipcRenderer.on('stt-error', (_e, m) => cb(m)),
  onSessionEnded: (cb) => ipcRenderer.on('session-ended', (_e, p) => cb(p)),
});
