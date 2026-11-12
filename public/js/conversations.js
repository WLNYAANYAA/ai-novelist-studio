// ---------- Conversations（一覧・タブ・下書き・検索・プロフィールパネル） ----------
import { $, chatEl, inputEl, convListEl, convTitleEl, tokenBadgeEl, searchBox, searchResultsEl } from './dom.js';
import { api, esc, icon, fmtDate, appConfirm, appPrompt } from './util.js';
import { current, setCurrent, allSources, allDocs, draftKey } from './state.js';
import { clearChat, renderMessage, scrollChat, updateCharCount } from './messages.js';
import { updateTokenBadge } from './chat.js';
import { hideTagSug } from './tags.js';
import { maybeAutoApplyPreset, updatePresetStatus } from './presets.js';
import { Fuse } from './vendor.bundle.js';

// 会話タイトルのあいまい検索用インデックス（fuse.js）
let convFuse = null;
let convFuseList = null;
function fuzzyConvIds(q) {
  if (convFuseList !== conversations) {
    convFuseList = conversations;
    convFuse = new Fuse(conversations, {
      keys: ['title', 'project'],
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }
  return new Set(convFuse.search(q).map(h => h.item.id));
}

export let conversations = [];
export let tabs = [];        // [{type:'conv'|'doc', id}] 開いているタブ
export let activeTabType = 'conv';
export let activeTabId = null;

// ---------- タブ基盤（conv/doc 共通） ----------
const tabKey = (t) => (t.type === 'doc' ? 'd:' : '') + t.id;
const isActiveTab = (t) => t.type === activeTabType && t.id === activeTabId;
const tabOpeners = {}; // type -> (id) => Promise
export function registerTabOpener(type, fn) { tabOpeners[type] = fn; }
export async function openTabEntry(tab) {
  const fn = tabOpeners[tab.type] || (tab.type === 'conv' ? openConversation : null);
  if (fn) await fn(tab.id);
  else showEmptyChat();
}
export function activateTab(type, id) {
  if (!tabs.some(t => t.type === type && t.id === id)) tabs.push({ type, id });
  activeTabType = type; activeTabId = id;
  saveTabs(); renderTabs();
}
let msPaneWasOpen = false;
export function showChatView() {
  $('docPane')?.classList.add('hidden');
  $('chatCol')?.classList.remove('hidden');
  if (msPaneWasOpen) {
    msPaneWasOpen = false;
    $('manuscriptPane')?.classList.remove('hidden');
    $('qbManuscript')?.classList.add('active');
  }
}
export function showDocView() {
  msPaneWasOpen = !!$('manuscriptPane') && !$('manuscriptPane').classList.contains('hidden');
  $('chatCol')?.classList.add('hidden');
  $('manuscriptPane')?.classList.add('hidden');
  $('paramsPanel')?.classList.add('hidden');
  $('docPane')?.classList.remove('hidden');
}

// プロジェクト名の一覧（会話とソースの project を統合した名前空間）
export function projectNamesAll() {
  const set = new Set();
  for (const c of conversations) if (c.project) set.add(c.project);
  for (const s of allSources) if (s.project) set.add(s.project);
  return [...set].sort();
}
export function renderConvProjectFilter() {
  const sel = $('convProjectFilter');
  if (!sel) return;
  const cur = sel.value || '__all';
  const names = projectNamesAll();
  sel.innerHTML = '<option value="__all">すべての会話</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__none">（プロジェクトなし）</option>';
  sel.value = cur === '__all' || cur === '__none' || names.includes(cur) ? cur : '__all';
}
export async function refreshConvList() {
  conversations = await api('/api/conversations');
  renderConvProjectFilter();
  renderConvList();
}

// 複数選択状態
const selectedConvs = new Set();
let lastSelIndex = -1;
let visibleConvs = [];
function updateSelUI() {
  const bar = $('bulkBar');
  if (!bar) return;
  if (selectedConvs.size) {
    $('bulkCount').textContent = `${selectedConvs.size}件選択中`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}
export function clearConvSelection() {
  selectedConvs.clear(); lastSelIndex = -1;
  convListEl.querySelectorAll('.conv-item.selected').forEach(el => el.classList.remove('selected'));
  updateSelUI();
}
export async function deleteSelectedConvs() {
  const ids = [...selectedConvs];
  if (!ids.length) return;
  if (!(await appConfirm(`${ids.length}件の会話を削除しますか？この操作は元に戻せません`))) return;
  for (const id of ids) {
    try { await api('/api/conversations/' + id, { method: 'DELETE' }); } catch {}
  }
  tabs = tabs.filter(t => !(t.type === 'conv' && ids.includes(t.id)));
  clearConvSelection();
  if (current && ids.includes(current.id) && activeTabType === 'conv') {
    activeTabType = 'conv'; activeTabId = null; setCurrent(null); clearChat(); showChatView();
    const nextTab = tabs[tabs.length - 1];
    const nextConvId = conversations.find(c => !ids.includes(c.id))?.id;
    if (nextTab) await openTabEntry(nextTab);
    else if (nextConvId) await openConversation(nextConvId);
    else showEmptyChat();
  } else {
    saveTabs(); renderTabs();
  }
  await refreshConvList();
}
export function showEmptyChat() {
  showChatView();
  convTitleEl.textContent = '会話を選択';
  chatEl.innerHTML = '<div class="msg bot" style="align-self:center;color:var(--text-dim)">タブがありません。サイドバーか「＋」から会話を開いてください</div>';
  loadProfileToPanel();
  updateTokenBadge();
  updateCharCount();
}

export function renderConvList() {
  const q = searchBox.value.trim().toLowerCase();
  const pf = ($('convProjectFilter') || {}).value || '__all';
  convListEl.innerHTML = '';
  searchResultsEl.classList.add('hidden');
  const fuzzyIds = q.length >= 2 ? fuzzyConvIds(q) : null;
  visibleConvs = conversations.filter(c => {
    if (q) {
      const title = (c.title || '').toLowerCase();
      if (!title.includes(q) && !(fuzzyIds && fuzzyIds.has(c.id))) return false;
    }
    if (pf === '__all') return true;
    if (pf === '__none') return !c.project;
    return c.project === pf;
  });
  visibleConvs.forEach((c, idx) => {
    const div = document.createElement('div');
    div.className = 'conv-item' + (current && c.id === current.id ? ' active' : '') + (selectedConvs.has(c.id) ? ' selected' : '');
    div.innerHTML = `<div class="title"></div><div class="meta"></div>`;
    div.querySelector('.title').textContent = c.title;
    div.querySelector('.meta').textContent = `${c.project ? '📁' + c.project + ' · ' : ''}${c.messageCount} msgs · ${fmtDate(c.updated)}`;
    const del = document.createElement('span');
    del.className = 'del';
    del.innerHTML = icon('close');
    del.title = '削除';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!(await appConfirm(`「${c.title}」を削除しますか？`))) return;
      await api('/api/conversations/' + c.id, { method: 'DELETE' });
      selectedConvs.delete(c.id);
      const wasActive = current && current.id === c.id && activeTabType === 'conv';
      tabs = tabs.filter(t => !(t.type === 'conv' && t.id === c.id)); // 開いているタブも閉じる
      if (wasActive) {
        activeTabType = 'conv'; activeTabId = null;
        setCurrent(null); clearChat(); showChatView();
        const nextTab = tabs[tabs.length - 1];
        const nextConvId = conversations.find(x => x.id !== c.id)?.id;
        if (nextTab) await openTabEntry(nextTab);
        else if (nextConvId) await openConversation(nextConvId);
        else if (conversations.length > 1) showEmptyChat();
        else await newConversation();
      } else {
        saveTabs(); renderTabs();
      }
      await refreshConvList();
    };
    const ren = document.createElement('span');
    ren.className = 'del ren';
    ren.innerHTML = icon('edit');
    ren.title = '名前を変更';
    ren.style.right = '46px';
    ren.onclick = (e) => {
      e.stopPropagation();
      startConvRename(div, c);
    };
    const dup = document.createElement('span');
    dup.className = 'del dup';
    dup.innerHTML = icon('branch');
    dup.title = 'この会話を複製';
    dup.style.right = '26px';
    dup.onclick = async (e) => {
      e.stopPropagation();
      const full = await api('/api/conversations/' + c.id);
      await duplicateConversation(full);
    };
    div.appendChild(ren);
    div.appendChild(dup);
    div.appendChild(del);
    div.onclick = (e) => {
      e.stopPropagation();
      if (e.shiftKey && lastSelIndex >= 0) {
        // Shift+クリック：最後に選択した位置からの範囲選択
        const [a, b] = [Math.min(lastSelIndex, idx), Math.max(lastSelIndex, idx)];
        for (let i = a; i <= b; i++) selectedConvs.add(visibleConvs[i].id);
        lastSelIndex = idx;
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+クリック：個別トグル
        if (selectedConvs.has(c.id)) selectedConvs.delete(c.id);
        else selectedConvs.add(c.id);
        lastSelIndex = idx;
      } else {
        clearConvSelection();
        openConversation(c.id);
        return;
      }
      div.classList.toggle('selected', selectedConvs.has(c.id));
      updateSelUI();
    };
    convListEl.appendChild(div);
  });
  updateSelUI();
  renderTabs();
}

// ---------- 会話リネーム ----------
export async function renameConversation(c, newTitle) {
  newTitle = (newTitle || '').trim();
  if (!newTitle || newTitle === c.title) { renderConvList(); return; }
  await api('/api/conversations/' + c.id, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
  c.title = newTitle;
  if (current && current.id === c.id) {
    current.title = newTitle;
    convTitleEl.textContent = newTitle;
    renderTabs();
  }
  await refreshConvList();
}
function startConvRename(div, c) {
  const titleEl = div.querySelector('.title');
  const input = document.createElement('input');
  input.className = 'conv-rename';
  input.value = c.title;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = input.value;
    if (save) renameConversation(c, v); else renderConvList();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  input.onclick = (e) => e.stopPropagation();
  input.onblur = () => finish(true);
}

// ---------- Tabs ----------
function saveTabs() {
  localStorage.setItem('open_tabs', JSON.stringify(tabs.map(tabKey)));
  localStorage.setItem('active_tab', activeTabId ? tabKey({ type: activeTabType, id: activeTabId }) : '');
}
export function renderTabs() {
  const el = $('tabs');
  if (!el) return;
  el.innerHTML = '';
  for (const t of tabs) {
    const isDoc = t.type === 'doc';
    const title = isDoc
      ? (allDocs.find(x => x.id === t.id)?.title || '読み込み中…')
      : (conversations.find(x => x.id === t.id)?.title || '読み込み中…');
    const div = document.createElement('div');
    div.className = 'tab' + (isActiveTab(t) ? ' active' : '') + (isDoc ? ' tab-doc' : '');
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = title || '無題';
    titleEl.title = title || '';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'タブを閉じる（データは削除されません）';
    close.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    div.appendChild(titleEl);
    div.appendChild(close);
    div.onclick = () => { if (!isActiveTab(t)) openTabEntry(t); };
    el.appendChild(div);
  }
  const active = el.querySelector('.tab.active');
  if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
export async function closeTab(tab) {
  const idx = tabs.findIndex(t => t.type === tab.type && t.id === tab.id);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (isActiveTab(tab)) {
    if (tab.type === 'conv') saveDraft(); // 閉じるタブの下書きを保存
    activeTabType = 'conv'; activeTabId = null;
    setCurrent(null);
    clearChat();
    showChatView();
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) {
      await openTabEntry(next);
      return;
    }
    // 最後のタブ：新規会話は作らず空の状態にする（会話が増殖するのを防ぐ）
    showEmptyChat();
  }
  saveTabs();
  renderTabs();
}

// ---------- 下書き保存（会話ごとに入力途中のテキストを保持） ----------
function saveDraft() {
  if (!current) return;
  const v = inputEl.value;
  if (v) localStorage.setItem(draftKey(), v);
  else localStorage.removeItem(draftKey());
}
let draftTimer = null;
function queueDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 300);
}
export { queueDraftSave };

