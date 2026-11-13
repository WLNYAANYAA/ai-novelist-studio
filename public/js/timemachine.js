// ---------- タイムマシン（全データの時点スナップショット・比較・復元） ----------
import { $ } from './dom.js';
import { api, esc, appConfirm, appAlert } from './util.js';

const KIND_LABEL = {
  conv: '会話', card: 'カード', template: 'テンプレート', source: 'ソース',
  doc: 'ドキュメント', manuscript: '原稿', worldgraph: '物語グラフ',
  projectPreset: 'プリセット', snapshot: '会話履歴'
};
const fmtTime = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB';

let snaps = [];
let cmpA = null, cmpB = null;

async function loadList() {
  snaps = await api('/api/timemachine');
  renderList();
}
function renderList() {
  const el = $('tmList');
  el.innerHTML = '';
  if (!snaps.length) {
    el.innerHTML = '<p class="hint" style="padding:8px">まだ記録がありません。「今すぐ記録」または執筆を続けると30分ごとに自動記録されます。</p>';
    return;
  }
  for (const s of snaps) {
    const div = document.createElement('div');
    div.className = 'tm-row' + (cmpA === s.id ? ' tm-cmp-a' : '') + (cmpB === s.id ? ' tm-cmp-b' : '');
    div.innerHTML = `
      <span class="tm-time"></span>
      ${s.auto ? '<span class="tm-badge">自動</span>' : ''}
      <span class="tm-label"></span>
      <span class="hint tm-meta"></span>
      <span class="tm-btns">
        <button class="btn-ghost btn-sm tm-cmp" title="比較する2時点を選択">⇄</button>
        <button class="btn-ghost btn-sm tm-restore">戻す</button>
        <button class="btn-ghost btn-sm tm-del">削除</button>
      </span>`;
    div.querySelector('.tm-time').textContent = fmtTime(s.ts);
    div.querySelector('.tm-label').textContent = s.label || '';
    div.querySelector('.tm-meta').textContent = `${s.count}件・${fmtSize(s.bytes || 0)}`;
    div.querySelector('.tm-cmp').onclick = () => pickCompare(s.id);
    div.querySelector('.tm-restore').onclick = () => restoreSnap(s);
    div.querySelector('.tm-del').onclick = () => deleteSnap(s);
    el.appendChild(div);
  }
}

function pickCompare(id) {
  if (cmpA === id) { cmpA = null; renderList(); return; }
  if (!cmpA) { cmpA = id; renderList(); return; }
  if (cmpB === id) { cmpB = null; renderList(); return; }
  cmpB = id;
  renderList();
  runCompare();
}

async function record() {
  const label = $('tmLabel').value.trim();
  const meta = await api('/api/timemachine', { method: 'POST', body: JSON.stringify({ label }) });
  $('tmLabel').value = '';
  await loadList();
  appAlert(`記録しました：${meta.count}件・${fmtSize(meta.bytes)}`);
}

async function deleteSnap(s) {
  if (!(await appConfirm(`「${s.label || fmtTime(s.ts)}」（${fmtTime(s.ts)}）を削除しますか？この操作は元に戻せません`))) return;
  await api('/api/timemachine/' + s.id, { method: 'DELETE' });
  if (cmpA === s.id) cmpA = null;
  if (cmpB === s.id) cmpB = null;
  await loadList();
}

async function restoreSnap(s) {
  if (!(await appConfirm(
    `【${fmtTime(s.ts)} ${s.label || ''}】の時点に全データを戻します。\n現在の内容は失われます（この操作自体は記録されません）。\n本当に戻しますか？`
  ))) return;
  await api('/api/timemachine/' + s.id + '/restore', { method: 'POST', body: '{}' });
  location.reload();
}

// ---------- 比較 ----------
function docsMap(payload) {
  const m = new Map();
  for (const d of payload.docs || []) m.set(d.kind + '/' + d.id, d);
  return m;
}
function docDisplayName(kind, d) {
  try {
    const j = JSON.parse(d.data);
    return j.title || j.name || j.label || '';
  } catch { return ''; }
}
async function runCompare() {
  const el = $('tmCompare');
  el.innerHTML = '';
  if (!cmpA || !cmpB) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<p class="hint">比較中…</p>';
  try {
    const [pa, pb] = await Promise.all([
      api('/api/timemachine/' + cmpA),
      api('/api/timemachine/' + cmpB)
    ]);
    const ma = docsMap(pa), mb = docsMap(pb);
    const keys = new Set([...ma.keys(), ...mb.keys()]);
    const changes = [];
    for (const k of keys) {
      const a = ma.get(k), b = mb.get(k);
      if (a && b && a.data === b.data) continue;
      const [kind, id] = k.split('/');
      const d = b || a;
      changes.push({
        kind, id, key: k,
        status: !a ? 'added' : !b ? 'removed' : 'changed',
        label: docDisplayName(kind, d) || id,
        aData: a ? a.data : null,
        bData: b ? b.data : null
      });
    }
    const nameA = snaps.find(s => s.id === cmpA), nameB = snaps.find(s => s.id === cmpB);
    let html = `<div class="tm-cmp-head hint">${esc(nameA?.label || '')}（${fmtTime(+cmpA)}）→ ${esc(nameB?.label || '')}（${fmtTime(+cmpB)}）：${changes.length}件の差分</div>`;
    if (!changes.length) html += '<p class="hint">差分はありません</p>';
    for (const c of changes.slice(0, 300)) {
      const st = c.status === 'added' ? '追加' : c.status === 'removed' ? '削除' : '変更';
      html += `<div class="sr-group tm-chg" data-key="${esc(c.key)}">
        <div class="sr-head">
          <span class="sr-type">${KIND_LABEL[c.kind] || c.kind}</span>
          <strong class="sr-title"></strong>
          <span class="hint">${st}</span>
          <button class="btn-ghost btn-sm tm-view">差分を見る</button>
        </div>
      </div>`;
    }
    if (changes.length > 300) html += `<p class="hint">…他 ${changes.length - 300} 件</p>`;
    el.innerHTML = html;
    el.querySelectorAll('.tm-chg').forEach(node => {
      const key = node.dataset.key;
      const c = changes.find(x => x.key === key);
      node.querySelector('.sr-title').textContent = c.label;
      node.querySelector('.tm-view').onclick = () => showDiff(c);
    });
  } catch (e) {
    el.innerHTML = `<p class="hint">比較に失敗しました: ${esc(e.message)}</p>`;
  }
}

