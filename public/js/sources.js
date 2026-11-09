// ---------- Sources（参照資料・プロジェクト別） ----------
import { $ } from './dom.js';
import { api, esc, appAlert, appConfirm, appPrompt } from './util.js';
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
export function openSourcesModal(editSource = null) {
  refreshSources().then(() => {
    renderProjectFilter();
    renderSourceList();
  });
  $('sourcesModal').classList.remove('hidden');
  if (editSource) fillSourceForm(editSource);
  else resetSourceForm();
}
export function renderSourceList() {
  const el = $('sourceList');
  el.innerHTML = '';
  const f = ($('srcProjectFilter') || {}).value || '__all';
  const list = allSources.filter(s =>
    f === '__all' ? true : f === '__none' ? !s.project : s.project === f);
  if (!list.length) {
    el.innerHTML = '<p class="hint">ソースがありません。「新しいソース」で資料を登録してください。</p>';
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
export function importSourceFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const name = file.name.replace(/\.[^.]+$/, '');
    const f = ($('srcProjectFilter') || {}).value || '__all';
    const project = (f && f !== '__all' && f !== '__none' && f !== '__new') ? f : '';
    await api('/api/sources', { method: 'POST', body: JSON.stringify({ name, project, content: String(reader.result || '') }) });
    await refreshSources();
    renderProjectFilter();
    renderSourceList();
    resetSourceForm();
  };
  reader.readAsText(file, 'utf-8');
}
