// ---------- Documents（リッチテキストエディタのドキュメント） ----------
import { $, convTitleEl } from './dom.js';
import { api, esc, appAlert, appConfirm, appPrompt, fmtDate, downloadFile, icon } from './util.js';
import { allDocs, setAllDocs } from './state.js';
import { activateTab, registerTabOpener, renderTabs, projectNamesAll, showDocView, closeTab, queueDraftSave, activeTabType } from './conversations.js';

let currentDoc = null;   // {id,title,project,content,updated,...}
let editor = null;       // TipTap Editor
let loading = false;     // setContent中は保存を発火させない
let saveTimer = null;

export async function refreshDocuments() {
  setAllDocs(await api('/api/documents'));
  renderDocList();
  renderTabs();
}

function docProjectNames() {
  const set = new Set(projectNamesAll());
  for (const d of allDocs) if (d.project) set.add(d.project);
  return [...set].sort();
}
function fillDocProjectSelect(sel, current) {
  const names = docProjectNames();
  sel.innerHTML = '<option value="">（プロジェクトなし）</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__new">＋新しいプロジェクト…</option>';
  if (current && current !== '__new' && !names.includes(current)) sel.add(new Option(current, current));
  sel.value = current || '';
}

// ---------- サイドバーのドキュメント一覧 ----------
function renderDocList() {
  const el = $('docList');
  if (!el) return;
  el.innerHTML = '';
  if (!allDocs.length) {
    el.innerHTML = '<div class="doc-empty hint">ドキュメントはまだありません</div>';
    return;
  }
  for (const d of docsSorted()) {
    const div = document.createElement('div');
    div.className = 'conv-item doc-item' + (currentDoc && d.id === currentDoc.id && activeTabType === 'doc' ? ' active' : '');
    div.innerHTML = `<div class="title"></div><div class="meta"></div>`;
    div.querySelector('.title').textContent = d.title || '無題';
    div.querySelector('.meta').textContent = `${d.project ? '📁' + d.project + ' · ' : ''}${fmtDate(d.updated)}`;
    const del = document.createElement('span');
    del.className = 'del';
    del.innerHTML = icon('close');
    del.title = '削除';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!(await appConfirm(`「${d.title || '無題'}」を削除しますか？`))) return;
      await api('/api/documents/' + d.id, { method: 'DELETE' });
      closeTab({ type: 'doc', id: d.id });
      if (currentDoc && currentDoc.id === d.id) currentDoc = null;
      await refreshDocuments();
    };
    div.appendChild(del);
    div.onclick = () => openDocument(d.id);
    el.appendChild(div);
  }
}
function docsSorted() {
  return [...allDocs].sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

// ---------- ドキュメントをタブで開く ----------
export async function openDocument(id) {
  queueDraftSave(); // 切り替え前の会話の下書きを保存
  clearTimeout(saveTimer); // 前ドキュメントの保存予約を破棄（誤上書き防止）
  activateTab('doc', id);
  let doc;
  try {
    doc = await api('/api/documents/' + id);
  } catch {
    appAlert('ドキュメントが見つかりません（削除された可能性があります）');
    closeTab({ type: 'doc', id });
    await refreshDocuments();
    return;
  }
  currentDoc = doc;
  showDocView();
  document.body.classList.remove('sidebar-open');
  convTitleEl.textContent = doc.title || '無題';
  $('docTitle').value = doc.title || '';
  fillDocProjectSelect($('docProject'), doc.project || '');
  ensureEditor();
  loading = true;
  try {
    editor.commands.setContent(doc.content || '', false);
  } finally {
    loading = false;
  }
  updateDocStatus('');
  updateToolbarState();
  renderDocList();
}

export async function newDocument() {
  const name = await appPrompt('ドキュメント名を入力（空欄で「無題」）', '');
  const title = (name || '').trim() || '無題';
  const d = await api('/api/documents', {
    method: 'POST',
    body: JSON.stringify({ title, content: '' })
  });
  await refreshDocuments();
  await openDocument(d.id);
  $('docEditor .ProseMirror')?.focus();
}

export async function deleteCurrentDocument() {
  if (!currentDoc) return;
  if (!(await appConfirm(`「${currentDoc.title || '無題'}」を削除しますか？`))) return;
  await api('/api/documents/' + currentDoc.id, { method: 'DELETE' });
  const id = currentDoc.id;
  currentDoc = null;
  closeTab({ type: 'doc', id });
  await refreshDocuments();
}

// ---------- TipTap エディタ ----------
function ensureEditor() {
  if (editor) return;
  editor = window.DocEditor.create($('docEditor'), {
    placeholder: 'ここに本文を書きます…',
    onUpdate: () => {
      if (loading) return;
      scheduleDocSave();
      updateDocStatus('編集中…');
    }
  });
  editor.on('transaction', updateToolbarState);
}

function updateDocStatus(msg) {
  const el = $('docStatus');
  if (!el) return;
  if (msg) { el.textContent = msg; return; }
  el.textContent = currentDoc ? `更新 ${fmtDate(currentDoc.updated)}` : '';
}

function scheduleDocSave() {
  if (!currentDoc) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDocNow, 800);
}
async function saveDocNow() {
  if (!currentDoc || !editor) return;
  const body = {
    title: ($('docTitle').value || '').trim() || '無題',
    project: $('docProject').value === '__new' ? '' : $('docProject').value,
    content: editor.getHTML()
  };
  try {
    const d = await api('/api/documents/' + currentDoc.id, { method: 'PUT', body: JSON.stringify(body) });
    currentDoc = { ...currentDoc, ...d };
    convTitleEl.textContent = d.title || '無題';
    updateDocStatus(`保存済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`);
    renderDocList();
    renderTabs();
  } catch (e) {
    updateDocStatus('保存失敗: ' + e.message);
  }
}

