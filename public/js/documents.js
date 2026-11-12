// ---------- Documents（リッチテキストエディタのドキュメント） ----------
import { $, convTitleEl } from './dom.js';
import { api, esc, appAlert, appConfirm, appPrompt, fmtDate, downloadFile, icon, showResultModal } from './util.js';
import { allDocs, setAllDocs, allCards } from './state.js';
import { activateTab, registerTabOpener, renderTabs, projectNamesAll, showDocView, closeTab, queueDraftSave, activeTabType } from './conversations.js';
import { callApiOnce } from './context.js';
import { runDocLint } from './lint.js';

let currentDoc = null;   // {id,title,project,content,updated,...}
let editor = null;       // TipTap Editor
let loading = false;     // setContent中は保存を発火させない
let saveTimer = null;
let openSeq = 0;         // openDocumentの順序ガード（古いGET応答の上書き防止）

// lint.js がドキュメント本文を拾えるように公開（原稿シーンが無い時のフォールバック）
window.__docText = () => {
  const pane = $('docPane');
  if (!editor || !currentDoc || !pane || pane.classList.contains('hidden')) return '';
  return editor.getText();
};

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
  const seq = ++openSeq;
  // 前ドキュメントの未保存分を先にフラッシュ（切替で編集が消えるのを防ぐ）
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await saveDocNow(); }
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
  if (seq !== openSeq) return; // より新しいopenに追い越された
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