// ---------- 差分表示 ----------
function projectText(kind, id, dataStr) {
  if (dataStr == null) return '';
  try {
    const j = JSON.parse(dataStr);
    if (kind === 'manuscript') {
      const lines = [];
      for (const ch of j.chapters || []) {
        lines.push(`# 章: ${ch.title || ''}`);
        for (const sc of ch.scenes || []) {
          lines.push(`## シーン: ${sc.title || ''}`);
          lines.push(String(sc.content || ''));
        }
      }
      return lines.join('\n');
    }
    if (kind === 'conv') {
      const lines = [`会話: ${j.title || ''}`];
      for (const m of j.messages || []) lines.push(`[${m.role}] ${m.content || ''}`);
      return lines.join('\n');
    }
    if (kind === 'doc' || kind === 'source') {
      const html = j.content || j.text || '';
      // ブロック要素の終了タグだけ改行にし、他のタグは空白化（差分が読みやすい）
      return String(html)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|section|article|blockquote|ul|ol)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ');
    }
    if (kind === 'card') return `カード: ${j.name || ''}\n[${j.kind || ''}]\n${j.content || ''}`;
    // その他: JSONを読みやすく
    return JSON.stringify(j, null, 2);
  } catch {
    return String(dataStr);
  }
}

function diffLines(aText, bText) {
  const a = aText.split('\n'), b = bText.split('\n');
  if (a.length > 1200 || b.length > 1200) return null;
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', x: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', x: a[i] }); i++; }
    else { out.push({ t: '+', x: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', x: a[i++] });
  while (j < m) out.push({ t: '+', x: b[j++] });
  return out;
}

function showDiff(c) {
  $('tmDiffTitle').textContent = `${KIND_LABEL[c.kind] || c.kind}：${c.label}`;
  const aText = projectText(c.kind, c.id, c.aData);
  const bText = projectText(c.kind, c.id, c.bData);
  const pre = $('tmDiffBody');
  if (c.status === 'added') {
    pre.innerHTML = '<div class="tm-diff-add">（新規追加）</div>' + esc(bText).replace(/\n/g, '<br>');
  } else if (c.status === 'removed') {
    pre.innerHTML = '<div class="tm-diff-del">（削除された）</div>' + esc(aText).replace(/\n/g, '<br>');
  } else {
    const ops = diffLines(aText, bText);
    if (!ops) {
      pre.innerHTML = '<p class="hint">行数が多すぎるため差分を計算できません。テキストが大幅に変更された可能性があります。</p>';
    } else {
      // 変更のある行だけ前後2行のコンテキストで表示（連続する変更はまとめる）
      const keep = new Set();
      ops.forEach((op, idx) => {
        if (op.t !== ' ') { for (let k = Math.max(0, idx - 2); k <= Math.min(ops.length - 1, idx + 2); k++) keep.add(k); }
      });
      let html = '';
      let last = -2;
      ops.forEach((op, idx) => {
        if (!keep.has(idx)) {
          if (last !== idx - 1 && idx > 0) html += '<div class="tm-diff-skip">⋮</div>';
          return;
        }
        const cls = op.t === '+' ? 'tm-diff-add' : op.t === '-' ? 'tm-diff-del' : '';
        html += `<div class="${cls}">${op.t === ' ' ? ' ' : op.t} ${esc(op.x)}</div>`;
      });
      pre.innerHTML = html || '<p class="hint">表示できる差分がありません</p>';
    }
  }
  $('tmDiffModal').classList.remove('hidden');
}

// ---------- 公開 ----------
export function openTimeMachine() {
  $('tmModal').classList.remove('hidden');
  cmpA = cmpB = null;
  $('tmCompare').classList.add('hidden');
  $('tmCompare').innerHTML = '';
  $('tmLabel').value = '';
  loadList();
}

export function initTimeMachine() {
  $('btnCloseTm') && ($('btnCloseTm').onclick = () => $('tmModal').classList.add('hidden'));
  $('tmModal') && $('tmModal').addEventListener('click', (e) => {
    if (e.target === $('tmModal')) $('tmModal').classList.add('hidden');
  });
  $('tmSave') && ($('tmSave').onclick = record);
  $('tmLabel') && $('tmLabel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) record();
  });
  $('btnCloseTmDiff') && ($('btnCloseTmDiff').onclick = () => $('tmDiffModal').classList.add('hidden'));
  $('tmDiffModal') && $('tmDiffModal').addEventListener('click', (e) => {
    if (e.target === $('tmDiffModal')) $('tmDiffModal').classList.add('hidden');
  });
  $('miTimeMachine') && ($('miTimeMachine').onclick = openTimeMachine);
}