export async function openConversation(id) {
  saveDraft(); // 切り替え前の会話の下書きを保存
  document.body.classList.remove('sidebar-open'); // モバイルのドロワーを閉じる
  activateTab('conv', id);
  await loadConv(id);
}

export async function loadConv(id) {
  showChatView();
  setCurrent(await api('/api/conversations/' + id));
  current.profile = current.profile || {};
  current.cardIds = current.cardIds || [];
  current.snapshots = current.snapshots || [];
  inputEl.value = localStorage.getItem(draftKey()) || '';
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  hideTagSug();
  renderConvList();
  convTitleEl.textContent = current.title;
  clearChat();
  for (const m of current.messages || []) renderMessage(m);
  loadProfileToPanel();
  maybeAutoApplyPreset().then(updatePresetStatus).catch(() => {});
  updateTokenBadge();
  updateCharCount();
  scrollChat(true);
}

export async function newConversation() {
  // 名前入力を求める。キャンセル・空欄なら従来通り自動タイトルで作成
  const name = await appPrompt('会話名を入力（空欄またはキャンセルで自動命名）', '');
  const title = (name || '').trim();
  const pf = ($('convProjectFilter') || {}).value || '__all';
  const project = (pf !== '__all' && pf !== '__none') ? pf : '';
  const conv = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ ...(title ? { title } : {}), project })
  });
  await refreshConvList();
  await openConversation(conv.id);
  inputEl.focus();
}

