const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { contextIsolation: false } });
  await win.loadURL('http://localhost:3738');
  await new Promise(r => setTimeout(r, 1500));
  const res = await win.webContents.executeJavaScript(`(() => {
    const host = document.createElement('div');
    host.innerHTML = '<button class="btn-primary btn-sm" id="m1">保存</button><button class="btn-ghost btn-sm" id="m2">キャンセル</button><button class="btn-primary" id="m3">OK</button><button class="btn-ghost" id="m4">取消</button>';
    document.body.appendChild(host);
    const h = id => document.getElementById(id).offsetHeight;
    const out = { smP: h('m1'), smG: h('m2'), mdP: h('m3'), mdG: h('m4') };
    host.remove();
    return out;
  })()`);
  console.log('RESULT ' + JSON.stringify(res));
  app.exit(0);
});
