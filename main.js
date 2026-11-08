const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');

// APPDATAがネットワークパスを指す環境でもローカルに保存する
app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'AI Novelist Studio'));
// NOTE: GPUアクセラレーションは有効のまま。以前ネットワークドライブ上のexeで
// GPUプロセスが落ちたため無効化していたが、全描画がソフトウェアレンダリングになり
// UI全体が著しく重くなるため削除した。ネットワーク共有から起動してクラッシュする
// 場合は下記を復活させること。
// app.disableHardwareAcceleration();
// app.commandLine.appendSwitch('disable-gpu');
// app.commandLine.appendSwitch('disable-gpu-compositing');
// app.commandLine.appendSwitch('disable-gpu-sandbox');
// app.commandLine.appendSwitch('no-sandbox');

const PORT = 3737;
const RATIO_W = 17;
const RATIO_H = 9;
const WIN_W = 1700;
const WIN_H = Math.round(WIN_W * RATIO_H / RATIO_W); // 900
const MIN_W = 1024;
const MIN_H = Math.round(MIN_W * RATIO_H / RATIO_W);
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

// ウィンドウサイズの保存・復元
function loadWindowSize() {
  try {
    const s = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) {
      return {
        width: Math.max(MIN_W, Math.round(s.width)),
        height: Math.max(MIN_H, Math.round(s.height))
      };
    }
  } catch {}
  return { width: WIN_W, height: WIN_H };
}
let saveTimer = null;
function writeWindowSize(win) {
  try {
    const [width, height] = win.getSize();
    require('fs').writeFileSync(STATE_FILE, JSON.stringify({ width, height }));
  } catch {}
}
function saveWindowSize(win) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeWindowSize(win), 400);
}

// Expressサーバーを同一プロセスで起動
try {
  require('./server.js');
} catch (e) {
  console.error('server.js の起動に失敗:', e.message);
}

function waitForServer(retries = 50) {
  return new Promise((resolve) => {
    const http = require('http');
    const tryOnce = (n) => {
      http.get(`http://localhost:${PORT}/api/config`, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (n <= 0) resolve(); // 諦めて開く
        else setTimeout(() => tryOnce(n - 1), 200);
      });
    };
    tryOnce(retries);
  });
}

async function createWindow() {
  await waitForServer();

  const saved = loadWindowSize();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    icon: path.join(__dirname, 'icon.ico'),
    minWidth: MIN_W,
    minHeight: MIN_H,
    useContentSize: true,
    backgroundColor: '#12111a',
    title: 'AI Novelist Studio',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // ウィンドウ最前列固定（レンダラーからの要求を中継）
  ipcMain.on('always-on-top', (e, flag) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setAlwaysOnTop(!!flag);
  });
  ipcMain.handle('always-on-top:get', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    return w ? w.isAlwaysOnTop() : false;
  });

  // グローバルホットキー（アプリ非アクティブ時も有効。フォーカス時は画面側のkeydownが処理）
  ipcMain.handle('hotkeys:set', (e, list) => {
    globalShortcut.unregisterAll();
    const w = BrowserWindow.fromWebContents(e.sender);
    for (const item of list || []) {
      try {
        globalShortcut.register(item.accelerator, () => {
          if (w && !w.isFocused()) w.webContents.send('hotkey:fire', item.combo);
        });
      } catch {}
    }
    return true;
  });

  // 17:9 比率を維持するリサイズ制御＋サイズ保存
  let adjusting = false;
  win.on('resize', () => {
    saveWindowSize(win);
    if (adjusting) return;
    const [w, h] = win.getSize();
    const targetW = Math.round(h * RATIO_W / RATIO_H);
    if (Math.abs(w - targetW) > 6) {
      adjusting = true;
      win.setSize(targetW, h);
      setTimeout(() => { adjusting = false; }, 50);
    }
  });
  win.on('close', () => { clearTimeout(saveTimer); writeWindowSize(win); });

  win.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