export async function saveConversation(conv) {
  conv = conv || current;
  if (!conv) return;
  await api('/api/conversations/' + conv.id, {
    method: 'PUT',
    body: JSON.stringify({
      title: conv.title,
      messages: conv.messages,
      profile: conv.profile,
      cardIds: conv.cardIds,
      snapshots: conv.snapshots,
      totalTokens: conv.totalTokens,
      project: conv.project
    })
  });
  await refreshConvList();
}

// ---------- 会話の複製 ----------
export async function duplicateConversation(c) {
  const conv = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({
      title: c.title + '（コピー）',
      project: c.project || '',
      messages: c.messages,
      profile: c.profile,
      cardIds: c.cardIds,
      totalTokens: { input: 0, output: 0 }
    })
  });
  await refreshConvList();
  await openConversation(conv.id);
}

// ---------- Profile panel ----------
function loadProfileToPanel() {
  const p = current?.profile || {};
  $('pSystemPrompt').value = p.systemPrompt || '';
  $('pWorldMemo').value = p.worldMemo || '';
  $('pPlot').value = p.plot || '';
  $('pStylePreset').value = p.stylePreset || '';
  // ソース参照プロジェクト選択肢を構築（allSourcesは非同期ロード済みのはず）
  const psel = $('pSourceProject');
  const names = [...new Set(allSources.map(s => s.project || '').filter(Boolean))].sort();
  psel.innerHTML = '<option value="">（参照しない）</option><option value="__all">すべてのソース</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  const want = p.sourceProject || (p.useSources ? '__all' : '');
  if (want && want !== '__all' && !names.includes(want)) psel.add(new Option(want, want));
  psel.value = want;
  // プロジェクト所属選択（会話の project フィールド）
  const pproj = $('pProject');
  const pnames = projectNamesAll();
  const curProj = current?.project || '';
  pproj.innerHTML = '<option value="">（なし）</option>' +
    pnames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__new">＋新しいプロジェクト…</option>';
  if (curProj && !pnames.includes(curProj)) pproj.add(new Option(curProj, curProj));
  pproj.value = curProj;
  updatePresetStatus();
}
export { loadProfileToPanel };
export async function saveProfile() {
  if (!current) return;
  let proj = $('pProject').value;
  if (proj === '__new') {
    const n = await appPrompt('プロジェクト名を入力', '');
    proj = (n || '').trim();
    if (!proj) { $('pProject').value = current.project || ''; return; }
  }
  current.project = proj;
  current.profile = {
    ...(current.profile || {}),
    systemPrompt: $('pSystemPrompt').value,
    worldMemo: $('pWorldMemo').value,
    plot: $('pPlot').value,
    stylePreset: $('pStylePreset').value,
    sourceProject: $('pSourceProject').value
  };
  saveConversation().then(() => {
    $('profileSaved').textContent = '保存しました';
    setTimeout(() => $('profileSaved').textContent = '', 2000);
  });
}

