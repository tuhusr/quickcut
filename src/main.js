const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const engine = require('./engine');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

let win = null;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// qc-media://<encoded path> streams local files to the <video> element with range support.
protocol.registerSchemesAsPrivileged([
  { scheme: 'qc-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } },
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#141414',
    title: 'Quickcut',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => {
    const files = argFiles(process.argv);
    if (files.length) send('open-paths', files);
  });
  // Dev-only test hook: QC_DEV_SCRIPT runs a script in the page, then QC_SHOT captures it.
  if (!app.isPackaged && process.env.QC_DEV_SCRIPT) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const res = await win.webContents.executeJavaScript(fs.readFileSync(process.env.QC_DEV_SCRIPT, 'utf8'));
        if (res !== undefined) console.log('DEV RESULT', JSON.stringify(res));
      } catch (e) { console.log('DEV ERROR', e.message); }
      if (process.env.QC_SHOT) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.QC_SHOT, img.toPNG());
        console.log('SHOT', process.env.QC_SHOT);
      }
      // QC_SHOTS=dir|theme1,theme2: one capture per theme of the same edit.
      if (process.env.QC_SHOTS) {
        const [dir, list] = process.env.QC_SHOTS.split('|');
        for (const t of list.split(',')) {
          await win.webContents.executeJavaScript(`window.__qcSetTheme(${JSON.stringify(t)})`);
          await new Promise((r) => setTimeout(r, 900));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(dir, `${t}.png`), img.toPNG());
          console.log('SHOT', t);
        }
      }
      if (process.env.QC_QUIT) app.quit();
    });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Dropping a file outside the drop zones must not navigate away from the editor.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Files handed to us by Windows (double-clicked .qcut, "Open with"), minus Electron's own args.
const argFiles = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
// Scripted dev test runs get their own profile so they never collide with an installed copy.
if (!app.isPackaged && process.env.QC_DEV_SCRIPT) app.setPath('userData', path.join(app.getPath('temp'), 'quickcut-dev'));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const files = argFiles(argv);
  if (files.length) send('open-paths', files);
});

app.whenReady().then(() => {
  protocol.handle('qc-media', (req) => serveMedia(req));
  createWindow();
  setupUpdater();
  engine.detectGpu(); // warm the cache so the first export doesn't wait
});

app.on('window-all-closed', () => { engine.cancelExport(); app.quit(); });

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ogv': 'video/ogg' };

