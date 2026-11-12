// ---------- 横断検索・置換（原稿・ドキュメント・ソース） ----------
import { $ } from './dom.js';
import { api, appAlert, appConfirm } from './util.js';
import { allDocs, allSources } from './state.js';
import { listManuscriptScenes, msReplaceScenes } from './manuscript.js';
import { refreshDocuments } from './documents.js';
import { refreshSources } from './sources.js';

const stripHtml = (h) => String(h || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let targets = null; // {scenes, docs, sources} モーダルを開くたびに再収集

async function collectTargets() {
  const scenes = listManuscriptScenes().map(s => ({
    type: 'scene', id: s.id, label: `${s.chapter} / ${s.title}`, content: s.content || ''
  }));
  const docs = [];
  for (const d of allDocs.slice(0, 80)) {
    try {
      const f = await api('/api/documents/' + d.id);
      docs.push({ type: 'doc', id: f.id, label: f.title || '無題', content: f.content || '', html: true });
    } catch {}
  }
  const sources = allSources.map(s => ({
    type: 'source', id: s.id, label: s.name || '無題', content: s.content || '', project: s.project || ''
  }));
  return { scenes, docs, sources };
}

function scopeOn() {
  return {
    scene: $('srScopeMs')?.checked !== false,
    doc: $('srScopeDoc')?.checked !== false,
    source: $('srScopeSrc')?.checked !== false
  };
}
function allTargets() {
  if (!targets) return [];
  const sc = scopeOn();
  return [
    ...(sc.scene ? targets.scenes : []),
    ...(sc.doc ? targets.docs : []),
    ...(sc.source ? targets.sources : [])
  ];
}
function mkRe() {
  const q = $('srQuery').value;
  if (!q) return null;
  const flags = 'g' + ($('srCase')?.checked ? '' : 'i');
  try {
    return new RegExp($('srRegex')?.checked ? q : escRe(q), flags);
  } catch (e) {
    appAlert('正規表現が不正です: ' + e.message);
    return null;
  }
}
function displayText(t) { return t.html ? stripHtml(t.content) : t.content; }

function snippetAround(text, idx, len) {
  const s = Math.max(0, idx - 30);
  return (s > 0 ? '…' : '') + text.slice(s, idx + len + 30).replace(/\s+/g, ' ') + (idx + len + 30 < text.length ? '…' : '');
}

function doSearch() {
  if (!targets) { setStatus('読み込み中…'); return; }
  const re = mkRe();
  const q = $('srQuery').value;
  if (!re || !q) { $('srResults').innerHTML = '<p class="hint">検索文字列を入力してください</p>'; return; }
  const groups = [];
  for (const t of allTargets()) {
    const text = displayText(t);
    if (!text) continue;
    const m = text.match(re);
    if (!m || !m.length) continue;
    const idx = text.search(re);
    groups.push({ t, count: m.length, snippet: snippetAround(text, Math.max(0, idx), (m[0] || '').length) });
  }
  const total = groups.reduce((a, g) => a + g.count, 0);
  $('srStatus').textContent = `${groups.length}箇所 / 計${total}件`;
  const el = $('srResults');
  el.innerHTML = '';
  if (!groups.length) {
    el.innerHTML = '<p class="hint">一致する箇所がありません</p>';
    return;
  }
  const TYPE_LABEL = { scene: '原稿', doc: 'ドキュメント', source: 'ソース' };
  for (const g of groups.slice(0, 200)) {
    const div = document.createElement('div');
    div.className = 'sr-group';
    div.innerHTML = `
      <div class="sr-head">
        <span class="sr-type">${TYPE_LABEL[g.t.type]}</span>
        <strong class="sr-title"></strong>
        <span class="hint">${g.count}件</span>
        <button class="btn-ghost btn-sm sr-jump">開く</button>
        <button class="btn-ghost btn-sm sr-one">この場所を置換</button>
      </div>
      <div class="sr-snippet hint"></div>`;
    div.querySelector('.sr-title').textContent = g.t.label;
    div.querySelector('.sr-snippet').textContent = g.snippet;
    div.querySelector('.sr-jump').onclick = () => jumpTo(g.t);
    div.querySelector('.sr-one').onclick = async () => {
      const n = await replaceTargets([g.t]);
      $('srStatus').textContent = `${n}件を置換しました`;
      doSearch();
    };
    el.appendChild(div);
  }
  if (groups.length > 200) {
    el.innerHTML += `<p class="hint">…他 ${groups.length - 200} 箇所（表示は先頭200件まで）</p>`;
  }
}

function jumpTo(t) {
  if (t.type === 'scene') window.__openScene?.(t.id);
  else if (t.type === 'doc') window.__openDocument?.(t.id);
  else window.__openSources?.();
  $('srModal')?.classList.add('hidden');
}

// 1ターゲットの置換。戻り値は置換件数
async function replaceOne(t, re) {
  const rep = $('srReplace').value;
  if (t.type === 'scene') {
    return msReplaceScenes(re, rep, [t.id]).count;
  }
  if (t.type === 'doc') {
    const full = await api('/api/documents/' + t.id);
    const content = full.content || '';
    const n = (content.match(re) || []).length;
    if (!n) return 0;
    await api('/api/documents/' + t.id, {
      method: 'PUT',
      body: JSON.stringify({ title: full.title, project: full.project || '', content: content.replace(re, () => rep) })
    });
    await refreshDocuments();
    return n;
  }
  // source
  const full = await api('/api/sources/' + t.id);
  const content = full.content || '';
  const n = (content.match(re) || []).length;
  if (!n) return 0;
  await api('/api/sources/' + t.id, {
    method: 'PUT',
    body: JSON.stringify({ name: full.name, project: full.project || '', content: content.replace(re, () => rep) })
  });
  await refreshSources();
  return n;
}

// シーンはまとめて1回で置換（msReplaceScenesはsceneIdsで絞れるが、複数シーン指定も可）
async function replaceTargets(list) {
  const re = mkRe();
  if (!re) return 0;
  const rep = $('srReplace').value;
  let total = 0;
  // sceneは個別API不要：sceneIdsまとめて処理
  const sceneTargets = list.filter(t => t.type === 'scene');
  const otherTargets = list.filter(t => t.type !== 'scene');
  if (sceneTargets.length) {
    const r = msReplaceScenes(re, rep, sceneTargets.map(t => t.id));
    total += r.count;
  }
  for (const t of otherTargets) {
    try { total += await replaceOne(t, re); }
    catch (e) { $('srStatus').textContent = '置換失敗: ' + e.message; }
  }
  return total;
}

export function openSearchReplace() {
  $('srModal').classList.remove('hidden');
  $('srQuery').focus();
  $('srQuery').select();
  setStatus('');
  collectTargets().then(t => { targets = t; });
}
function setStatus(msg) { const el = $('srStatus'); if (el) el.textContent = msg; }

export function initSearchReplace() {
  $('btnCloseSr') && ($('btnCloseSr').onclick = () => $('srModal').classList.add('hidden'));
  $('srModal') && $('srModal').addEventListener('click', (e) => {
    if (e.target === $('srModal')) $('srModal').classList.add('hidden');
  });
  $('miSearchReplace') && ($('miSearchReplace').onclick = openSearchReplace);
  $('srSearch') && ($('srSearch').onclick = () => { setStatus('検索中…'); setTimeout(doSearch, 30); });
  $('srQuery') && $('srQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('srSearch').click(); }
  });
  $('srReplaceAll') && ($('srReplaceAll').onclick = async () => {
    const q = $('srQuery').value;
    if (!q) { appAlert('検索文字列を入力してください'); return; }
    const list = allTargets();
    if (!list.length) { appAlert('対象がありません'); return; }
    // 事前に件数を数える
    const re = mkRe();
    if (!re) return;
    let hits = 0;
    for (const t of list) hits += (displayText(t).match(re) || []).length;
    if (!hits) { appAlert('置換対象がありません'); return; }
    if (!(await appConfirm(`計${hits}箇所を「${$('srReplace').value || '（削除）'}」に置換しますか？この操作は元に戻せません`))) return;
    setStatus('置換中…');
    const n = await replaceTargets(list);
    setStatus(`${n}件を置換しました`);
    doSearch();
  });
}
