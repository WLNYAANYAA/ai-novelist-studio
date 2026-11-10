// 汎用ユーティリティ（DOM操作・ダイアログ・API呼び出し）
import { $ } from './dom.js';

export function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
export function icon(name) {
  return `<svg class="icon"><use href="#i-${name}"/></svg>`;
}

// ---------- カスタムダイアログ（Electronは prompt/confirm/alert 非対応） ----------
export function appDialog(message, { input = false, defValue = '', okText = 'OK' } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-content" style="width:min(400px,90vw)">
        <div class="modal-body" style="padding:20px 24px">
          <p style="white-space:pre-wrap;font-size:13px;line-height:1.7;margin:0 0 12px">${esc(String(message))}</p>
          ${input ? `<input type="text" class="dlg-input" value="${esc(defValue)}" style="width:100%">` : ''}
        </div>
        <div class="modal-footer" style="justify-content:flex-end;gap:8px">
          ${input ? '<button class="btn-ghost dlg-cancel">キャンセル</button>' : ''}
          <button class="btn-primary dlg-ok">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inp = overlay.querySelector('.dlg-input');
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('.dlg-ok').onclick = () => done(input ? inp.value : true);
    const cancelBtn = overlay.querySelector('.dlg-cancel');
    if (cancelBtn) cancelBtn.onclick = () => done(input ? null : false);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(input ? null : false); });
    if (inp) inp.onkeydown = (e) => {
      if (e.key === 'Enter') done(inp.value);
      if (e.key === 'Escape') done(null);
    };
    setTimeout(() => { if (inp) { inp.focus(); inp.select(); } else overlay.querySelector('.dlg-ok').focus(); }, 50);
  });
}
export const appAlert = (m) => appDialog(m, { okText: 'OK' }).then(() => {});
export const appConfirm = (m) => appDialog(m).then((v) => v === true);
export const appPrompt = (m, def = '') => appDialog(m, { input: true, defValue: def });

// 猫化変換
export function nekoifyInput(t) {
  return t.replace(/[。！？!?\.\s]*$/, (s) => 'にゃ' + (s.includes('。') || s.includes('！') || s.includes('？') ? s : '。'));
}
export function nekoifyOutput(t) {
  return t.replace(/。/g, 'にゃ。');
}

// ---------- API helpers ----------
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
export function fmtTok(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

export function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 汎用結果モーダル ----------
export function showResultModal(title, html) {
  $('resultTitleText').textContent = title;
  $('resultBody').innerHTML = html;
  $('resultModal').classList.remove('hidden');
}