// ---------- Search ----------
let searchTimer = null;
export function onSearchInput() {
  clearTimeout(searchTimer);
  const q = searchBox.value.trim();
  renderConvList(); // タイトル部分一致で即時フィルタ
  if (!q) { searchResultsEl.classList.add('hidden'); return; }
  searchTimer = setTimeout(async () => {
    const results = await api('/api/search?q=' + encodeURIComponent(q));
    searchResultsEl.innerHTML = '';
    if (!results.length) {
      searchResultsEl.innerHTML = '<div class="search-item hint">本文中の一致なし</div>';
    }
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'search-item';
      div.innerHTML = `<strong></strong> <span class="hint">${r.matchType === 'title' ? 'タイトル' : esc(r.snippet)}</span>`;
      div.querySelector('strong').textContent = r.title;
      div.onclick = async () => {
        searchBox.value = '';
        await openConversation(r.id);
      };
      searchResultsEl.appendChild(div);
    }
    searchResultsEl.classList.remove('hidden');
  }, 300);
}

// ---------- 起動時のタブ復元 ----------
export async function restoreTabs() {
  let restored = false;
  try {
    const savedTabs = JSON.parse(localStorage.getItem('open_tabs') || '[]');
    const savedActive = localStorage.getItem('active_tab') || '';
    const parsed = savedTabs.map(x =>
      (typeof x === 'string' && x.startsWith('d:'))
        ? { type: 'doc', id: x.slice(2) }
        : { type: 'conv', id: x });
    const valid = parsed.filter(t => t.type === 'doc' || conversations.some(c => c.id === t.id));
    if (valid.length) {
      tabs = valid;
      const active = valid.find(t => tabKey(t) === savedActive) || valid[0];
      activeTabType = active.type; activeTabId = active.id;
      saveTabs();
      await openTabEntry(active);
      restored = true;
    }
  } catch {}
  if (!restored) {
    if (conversations.length) await openConversation(conversations[0].id);
    else await newConversation();
  }
}
