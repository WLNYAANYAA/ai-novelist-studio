const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron');
const path = require('path');
const os = require('os');

// Windowsのタスクバー/Alt+Tabで「Electron」ではなくアプリ名・アイコンを表示するためのID
app.setAppUserModelId('com.ainoveliststudio.app');

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
const WIN_W = 1700;
const WIN_H = 900;
const MIN_W = 900;
const MIN_H = 560;
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
let appServer = null;
try {
  appServer = require('./server.js');
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

  // ポート3737を別のAI Novelist Studio（古いサーバー等）が占有している場合、
  // そちらの古いフロントエンド/インメモリデータを読みに行ってしまうため起動を中止する
  try {
    const v = await new Promise((resolve, reject) => {
      require('http').get(`http://localhost:${PORT}/api/version`, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
      }).on('error', reject);
    });
    if (!appServer || v.boot !== appServer.bootId) {
      dialog.showErrorBox(
        'AI Novelist Studio',
        'ポート 3737 は別の「AI Novelist Studio」または別アプリに使われています。\n\n' +
        '古いデータで上書きされるのを防ぐため起動を中止しました。\n' +
        '既に起動しているインスタンスを閉じてから、もう一度お試しください。'
      );
      app.quit();
      return;
    }
  } catch {
    // /api/version に応答しない = 自分のサーバーが立っていない。接続エラーページを出すより中止する
    dialog.showErrorBox(
      'AI Novelist Studio',
      `http://localhost:${PORT} のサーバーを起動できませんでした。\n` +
      'ポートが他のアプリに使われている可能性があります。'
    );
    app.quit();
    return;
  }

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

  // サイズ保存（縦横比の固定はしない。自由にリサイズ可能）
  win.on('resize', () => saveWindowSize(win));
  win.on('close', () => { clearTimeout(saveTimer); writeWindowSize(win); });

  win.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
