const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');

// Audio capture switches — let Chromium negotiate alternate channel layouts when
// the device's default doesn't match Chromium's request (the #1 NotReadableError
// cause when another app like Zoom/OBS already opened the endpoint).
app.commandLine.appendSwitch('try-supported-channel-layouts');

const { DeepgramClient } = require('./stt/deepgram');
const { Coach } = require('./coach/coach');
const { parseSections } = require('./coach/sections');
const { writeSessionLog } = require('./persistence/session-log');

const SESSION_CAP_MS = 90 * 60 * 1000;

let mainWindow = null;
let deepgram = null;
let coach = null;
let sessionStart = null;
let capTimer = null;
let transcriptEntries = [];
let suggestionEntries = [];
let factEntries = [];
let prospectContext = '';
let forcedSectionLog = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 460,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Pipe renderer console messages to main stdout for debugging
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = ['LOG', 'WARN', 'ERR', 'INFO'][level] || 'LOG';
    console.log(`[renderer ${lvl}] ${message}  (${sourceId}:${line})`);
  });

  if (process.env.SALES_COACH_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Position top-center
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  const x = workArea.x + Math.round((workArea.width - 820) / 2);
  mainWindow.setPosition(x, workArea.y + 16);
}

app.whenReady().then(() => {
  // Grant mic + display-capture without prompting (this is a local single-user app).
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allow = ['media', 'display-capture', 'mediaKeySystem', 'audioCapture'];
    callback(allow.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Auto-pick the primary screen + loopback (system) audio for getDisplayMedia.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          console.error('[main] desktopCapturer returned no screens');
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch((err) => {
        console.error('[main] desktopCapturer.getSources failed:', err);
        callback({});
      });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopSession('app-quit').finally(() => app.quit());
});

// --- IPC ---

ipcMain.handle('session:start', async (_evt, { context }) => {
  console.log('[main] session:start requested');
  if (deepgram) return { ok: false, error: 'already running' };

  const dgKey = process.env.DEEPGRAM_API_KEY;
  const anthKey = process.env.ANTHROPIC_API_KEY;
  if (!dgKey || !anthKey) {
    console.error('[main] missing API keys', { dg: !!dgKey, anth: !!anthKey });
    return { ok: false, error: 'Missing DEEPGRAM_API_KEY or ANTHROPIC_API_KEY in .env' };
  }

  prospectContext = (context || '').trim();
  transcriptEntries = [];
  suggestionEntries = [];
  factEntries = [];
  forcedSectionLog = [];
  sessionStart = Date.now();

  const scriptPath = path.join(__dirname, '..', 'script.md');
  let scriptText = '';
  try {
    scriptText = fs.readFileSync(scriptPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot read script.md: ${e.message}` };
  }

  // Surface the parsed section titles so the renderer can populate the dropdown.
  const sections = parseSections(scriptText).map((s) => s.title);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sections', sections);
  }

  coach = new Coach({
    anthropicKey: anthKey,
    scriptText,
    prospectContext,
    onSuggestion: (s) => {
      suggestionEntries.push({ t: Date.now() - sessionStart, ...s });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('suggestion', s);
      }
    },
    onFact: (f) => {
      factEntries.push(f);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fact', f);
      }
    },
  });

  deepgram = new DeepgramClient({
    apiKey: dgKey,
    onTranscript: (entry) => {
      if (entry.is_final && entry.text) {
        transcriptEntries.push({ t: Date.now() - sessionStart, ...entry });
        coach.ingest(entry);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('transcript', entry);
        }
      }
    },
    onError: (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stt-error', msg);
      }
    },
  });

  try {
    await deepgram.connect();
    console.log('[main] deepgram connected');
  } catch (e) {
    console.error('[main] deepgram connect failed:', e.message);
    deepgram = null;
    coach = null;
    return { ok: false, error: `Deepgram connect failed: ${e.message}` };
  }

  coach.start();
  console.log('[main] coach started');

  capTimer = setTimeout(() => {
    stopSession('cap');
  }, SESSION_CAP_MS);

  return { ok: true };
});

ipcMain.handle('session:stop', async () => {
  await stopSession('user');
  return { ok: true };
});

ipcMain.on('audio:chunk', (_evt, chunk) => {
  if (deepgram) deepgram.send(chunk);
});

ipcMain.handle('session:setFocus', (_evt, name) => {
  if (!coach) return { ok: false, error: 'not running' };
  coach.setForcedSection(name || '');
  forcedSectionLog.push({ t: Date.now() - sessionStart, name: name || '(cleared)' });
  console.log(`[main] forced section -> "${name}"`);
  return { ok: true };
});

ipcMain.handle('app:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

async function stopSession(reason) {
  if (capTimer) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  if (coach) {
    coach.stop();
  }
  if (deepgram) {
    try { await deepgram.close(); } catch (_) {}
  }

  const hadSession = deepgram !== null;
  deepgram = null;
  coach = null;

  if (hadSession && sessionStart) {
    try {
      const outPath = await writeSessionLog({
        startedAt: sessionStart,
        endedAt: Date.now(),
        reason,
        prospectContext,
        transcript: transcriptEntries,
        suggestions: suggestionEntries,
        facts: factEntries,
        forcedSections: forcedSectionLog,
        outDir: path.join(__dirname, '..', 'sessions'),
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-ended', { reason, path: outPath });
      }
    } catch (e) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-ended', { reason, error: e.message });
      }
    }
  }
  sessionStart = null;
}