// 検索結果からのジャンプ用
window.__openDocument = (id) => openDocument(id);

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
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } // 削除後の保存発火を防ぐ
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
    placeholder: 'ここに本文を書きます…（カード名は自動補完・Tabで確定）',
    getNames: () => allCards.map(c => c.name).filter(Boolean),
    onSuggest: (name, rest) => {
      const el = $('docSuggest');
      if (!el) return;
      el.textContent = rest ? `Tabで補完: ${name}` : '';
      el.title = rest || '';
    },
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
  const docId = currentDoc.id; // PUT中に別ドキュメントへ切り替わっても混入しないよう固定
  const body = {
    title: ($('docTitle').value || '').trim() || '無題',
    project: $('docProject').value === '__new' ? '' : $('docProject').value,
    content: editor.getHTML()
  };
  try {
    const d = await api('/api/documents/' + docId, { method: 'PUT', body: JSON.stringify(body) });
    if (currentDoc?.id !== docId) return; // 切替後の古い応答は無視
    currentDoc = { ...currentDoc, ...d };
    convTitleEl.textContent = d.title || '無題';
    updateDocStatus(`保存済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} · ${(editor.getText().length).toLocaleString()}字`);
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
    case 'ruby': {
      const prev = editor.getAttributes('ruby').reading || '';
      const reading = await appPrompt('ルビ（読み）を入力（空欄で解除）', prev);
      if (reading === null) break;
      const r = reading.trim();
      if (!r) chain.extendMarkRange('ruby').unsetRuby().run();
      else chain.extendMarkRange('ruby').setRuby({ reading: r }).run();
      break;
    }
    case 'emphasisDots': chain.toggleEmphasisDots().run(); break;
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
  ['link', 'link'],
  ['ruby', 'ruby'], ['emphasisDots', 'emphasisDots']
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

// ---------- AI連携 ----------
async function aiContinueDoc() {
  if (!currentDoc || !editor) return;
  const text = editor.getText().trim();
  if (text.length < 30) { appAlert('先に本文を30字以上入力してください'); return; }
  const btn = $('btnDocContinue');
  if (btn) btn.disabled = true;
  updateDocStatus('AIが続きを生成中…');
  try {
    const { text: out } = await callApiOnce([
      { role: 'system', content: 'あなたは小説家です。与えられた本文の直後に自然に続く文章だけを執筆してください。出力は本文のみ。説明・前置き・Markdown装飾・かぎ括弧の追加は不要です。文体・視点・トーン・一人称/三人称を本文に合わせてください。' },
      { role: 'user', content: text.slice(-3000) }
    ]);
    const add = (out || '').trim();
    if (!add) { updateDocStatus('生成結果が空でした'); return; }
    const paras = add.split(/\n{2,}/)
      .map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
      .join('');
    const endPos = editor.state.doc.content.size;
    editor.chain().focus().setTextSelection(endPos).insertContent('<p></p>').insertContent(paras).run();
    updateDocStatus('AIの続きを末尾に追加しました（Ctrl+Zで取り消し可）');
  } catch (e) {
    updateDocStatus('生成失敗: ' + (e.message || e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function docConsistencyCheck() {
  if (!currentDoc || !editor) return;
  const text = editor.getText().trim();
  if (text.length < 100) { appAlert('本文が短すぎます（100字以上必要です）'); return; }
  const cardText = allCards
    .filter(c => c.content)
    .map(c => `【${c.name}】（${c.kind || 'term'}）\n${(c.content || '').slice(0, 1500)}`)
    .join('\n\n')
    .slice(0, 24000);
  if (!cardText) { appAlert('カードがありません。カード管理で設定を登録するとチェックできます'); return; }
  showResultModal('整合性チェック', '<p class="hint">AIがカード設定と本文を照合中…</p>');
  try {
    const { text: out } = await callApiOnce([
      { role: 'system', content: 'あなたは小説の編集者です。設定カードと本文を照合し、矛盾・設定違反・不整合を指摘してください。指摘は箇条書きで「深刻度|箇所|問題点|修正案」の形式。問題がなければ「矛盾は見つかりませんでした」とだけ答えてください。' },
      { role: 'user', content: `【設定カード】\n${cardText}\n\n【本文（末尾側を重点的に）】\n${text.slice(-12000)}` }
    ]);
    showResultModal('整合性チェック結果', `<div class="history-content" style="white-space:pre-wrap;line-height:1.8">${esc(out || '（応答なし）')}</div>`);
  } catch (e) {
    showResultModal('整合性チェック', `<p class="hint">失敗: ${esc(e.message || e)}</p>`);
  }
}

// ---------- 目次（見出し一覧→クリックでスクロール） ----------
function docToc() {
  if (!editor) return;
  const heads = [...document.querySelectorAll('#docEditor .ProseMirror h1, #docEditor .ProseMirror h2, #docEditor .ProseMirror h3')];
  if (!heads.length) { appAlert('見出し（H1〜H3）がありません'); return; }
  let html = '<div class="doc-toc">';
  heads.forEach((h, i) => {
    const lv = +h.tagName[1];
    html += `<div class="toc-h${lv}" data-i="${i}">${esc(h.textContent) || '（空の見出し）'}</div>`;
  });
  html += '</div>';
  showResultModal('目次（' + heads.length + '件）', html);
  $('resultBody').querySelectorAll('.toc-h1, .toc-h2, .toc-h3').forEach(el => {
    el.onclick = () => {
      const h = heads[+el.dataset.i];
      if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('resultModal').classList.add('hidden');
    };
  });
}

// ---------- AI出力をドキュメントに送る ----------
export async function sendTextToDocument(text) {
  const t = (text || '').trim();
  if (!t) return;
  const name = await appPrompt('送信先ドキュメント名（既存名なら末尾に追記・空欄で「AI出力」）', '');
  if (name === null) return;
  const title = name.trim() || 'AI出力';
  const paras = t.split(/\n{2,}/)
    .map(p => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
    .join('');
  let doc = allDocs.find(d => (d.title || '無題') === title);
  if (!doc) {
    doc = await api('/api/documents', { method: 'POST', body: JSON.stringify({ title, content: '' }) });
    await refreshDocuments();
  }
  let prev, fullTitle = title, fullProject = '';
  if (currentDoc && currentDoc.id === doc.id) {
    // 開いているドキュメント自身：未保存分をフラッシュしてエディタの最新HTMLを使う
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await saveDocNow(); }
    prev = editor ? editor.getHTML() : (currentDoc.content || '');
    fullTitle = ($('docTitle').value || '').trim() || title;
    fullProject = $('docProject').value === '__new' ? '' : $('docProject').value;
  } else {
    const full = await api('/api/documents/' + doc.id);
    prev = full.content || '';
    fullTitle = full.title || title;
    fullProject = full.project || '';
  }
  const content = prev + (prev ? '<p></p>' : '') + paras;
  await api('/api/documents/' + doc.id, {
    method: 'PUT',
    body: JSON.stringify({ title: fullTitle, project: fullProject, content })
  });
  await refreshDocuments();
  await openDocument(doc.id);
  updateDocStatus(`「${full.title || title}」に追加しました`);
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
  $('btnDocContinue') && ($('btnDocContinue').onclick = aiContinueDoc);
  $('btnDocCheck') && ($('btnDocCheck').onclick = docConsistencyCheck);
  $('btnDocLint') && ($('btnDocLint').onclick = runDocLint);
  $('btnDocToc') && ($('btnDocToc').onclick = docToc);
  // Ctrl/Cmd+S: 表示中ドキュメントを即時保存（デバウンス待ちを flush）
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
    if (!currentDoc || $('docPane')?.classList.contains('hidden')) return;
    e.preventDefault();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveDocNow();
  });
}

registerTabOpener('doc', openDocument);