// Byte-range responses so the <video> element can seek anywhere instantly.
function serveMedia(req) {
  const file = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
  let size;
  try { size = fs.statSync(file).size; } catch { return new Response('Not found', { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    status = 206;
  }
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
  const headers = { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(stream, { status, headers });
}

/* ---------- Remembered folders ---------- */
// "save": where the last export or project went (shared, so both land in the same place).
// "media": where clips were last added from.
const PREFS = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = null;
function pref(key, fallback) {
  if (!prefs) { try { prefs = JSON.parse(fs.readFileSync(PREFS(), 'utf8')); } catch { prefs = {}; } }
  const dir = prefs[key];
  return dir && fs.existsSync(dir) ? dir : fallback;
}
function remember(key, file) {
  if (!file) return;
  pref(key);
  prefs[key] = path.dirname(file);
  try { fs.writeFileSync(PREFS(), JSON.stringify(prefs, null, 1)); } catch {}
}

/* ---------- IPC ---------- */

ipcMain.handle('open-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add clips',
    defaultPath: pref('media', app.getPath('videos')),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video and audio', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled) return [];
  remember('media', r.filePaths[0]);
  return r.filePaths;
});

ipcMain.handle('probe', async (_e, file) => engine.probe(file));
ipcMain.handle('thumbs', async (_e, file, duration) => {
  const r = await engine.thumbs(file, duration);
  return { rate: r.rate, urls: r.files.map((f) => pathToFileURL(f).toString()) };
});
ipcMain.handle('frames', async (_e, file, times) => {
  const r = await engine.frames(file, times);
  const out = {};
  Object.entries(r).forEach(([t, f]) => { out[t] = pathToFileURL(f).toString(); });
  return out;
});
ipcMain.handle('waveform', async (_e, file, duration) => pathToFileURL(await engine.waveform(file, duration)).toString());
ipcMain.handle('proxy', async (_e, file) => {
  const out = await engine.proxy(file, (p) => send('proxy-progress', { file, p }));
  return out;
});

ipcMain.handle('save-path', async (_e, suggested, ext) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save edited video',
    defaultPath: path.join(pref('save', app.getPath('videos')), `${suggested}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled) return null;
  remember('save', r.filePath);
  return r.filePath;
});

ipcMain.handle('export', async (_e, segments, infos, settings, outPath) => {
  return engine.exportVideo(segments, infos, settings, outPath, (p) => send('export-progress', p));
});
ipcMain.handle('cancel-export', () => engine.cancelExport());
ipcMain.handle('can-smart', (_e, segments, infos, settings) => engine.canSmartCut(segments, infos, settings));
ipcMain.handle('estimate', (_e, segments, infos, settings) => engine.estimateSize(segments, infos, settings));
/* ---------- Projects (.qcut is plain JSON: file paths + edit, never the media itself) ---------- */
const AUTOSAVE = () => path.join(app.getPath('userData'), 'autosave.qcut');
ipcMain.handle('project-save', async (_e, json, current, saveAs) => {
  let file = current;
  if (!file || saveAs) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save project',
      defaultPath: current || path.join(pref('save', app.getPath('documents')), `${JSON.parse(json).name || 'Untitled edit'}.qcut`),
      filters: [{ name: 'Quickcut project', extensions: ['qcut'] }],
    });
    if (r.canceled) return null;
    file = r.filePath;
  }
  fs.writeFileSync(file, json);
  remember('save', file);
  return file;
});
ipcMain.handle('project-open', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Open project', defaultPath: pref('save', app.getPath('documents')), properties: ['openFile'], filters: [{ name: 'Quickcut project', extensions: ['qcut'] }] });
    if (r.canceled) return null;
    file = r.filePaths[0];
  }
  return { file, json: fs.readFileSync(file, 'utf8') };
});
ipcMain.handle('autosave-write', (_e, json) => { try { fs.writeFileSync(AUTOSAVE(), json); } catch {} });
ipcMain.handle('autosave-read', () => { try { return fs.readFileSync(AUTOSAVE(), 'utf8'); } catch { return null; } });
ipcMain.handle('file-exists', (_e, p) => fs.existsSync(p));

ipcMain.handle('gpu-info', async () => { const g = await engine.detectGpu(); return { ...g, name: engine.gpuName(g.h264 || g.h265 || g.av1) }; });
ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('open-file', (_e, file) => shell.openPath(file));
ipcMain.handle('app-version', () => app.getVersion());

/* ---------- Updates (GitHub Releases) ---------- */

let updateState = { state: 'idle' };
const sendUpdate = (patch) => { updateState = { ...updateState, ...patch }; send('update', updateState); };

// States: idle · checking · current (up to date) · downloading · ready (restart to finish) · error · dev.
// Background checks run quietly; `manual` marks a check the person asked for, so only that one
// reports "up to date" or an error back to them.
let manual = false;
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { if (manual) sendUpdate({ state: 'checking' }); });
  autoUpdater.on('update-not-available', () => { sendUpdate({ state: manual ? 'current' : 'idle', checkedAt: Date.now() }); manual = false; });
  autoUpdater.on('update-available', (i) => { manual = false; sendUpdate({ state: 'downloading', version: i.version, percent: 0 }); });
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => {
    const offline = /ENOTFOUND|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|net::/i.test(String(e && e.message));
    sendUpdate(manual ? { state: 'error', error: offline ? 'Couldn’t reach the internet. Check your connection and try again.' : 'Couldn’t check for updates right now. Try again in a moment.' } : { state: 'idle' });
    manual = false;
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 1000 * 60 * 60 * 4);
}
ipcMain.handle('check-updates', async () => {
  if (!autoUpdater || !app.isPackaged) { sendUpdate({ state: 'dev' }); return updateState; }
  if (updateState.state === 'downloading' || updateState.state === 'ready' || updateState.state === 'checking') return updateState;
  manual = true;
  sendUpdate({ state: 'checking', error: null });
  autoUpdater.checkForUpdates().catch(() => {});
  return updateState;
});
ipcMain.handle('update-state', () => updateState);
ipcMain.handle('install-update', () => { if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall(true, true)); });