async function ensureProjectName(sel) {
  if (sel.value !== '__new') return sel.value;
  const name = await appPrompt('プロジェクト名を入力', '');
  if (!name || !name.trim()) { sel.value = ''; return ''; }
  const n = name.trim();
  fillDocProjectSelect(sel, n);
  return n;
}

// ---------- ツールバー ----------
async function execDocCmd(cmd) {
  if (!editor) return;
  const chain = editor.chain().focus();
  switch (cmd) {
    case 'bold': chain.toggleBold().run(); break;
    case 'italic': chain.toggleItalic().run(); break;
    case 'underline': chain.toggleUnderline().run(); break;
    case 'strike': chain.toggleStrike().run(); break;
    case 'heading1': chain.toggleHeading({ level: 1 }).run(); break;
    case 'heading2': chain.toggleHeading({ level: 2 }).run(); break;
    case 'heading3': chain.toggleHeading({ level: 3 }).run(); break;
    case 'paragraph': chain.setParagraph().run(); break;
    case 'bulletList': chain.toggleBulletList().run(); break;
    case 'orderedList': chain.toggleOrderedList().run(); break;
    case 'blockquote': chain.toggleBlockquote().run(); break;
    case 'codeBlock': chain.toggleCodeBlock().run(); break;
    case 'horizontalRule': chain.setHorizontalRule().run(); break;
    case 'link': {
      const prev = editor.getAttributes('link').href;
      const url = await appPrompt('リンクURLを入力（空欄で解除）', prev || 'https://');
      if (url === null) break;
      if (!url.trim()) { chain.extendMarkRange('link').unsetLink().run(); break; }
      chain.extendMarkRange('link').setLink({ href: url.trim() }).run();
      break;
    }
    case 'unlink': chain.extendMarkRange('link').unsetLink().run(); break;
    case 'undo': chain.undo().run(); break;
    case 'redo': chain.redo().run(); break;
  }
  updateToolbarState();
}

const TB_STATE = [
  ['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strike', 'strike'],
  ['heading1', 'heading', 1], ['heading2', 'heading', 2], ['heading3', 'heading', 3],
  ['paragraph', 'paragraph'],
  ['bulletList', 'bulletList'], ['orderedList', 'orderedList'],
  ['blockquote', 'blockquote'], ['codeBlock', 'codeBlock'],
  ['link', 'link']
];
function updateToolbarState() {
  if (!editor) return;
  document.querySelectorAll('#docToolbar [data-cmd]').forEach(btn => {
    const cmd = btn.dataset.cmd;
    let active = false;
    for (const [c, mark, level] of TB_STATE) {
      if (c !== cmd) continue;
      if (mark === 'heading') active = editor.isActive('heading', { level });
      else if (mark === 'paragraph') active = editor.isActive('paragraph');
      else active = editor.isActive(mark);
    }
    btn.classList.toggle('active', active);
  });
}

function exportCurrentDocument() {
  if (!currentDoc || !editor) return;
  const title = ($('docTitle').value || '').trim() || currentDoc.title || '無題';
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>${esc(title)}</title></head><body>${editor.getHTML()}</body></html>`;
  downloadFile(title + '.html', html, 'text/html');
}

// ---------- 初期化（app.jsのbindUIから呼ぶ） ----------
export function initDocEditor() {
  document.querySelectorAll('#docToolbar [data-cmd]').forEach(btn => {
    // mousedownでpreventDefaultし、クリック時にエディタの選択範囲を維持する
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => execDocCmd(btn.dataset.cmd));
  });
  $('docTitle').addEventListener('input', () => {
    if (!currentDoc) return;
    currentDoc.title = $('docTitle').value;
    convTitleEl.textContent = currentDoc.title || '無題';
    scheduleDocSave();
    renderDocList();
    renderTabs();
  });
  $('docProject').addEventListener('change', async () => {
    if (!currentDoc) return;
    currentDoc.project = await ensureProjectName($('docProject'));
    scheduleDocSave();
    renderDocList();
  });
  $('btnNewDoc').onclick = newDocument;
  $('btnDocDelete').onclick = deleteCurrentDocument;
  $('btnDocExport').onclick = exportCurrentDocument;
}

registerTabOpener('doc', openDocument);
