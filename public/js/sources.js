// ---------- Sources（参照資料・プロジェクト別） ----------
import { $ } from './dom.js';
import { api, esc, appAlert, appConfirm, appPrompt, fileToBase64 } from './util.js';
import { allSources, setAllSources } from './state.js';
import { renderConvProjectFilter } from './conversations.js';

export async function refreshSources() {
  setAllSources(await api('/api/sources'));
  renderConvProjectFilter();
}
function sourceProjectNames() {
  return [...new Set(allSources.map(s => s.project || '').filter(Boolean))].sort();
}
export function fillSourceProjectSelect(sel, current) {
  const names = sourceProjectNames();
  sel.innerHTML = '<option value="">（プロジェクトなし）</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__new">＋新しいプロジェクト…</option>';
  if (current && current !== '__new' && !names.includes(current)) sel.add(new Option(current, current));
  sel.value = current || '';
}
async function ensureProjectName(sel) {
  if (sel.value !== '__new') return sel.value;
  const name = await appPrompt('プロジェクト名を入力', '');
  if (!name || !name.trim()) { sel.value = ''; return ''; }
  const n = name.trim();
  fillSourceProjectSelect(sel, n);
  return n;
}
function renderProjectFilter() {
  const names = sourceProjectNames();
  const sel = $('srcProjectFilter');
  const cur = sel.value || '__all';
  sel.innerHTML = '<option value="__all">すべてのソース</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__none">（プロジェクトなし）</option>';
  sel.value = names.includes(cur) || ['__all', '__none'].includes(cur) ? cur : '__all';
}
// 検索結果からのジャンプ用
window.__openSources = () => openSourcesModal();

export function openSourcesModal(editSource = null) {
  refreshSources().then(() => {
    renderProjectFilter();
    renderSourceList();
  });
  const f = $('srcFilter');
  if (f) { f.value = ''; f.oninput = renderSourceList; }
  $('sourcesModal').classList.remove('hidden');
  if (editSource) fillSourceForm(editSource);
  else resetSourceForm();
}
export function renderSourceList() {
  const el = $('sourceList');
  el.innerHTML = '';
  const f = ($('srcProjectFilter') || {}).value || '__all';
  const q = (($('srcFilter') || {}).value || '').trim().toLowerCase();
  const list = allSources.filter(s => {
    if (f !== '__all' && (f === '__none' ? !!s.project : s.project !== f)) return false;
    if (q && !((s.name || '').toLowerCase().includes(q) || (s.content || '').toLowerCase().includes(q))) return false;
    return true;
  });
  if (!list.length) {
    el.innerHTML = '<p class="hint">' + (q ? '「' + esc(q) + '」に一致するソースがありません' : 'ソースがありません。「新しいソース」で資料を登録してください。') + '</p>';
    return;
  }
  for (const s of list) {
    const div = document.createElement('div');
    div.className = 'card-item';
    const hint = (s.content || '').slice(0, 60).replace(/\n/g, ' ');
    div.innerHTML = `<strong></strong> ${s.project ? `<span class="card-kind">${esc(s.project)}</span>` : ''} <span class="hint"></span>`;
    div.querySelector('strong').textContent = s.name;
    div.querySelector('.hint').textContent = `${(s.content || '').length.toLocaleString()}字 — ${hint}`;
    div.onclick = () => fillSourceForm(s);
    el.appendChild(div);
  }
}
function fillSourceForm(s) {
  $('sourceEditForm').classList.remove('hidden');
  $('srcId').value = s.id;
  $('srcName').value = s.name;
  fillSourceProjectSelect($('srcProject'), s.project || '');
  $('srcContent').value = s.content || '';
  $('btnDeleteSource').classList.remove('hidden');
}
export function resetSourceForm() {
  $('sourceEditForm').classList.add('hidden');
  $('srcId').value = ''; $('srcName').value = ''; $('srcContent').value = '';
  fillSourceProjectSelect($('srcProject'), '');
  $('btnDeleteSource').classList.add('hidden');
}
export async function saveSource() {
  const id = $('srcId').value;
  const project = await ensureProjectName($('srcProject'));
  const body = { name: $('srcName').value.trim() || '無題', project, content: $('srcContent').value };
  if (!body.content.trim()) { appAlert('内容を入力してください'); return; }
  if (id) await api('/api/sources/' + id, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/sources', { method: 'POST', body: JSON.stringify(body) });
  await refreshSources();
  renderProjectFilter();
  renderSourceList();
  resetSourceForm();
}
export async function deleteSource() {
  const id = $('srcId').value;
  if (!id || !(await appConfirm('このソースを削除しますか？'))) return;
  await api('/api/sources/' + id, { method: 'DELETE' });
  await refreshSources();
  renderProjectFilter();
  renderSourceList();
  resetSourceForm();
}
async function registerSource(name, project, content) {
  await api('/api/sources', { method: 'POST', body: JSON.stringify({ name, project, content }) });
  await refreshSources();
  renderProjectFilter();
  renderSourceList();
  resetSourceForm();
}

export async function importSourceFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.match(/\.([^.]+)$/) || [])[1] || '';
  const f = ($('srcProjectFilter') || {}).value || '__all';
  const project = (f && f !== '__all' && f !== '__none' && f !== '__new') ? f : '';

  if (['pdf', 'docx'].includes(ext.toLowerCase())) {
    if (file.size > 15 * 1024 * 1024) { appAlert('ファイルが大きすぎます（15MBまで）'); return; }
    try {
      const dataBase64 = await fileToBase64(file);
      const r = await api('/api/import/text', { method: 'POST', body: JSON.stringify({ name, ext, dataBase64 }) });
      if (!r.text || !r.text.trim()) { appAlert('テキストを抽出できませんでした。スキャンPDFや画像PDFの可能性があります'); return; }
      await registerSource(r.name || name, project, r.text);
    } catch (e) {
      appAlert('取り込みに失敗しました: ' + (e.message || e));
    }
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    await registerSource(name, project, String(reader.result || ''));
  };
  reader.readAsText(file, 'utf-8');
}
