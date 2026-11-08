/* AI Novelist Studio - frontend */
'use strict';

const $ = (id) => document.getElementById(id);
const chatEl = $('chat'), inputEl = $('input'), sendBtn = $('btnSend'), stopBtn = $('btnStop');
const convListEl = $('convList'), convTitleEl = $('convTitle'), tokenBadgeEl = $('tokenBadge');
const searchBox = $('convSearch'), searchResultsEl = $('searchResults');

const STYLE_PRESETS = {
  '': '',
  'normal': 'ノーマルな小説文で、自然で読みやすい日本語を心がけてください。',
  'ranobe': 'ライトノベル風の軽快でテンポの良い文体で書いてください。',
  'jidaigeki': '時代劇・歴史小説のような格式高い文体で書いてください。',
  'horror': 'ホラー・ミステリー小説のように、緊張感と陰影のある文体で書いてください。',
  'bungei': '文芸小説のように詩的で装飾的な文体で書いてください。'
};
const CARD_KINDS = { character: 'キャラ', world: '世界観', term: '用語', foreshadow: '伏線' };
function icon(name) {
  return `<svg class="icon"><use href="#i-${name}"/></svg>`;
}
// 価格目安（AIのべりすと API: 1000tokあたり 0.275/2.25ルミナ ≈ ¥0.33/¥2.79）
const PRICE_IN_PER_TOKEN = 0.00033, PRICE_OUT_PER_TOKEN = 0.00279;

// ---------- カスタムダイアログ（Electronは prompt/confirm/alert 非対応） ----------
function appDialog(message, { input = false, defValue = '', okText = 'OK' } = {}) {
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
const appAlert = (m) => appDialog(m, { okText: 'OK' }).then(() => {});
const appConfirm = (m) => appDialog(m).then((v) => v === true);
const appPrompt = (m, def = '') => appDialog(m, { input: true, defValue: def });

let config = null;
let conversations = [];
let allCards = [];
let allTemplates = [];
let cardsVersion = 0; // カード変更検知用（effectiveCardIdsキャッシュの無効化）
let current = null;
let tabs = [];        // [{id}] 開いているタブ
let activeTabId = null;
let abortCtrl = null;
let busy = false;
let searchTimer = null;

// お楽しみ機能・細かい設定（localStorage）
const fun = {
  neko: localStorage.getItem('fun_neko') === '1',
  sakura: localStorage.getItem('fun_sakura') === '1',
  infinite: false,
  infiniteCount: 0,
  mood: localStorage.getItem('fun_mood') || '機嫌がいい',
  theme: localStorage.getItem('ui_theme') || 'auto',
  aiName: localStorage.getItem('fun_ainame') || '',
  ears: localStorage.getItem('fun_ears') === '1',
  bgm: false,
  writingMode: localStorage.getItem('fun_writingmode') === '1'
};
let pendingSummary = false;
let timerState = { running: false, elapsed: 0, startedAt: 0, timerId: null };
const saveFun = (k) => localStorage.setItem('fun_' + k, fun[k] ? '1' : '0');
localStorage.setItem('fun_mood', fun.mood);

// 猫化変換
function nekoifyInput(t) {
  return t.replace(/[。！？!?.\s]*$/, (s) => 'にゃ' + (s.includes('。') || s.includes('！') || s.includes('？') ? s : '。'));
}
function nekoifyOutput(t) {
  return t.replace(/。/g, 'にゃ。');
}

// ---------- API helpers ----------
async function api(path, opts = {}) {
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

// ---------- Manuscript（原稿ペイン） ----------
let manuscript = { title: '無題', chapters: [] };
let msSel = { chapterId: null, sceneId: null };
let msSaveTimer = null;
const msUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function loadManuscript() {
  try { manuscript = await api('/api/manuscript'); }
  catch { manuscript = { title: '無題', chapters: [] }; }
  if (!Array.isArray(manuscript.chapters)) manuscript.chapters = [];
  msSel.chapterId = manuscript.chapters[0]?.id || null;
  msSel.sceneId = manuscript.chapters[0]?.scenes[0]?.id || null;
  renderMsTree();
  updateMsEditor();
}
function scheduleMsSave() {
  clearTimeout(msSaveTimer);
  msSaveTimer = setTimeout(() => {
    api('/api/manuscript', { method: 'PUT', body: JSON.stringify(manuscript) }).catch(() => {});
  }, 600);
}
function msChapter() { return manuscript.chapters.find(c => c.id === msSel.chapterId); }
function msScene() {
  const ch = msChapter();
  return ch ? ch.scenes.find(s => s.id === msSel.sceneId) : null;
}
function renderMsTree() {
  const el = $('msTree');
  if (!el) return;
  el.innerHTML = '';
  if (!manuscript.chapters.length) {
    el.innerHTML = '<p class="hint" style="padding:8px">まだ章がありません。「＋章」で作成するか、AI応答の「原稿」ボタンで自動作成できます。</p>';
    return;
  }
  for (const ch of manuscript.chapters) {
    const chEl = document.createElement('div');
    chEl.className = 'ms-ch' + (ch.id === msSel.chapterId ? ' sel' : '');
    chEl.textContent = ch.title;
    chEl.onclick = () => {
      msSel.chapterId = ch.id;
      msSel.sceneId = ch.scenes[0]?.id || null;
      renderMsTree(); updateMsEditor();
    };
    el.appendChild(chEl);
    for (const sc of ch.scenes) {
      const scEl = document.createElement('div');
      scEl.className = 'ms-sc' + (sc.id === msSel.sceneId ? ' sel' : '');
      const cnt = document.createElement('span');
      cnt.className = 'ms-count';
      cnt.textContent = sc.content ? `${sc.content.length}字` : '';
      scEl.appendChild(document.createTextNode(sc.title));
      scEl.appendChild(cnt);
      scEl.onclick = () => { msSel.chapterId = ch.id; msSel.sceneId = sc.id; renderMsTree(); updateMsEditor(); };
      el.appendChild(scEl);
    }
  }
}
function updateMsEditor() {
  const sc = msScene();
  $('msSceneTitle').value = sc ? sc.title : '';
  $('msEditor').value = sc ? sc.content : '';
}
function toggleManuscriptPane() {
  $('manuscriptPane').classList.toggle('hidden');
}
function adoptToManuscript(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (!manuscript.chapters.length) {
    manuscript.chapters.push({ id: msUid(), title: '第1章', scenes: [] });
  }
  let ch = msChapter() || manuscript.chapters[0];
  msSel.chapterId = ch.id;
  if (!ch.scenes.length || !ch.scenes.some(s => s.id === msSel.sceneId)) {
    const sc = { id: msUid(), title: `シーン${ch.scenes.length + 1}`, content: '' };
    ch.scenes.push(sc);
    msSel.sceneId = sc.id;
  }
  const sc = msScene();
  sc.content = (sc.content ? sc.content.replace(/\s+$/, '') + '\n\n' : '') + t;
  renderMsTree();
  updateMsEditor();
  scheduleMsSave();
  $('manuscriptPane').classList.remove('hidden');
  $('msStatus').textContent = `「${sc.title}」に追加しました`;
  setTimeout(() => { if ($('msStatus').textContent.startsWith('「')) $('msStatus').textContent = ''; }, 2500);
}
async function msAddChapter() {
  const n = manuscript.chapters.length + 1;
  const title = await appPrompt('章名を入力', `第${n}章`);
  if (title === null) return;
  const ch = { id: msUid(), title: title.trim() || `第${n}章`, scenes: [{ id: msUid(), title: 'シーン1', content: '' }] };
  manuscript.chapters.push(ch);
  msSel.chapterId = ch.id; msSel.sceneId = ch.scenes[0].id;
  renderMsTree(); updateMsEditor(); scheduleMsSave();
}
async function msAddScene() {
  let ch = msChapter() || manuscript.chapters[0];
  if (!ch) return msAddChapter();
  msSel.chapterId = ch.id;
  const sc = { id: msUid(), title: `シーン${ch.scenes.length + 1}`, content: '' };
  ch.scenes.push(sc);
  msSel.sceneId = sc.id;
  renderMsTree(); updateMsEditor(); scheduleMsSave();
}
async function msDelete() {
  const sc = msScene();
  const ch = msChapter();
  if (sc) {
    if (!(await appConfirm(`シーン「${sc.title}」を削除しますか？`))) return;
    ch.scenes = ch.scenes.filter(s => s.id !== sc.id);
    msSel.sceneId = ch.scenes[0]?.id || null;
  } else if (ch) {
    if (!(await appConfirm(`章「${ch.title}」を削除しますか？`))) return;
    manuscript.chapters = manuscript.chapters.filter(c => c.id !== ch.id);
    msSel.chapterId = manuscript.chapters[0]?.id || null;
    msSel.sceneId = msChapter()?.scenes[0]?.id || null;
  } else return;
  renderMsTree(); updateMsEditor(); scheduleMsSave();
}
function exportManuscript() {
  let out = '';
  for (const ch of manuscript.chapters) {
    out += `\n\n【${ch.title}】\n\n`;
    for (const sc of ch.scenes) out += `〔${sc.title}〕\n\n${sc.content}\n\n`;
  }
  if (!out.trim()) { appAlert('原稿がまだありません'); return; }
  downloadFile((manuscript.title || 'manuscript') + '.txt', out.trim(), 'text/plain');
}

// ---------- プロンプト最適化 ----------
async function optimizePrompt() {
  const draft = inputEl.value.trim();
  if (!draft) { appAlert('先に指示文を入力してください'); return; }
  if (apiWarnMissing()) return;
  const btn = $('btnOptimizePrompt');
  btn.disabled = true;
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説生成AIへの指示文を改善するアシスタントです。ユーザーの指示を、AIが最高の結果を出すための具体的で明確な指示文に書き換えてください。出力は改善後の指示文のみとし、説明・前置き・引用符・箇条書き記号は付けないでください。' },
      { role: 'user', content: draft }
    ]);
    const opt = (text || '').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!opt) throw new Error('最適化結果が空でした');
    const use = await appDialog(`最適化された指示文:\n\n${opt.slice(0, 1000)}${opt.length > 1000 ? '…' : ''}`, { okText: '入力欄に反映' });
    if (use === true) {
      inputEl.value = opt;
      inputEl.dispatchEvent(new Event('input'));
      inputEl.focus();
    }
  } catch (e) {
    appAlert('最適化に失敗しました: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

// ---------- Init ----------
async function init() {
  config = await api('/api/config');
  allCards = await api('/api/cards');
  allTemplates = await api('/api/templates');
  loadManuscript();
  refreshSources();
  await refreshConvList();
  // 前回開いていたタブを復元
  let restored = false;
  try {
    const savedTabs = JSON.parse(localStorage.getItem('open_tabs') || '[]');
    const savedActive = localStorage.getItem('active_tab') || '';
    const valid = savedTabs.filter(id => conversations.some(c => c.id === id));
    if (valid.length) {
      tabs = valid.map(id => ({ id }));
      activeTabId = valid.includes(savedActive) ? savedActive : valid[0];
      saveTabs();
      await loadConv(activeTabId);
      renderTabs();
      restored = true;
    }
  } catch {}
  if (!restored) {
    if (conversations.length) await openConversation(conversations[0].id);
    else await newConversation();
  }
  bindUI();
}

// ---------- Conversations ----------
async function refreshConvList() {
  conversations = await api('/api/conversations');
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
function clearConvSelection() {
  selectedConvs.clear(); lastSelIndex = -1;
  convListEl.querySelectorAll('.conv-item.selected').forEach(el => el.classList.remove('selected'));
  updateSelUI();
}
async function deleteSelectedConvs() {
  const ids = [...selectedConvs];
  if (!ids.length) return;
  if (!(await appConfirm(`${ids.length}件の会話を削除しますか？この操作は元に戻せません`))) return;
  for (const id of ids) {
    try { await api('/api/conversations/' + id, { method: 'DELETE' }); } catch {}
  }
  tabs = tabs.filter(t => !ids.includes(t.id));
  clearConvSelection();
  if (current && ids.includes(current.id)) {
    activeTabId = null; current = null; clearChat();
    const rest = conversations.filter(c => !ids.includes(c.id));
    const nextId = tabs.length ? tabs[tabs.length - 1].id : rest[0]?.id;
    if (nextId) await openConversation(nextId);
    else showEmptyChat();
  } else {
    saveTabs(); renderTabs();
  }
  await refreshConvList();
}
function showEmptyChat() {
  convTitleEl.textContent = '会話を選択';
  chatEl.innerHTML = '<div class="msg bot" style="align-self:center;color:var(--text-dim)">タブがありません。サイドバーか「＋」から会話を開いてください</div>';
  loadProfileToPanel();
  updateTokenBadge();
  updateCharCount();
}

function renderConvList() {
  const q = searchBox.value.trim().toLowerCase();
  convListEl.innerHTML = '';
  searchResultsEl.classList.add('hidden');
  visibleConvs = conversations.filter(c => !q || (c.title || '').toLowerCase().includes(q));
  visibleConvs.forEach((c, idx) => {
    const div = document.createElement('div');
    div.className = 'conv-item' + (current && c.id === current.id ? ' active' : '') + (selectedConvs.has(c.id) ? ' selected' : '');
    div.innerHTML = `<div class="title"></div><div class="meta"></div>`;
    div.querySelector('.title').textContent = c.title;
    div.querySelector('.meta').textContent = `${c.messageCount} msgs · ${fmtDate(c.updated)}`;
    const del = document.createElement('span');
    del.className = 'del';
    del.innerHTML = icon('close');
    del.title = '削除';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!(await appConfirm(`「${c.title}」を削除しますか？`))) return;
      await api('/api/conversations/' + c.id, { method: 'DELETE' });
      selectedConvs.delete(c.id);
      const wasActive = current && current.id === c.id;
      tabs = tabs.filter(t => t.id !== c.id); // 開いているタブも閉じる
      if (wasActive) {
        activeTabId = null;
        current = null; clearChat();
        const rest = conversations.filter(x => x.id !== c.id);
        const nextId = tabs.length ? tabs[tabs.length - 1].id : rest[0]?.id;
        if (nextId) await openConversation(nextId);
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
async function renameConversation(c, newTitle) {
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
  localStorage.setItem('open_tabs', JSON.stringify(tabs.map(t => t.id)));
  localStorage.setItem('active_tab', activeTabId || '');
}
function renderTabs() {
  const el = $('tabs');
  if (!el) return;
  el.innerHTML = '';
  for (const t of tabs) {
    const c = conversations.find(x => x.id === t.id);
    const div = document.createElement('div');
    div.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = c?.title || '読み込み中…';
    title.title = c?.title || '';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'タブを閉じる（会話は削除されません）';
    close.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    div.appendChild(title);
    div.appendChild(close);
    div.onclick = () => { if (t.id !== activeTabId) openConversation(t.id); };
    el.appendChild(div);
  }
  const active = el.querySelector('.tab.active');
  if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
async function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (activeTabId === id) {
    saveDraft(); // 閉じるタブの下書きを保存
    activeTabId = null;
    current = null;
    clearChat();
    const next = tabs[Math.min(idx, tabs.length - 1)]?.id;
    if (next) {
      await openConversation(next);
      return;
    }
    // 最後のタブ：新規会話は作らず空の状態にする（会話が増殖するのを防ぐ）
    showEmptyChat();
  }
  saveTabs();
  renderTabs();
}

// ---------- 下書き保存（会話ごとに入力途中のテキストを保持） ----------
const draftKey = () => 'draft_' + (current?.id || '');
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

async function openConversation(id) {
  saveDraft(); // 切り替え前の会話の下書きを保存
  document.body.classList.remove('sidebar-open'); // モバイルのドロワーを閉じる
  if (!tabs.some(t => t.id === id)) tabs.push({ id });
  activeTabId = id;
  saveTabs();
  await loadConv(id);
  renderTabs();
}

async function loadConv(id) {
  current = await api('/api/conversations/' + id);
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
  updateTokenBadge();
  updateCharCount();
  scrollChat(true);
}

async function newConversation() {
  // 名前入力を求める。キャンセル・空欄なら従来通り自動タイトルで作成
  const name = await appPrompt('会話名を入力（空欄またはキャンセルで自動命名）', '');
  const title = (name || '').trim();
  const conv = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(title ? { title } : {})
  });
  await refreshConvList();
  await openConversation(conv.id);
  inputEl.focus();
}

async function saveConversation(conv) {
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
      totalTokens: conv.totalTokens
    })
  });
  await refreshConvList();
}

// ---------- Message rendering ----------
// 画面外メッセージの遅延描画（長い会話でも軽くする）
let msgObserver = null;
function ensureMsgObserver() {
  if (msgObserver) return msgObserver;
  msgObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      msgObserver.unobserve(el);
      const fn = el._lazyRender;
      el._lazyRender = null;
      if (fn) fn();
    }
  }, { root: chatEl, rootMargin: '800px' });
  return msgObserver;
}
function clearChat() {
  if (msgObserver) { msgObserver.disconnect(); msgObserver = null; }
  chatEl.innerHTML = '';
}

function renderMessage(m) {
  if (m.role === 'user') {
    const el = addMsg('user', m.content);
    addUserActions(el, m);
  } else if (m.role === 'assistant') {
    const el = document.createElement('div');
    el.className = 'msg bot';
    const content = document.createElement('div');
    content.className = 'content';
    el.appendChild(content);
    chatEl.appendChild(el);
    el._lazyRender = () => {
      renderBotContent(el, m.content, '');
      addBotActions(el, m);
    };
    ensureMsgObserver().observe(el);
  } else if (m.role === 'scene') {
    addSceneDivider(m);
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = '<div class="content"></div>';
  chatEl.appendChild(div);
  scrollChat();
  return div;
}
function addBotMsg(loading = true) {
  const el = addMsg('bot', '');
  if (loading) {
    el.classList.add('thinking');
    el.querySelector('.content').innerHTML = '<em>生成中…</em>';
  }
  return el;
}
function addSceneDivider(m) {
  const div = document.createElement('div');
  div.className = 'scene-divider' + (m.kind === 'chapter' ? ' chapter' : '');
  div.innerHTML = `<span>${icon('columns')} ${m.kind === 'chapter' ? '章: ' : ''}${esc(m.label || 'シーン')}</span>`;
  const del = document.createElement('button');
  del.className = 'scene-del';
  del.innerHTML = icon('close');
  del.title = 'この区切りを削除';
  del.onclick = () => {
    const idx = current.messages.indexOf(m);
    if (idx >= 0) current.messages.splice(idx, 1);
    div.remove();
    saveConversation();
  };
  div.appendChild(del);
  chatEl.appendChild(div);
  scrollChat();
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
// Markdown→HTML（DOMPurifyでサニタイズ。未読込時は生HTMLにフォールバック）
function mdRender(text) {
  const html = marked.parse(text);
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}
function renderBotContent(el, text, reasoning) {
  const content = el.querySelector('.content');
  let prefix = '';
  if (reasoning) {
    const short = reasoning.length > 800 ? reasoning.slice(0, 800) + '…' : reasoning;
    prefix = `<div class="reasoning-box">${icon('sparkle')} 推論<br>${esc(short)}</div>`;
  }
  let out = text;
  if (fun.neko) out = nekoifyOutput(out);
  try { content.innerHTML = prefix + mdRender(out); }
  catch { content.textContent = out; }
  if (fun.neko && !el.querySelector('.neko-tag')) {
    const tag = document.createElement('span');
    tag.className = 'neko-tag';
    tag.textContent = 'にゃんモード';
    el.querySelector('.content').appendChild(tag);
  }
}

// メッセージ削除（user/assistant共通）
function removeMessage(m, el) {
  if (!current) return;
  const idx = current.messages.indexOf(m);
  if (idx >= 0) current.messages.splice(idx, 1);
  el.remove();
  saveConversation();
  updateCharCount();
}
function addUserActions(el, msgObj) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions user-actions';
  const mk = (label, iconName, fn) => {
    const b = document.createElement('button');
    b.innerHTML = icon(iconName) + ' ' + label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  mk('コピー', 'copy', () => {
    navigator.clipboard.writeText(msgObj.content).then(() => {
      actions.querySelector('button').innerHTML = icon('copy') + ' コピー済';
      setTimeout(() => actions.querySelector('button').innerHTML = icon('copy') + ' コピー', 1500);
    });
  });
  mk('削除', 'close', async () => {
    if (await appConfirm('このメッセージを削除しますか？（以降の会話には影響しません）')) removeMessage(msgObj, el);
  });
  el.appendChild(actions);
}

function addBotActions(el, msgObj, msgIndex) {
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const mk = (label, iconName, fn, title) => {
    const b = document.createElement('button');
    b.innerHTML = icon(iconName) + ' ' + label;
    if (title) b.title = title;
    b.onclick = fn;
    actions.appendChild(b);
  };
  mk('コピー', 'copy', () => {
    navigator.clipboard.writeText(msgObj.content).then(() => {
      actions.querySelector('button').innerHTML = icon('copy') + ' コピー済';
      setTimeout(() => actions.querySelector('button').innerHTML = icon('copy') + ' コピー', 1500);
    });
  });
  mk('再生成', 'refresh', () => regenerate(el), 'この応答を作り直す');
  mk('分岐', 'branch', () => branchFrom(msgObj), 'この応答までの会話をコピーして新しい会話にする');
  mk('指示', 'edit', () => instructFrom(msgObj), 'AIに修正・追加の指示を出す');
  mk('読み上げ', 'volume', () => toggleSpeak(msgObj.content), 'この応答を音声で読み上げ');
  mk('原稿', 'book', () => adoptToManuscript(msgObj.content), 'この応答を原稿ペインに追加');
  if (msgObj._summary) {
    mk('メモに追加', 'card', () => appendToMemo(msgObj.content), 'このあらすじを文脈メモに追加');
  }
  if (msgObj._style) {
    mk('文体として保存', 'card', () => saveStyle(msgObj.content), 'この文体プロファイルをプリセットに保存');
  }
  mk('削除', 'close', async () => {
    if (await appConfirm('この応答を削除しますか？')) removeMessage(msgObj, el);
  });
  el.appendChild(actions);
}

// ---------- Writing support ----------
async function insertSceneDivider() { await insertDivider('scene'); }
async function insertChapterDivider() { await insertDivider('chapter'); }
async function insertDivider(kind) {
  if (!current) return;
  const isChapter = kind === 'chapter';
  const n = current.messages.filter(m => m.role === 'scene' && (m.kind === kind)).length + 1;
  const label = await appPrompt(isChapter ? '章名を入力' : 'シーン名を入力', `${isChapter ? '第' + n + '章' : 'シーン' + n}`);
  if (label === null) return;
  const m = { role: 'scene', kind, label: label || (isChapter ? `第${n}章` : `シーン${n}`), ts: Date.now() };
  current.messages.push(m);
  addSceneDivider(m);
  saveConversation();
}

// スナップショット（版の履歴）を保存
function captureSnapshot(label) {
  if (!current) return;
  current.snapshots = current.snapshots || [];
  // 末尾のassistantメッセージを保存
  for (let i = current.messages.length - 1; i >= 0; i--) {
    const m = current.messages[i];
    if (m.role === 'assistant') {
      current.snapshots.push({ ts: Date.now(), label, content: m.content });
      if (current.snapshots.length > 100) current.snapshots = current.snapshots.slice(-100);
      break;
    }
    if (m.role === 'user') break;
  }
}

// あらすじを文脈メモに追加
function appendToMemo(text) {
  if (!current) return;
  current.profile = current.profile || {};
  const memo = current.profile.worldMemo || '';
  const block = `\n\n【自動生成あらすじ ${new Date().toLocaleString('ja-JP')}】\n${text}`;
  current.profile.worldMemo = (memo + block).slice(0, 19000);
  $('pWorldMemo').value = current.profile.worldMemo;
  saveConversation().then(() => appAlert('文脈メモに追加しました'));
}

async function instructFrom(targetMsg) {
  const instruction = await appPrompt('AIへの指示を入力\n（例: ここをもっと緊張感のある描写にして / 続きを300字書いて）');
  if (!instruction || !instruction.trim()) return;
  captureSnapshot('指示前');
  const content = `【指示】${instruction.trim()}\n\n（対象の応答についての指示です。指示に従って修正・続きを生成してください）`;
  const msgObj = { role: 'user', content };
  current.messages.push(msgObj);
  const uEl = addMsg('user', content);
  addUserActions(uEl, msgObj);
  fun.infiniteCount = 0;
  await runCompletion();
}

// 別案生成（A/B）
async function altVersion() {
  if (!current || busy) return;
  captureSnapshot('別案前');
  // 末尾のassistantを削除して別展開を要求
  for (let i = current.messages.length - 1; i >= 0; i--) {
    const m = current.messages[i];
    if (m.role === 'assistant') { current.messages.splice(i, 1); break; }
    if (m.role === 'user') break;
  }
  const content = '【指示】直前の指示に対して、別の展開・別の文体で書き直してください。これまでとは異なるバージョンをお願いします。';
  const msgObj = { role: 'user', content };
  current.messages.push(msgObj);
  const uEl = addMsg('user', content);
  addUserActions(uEl, msgObj);
  await runCompletion();
}

async function branchFrom(msgObj) {
  if (!current) return;
  const idx = current.messages.indexOf(msgObj);
  if (idx < 0) return;
  const copied = current.messages.slice(0, idx + 1);
  const conv = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({
      title: current.title + '（分岐）',
      messages: copied,
      profile: current.profile,
      cardIds: current.cardIds,
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
}
function saveProfile() {
  if (!current) return;
  current.profile = {
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

// ---------- Cards ----------
async function refreshCards() {
  allCards = await api('/api/cards');
  cardsVersion++;
}
function openCardsModal(editCard = null) {
  refreshCards().then(renderCardList);
  $('cardsModal').classList.remove('hidden');
  if (editCard) fillCardForm(editCard);
  else resetCardForm();
}
function renderCardList() {
  const el = $('cardList');
  el.innerHTML = '';
  if (!allCards.length) {
    el.innerHTML = '<p class="hint">カードがありません。「新しいカード」で作成してください。</p>';
    return;
  }
  for (const c of allCards) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `<span class="card-kind">${CARD_KINDS[c.kind] || c.kind}</span> <strong></strong> ${c.resolved ? '<span class="card-resolved">回収済</span>' : ''} <span class="hint"></span>`;
    div.querySelector('strong').textContent = c.name;
    const tagStr = String(c.tags || '').split(/[,、\s]+/).filter(Boolean).map(t => '#' + t).join(' ');
    const hint = (c.content || '').slice(0, 60).replace(/\n/g, ' ');
    div.querySelector('.hint').textContent = (tagStr ? tagStr + ' ' : '') + (c.triggers ? `⚑${c.triggers} ` : '') + hint;
    div.onclick = () => fillCardForm(c);
    el.appendChild(div);
  }
}
function fillCardForm(c) {
  $('cardEditForm').classList.remove('hidden');
  $('cId').value = c.id;
  $('cName').value = c.name;
  $('cKind').value = c.kind;
  $('cContent').value = c.content;
  $('cTriggers').value = c.triggers || '';
  $('cTags').value = c.tags || '';
  $('cResolved').checked = c.resolved === true;
  $('btnDeleteCard').classList.remove('hidden');
}
function resetCardForm() {
  $('cardEditForm').classList.add('hidden');
  $('cId').value = ''; $('cName').value = ''; $('cContent').value = ''; $('cTriggers').value = ''; $('cTags').value = '';
  $('cResolved').checked = false;
  $('btnDeleteCard').classList.add('hidden');
}
async function saveCard() {
  const id = $('cId').value;
  const body = { name: $('cName').value, kind: $('cKind').value, content: $('cContent').value, resolved: $('cResolved').checked, triggers: $('cTriggers').value, tags: $('cTags').value };
  if (id) await api('/api/cards/' + id, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/cards', { method: 'POST', body: JSON.stringify(body) });
  await refreshCards();
  renderCardList();
  resetCardForm();
}
async function deleteCard() {
  const id = $('cId').value;
  if (!id || !(await appConfirm('このカードを削除しますか？'))) return;
  await api('/api/cards/' + id, { method: 'DELETE' });
  await refreshCards();
  renderCardList();
  resetCardForm();
}

// ---------- Card picker (per conversation) ----------
function openCardPicker() {
  if (!current) return;
  const el = $('cardPickList');
  el.innerHTML = '';
  if (!allCards.length) {
    el.innerHTML = '<p class="hint">カードがありません。先にサイドバーの「カード」で作成してください。</p>';
    return;
  }
  for (const c of allCards) {
    const label = document.createElement('label');
    label.className = 'pick-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = (current.cardIds || []).includes(c.id);
    cb.dataset.id = c.id;
    label.appendChild(cb);
    const tagStr = String(c.tags || '').split(/[,、\s]+/).filter(Boolean).map(t => '#' + t).join(' ');
    label.appendChild(document.createTextNode(` [${CARD_KINDS[c.kind] || c.kind}] ${c.name}${tagStr ? ' ' + tagStr : ''}`));
    el.appendChild(label);
  }
  $('cardPickModal').classList.remove('hidden');
}
function saveCardPick() {
  if (!current) return;
  current.cardIds = [...document.querySelectorAll('#cardPickList input:checked')].map(cb => cb.dataset.id);
  saveConversation().then(() => {
    $('btnCloseCardPick').click();
  });
}
// ---------- Sources（参照資料・プロジェクト別） ----------
let allSources = [];
async function refreshSources() {
  allSources = await api('/api/sources');
}
function sourceProjectNames() {
  return [...new Set(allSources.map(s => s.project || '').filter(Boolean))].sort();
}
function fillSourceProjectSelect(sel, current) {
  const names = sourceProjectNames();
  sel.innerHTML = '<option value="">（プロジェクトなし）</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
    '<option value="__new">＋新しいプロジェクト…</option>';
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
function openSourcesModal(editSource = null) {
  refreshSources().then(() => {
    renderProjectFilter();
    renderSourceList();
  });
  $('sourcesModal').classList.remove('hidden');
  if (editSource) fillSourceForm(editSource);
  else resetSourceForm();
}
function renderSourceList() {
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
function resetSourceForm() {
  $('sourceEditForm').classList.add('hidden');
  $('srcId').value = ''; $('srcName').value = ''; $('srcContent').value = '';
  fillSourceProjectSelect($('srcProject'), '');
  $('btnDeleteSource').classList.add('hidden');
}
async function saveSource() {
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
async function deleteSource() {
  const id = $('srcId').value;
  if (!id || !(await appConfirm('このソースを削除しますか？'))) return;
  await api('/api/sources/' + id, { method: 'DELETE' });
  await refreshSources();
  renderProjectFilter();
  renderSourceList();
  resetSourceForm();
}
function importSourceFile(file) {
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
// ---------- Templates ----------
async function refreshTemplates() {
  allTemplates = await api('/api/templates');
  const sel = $('sTemplate');
  sel.innerHTML = '<option value="">（選択）</option>';
  for (const t of allTemplates) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
}
function openTplModal(editTpl = null) {
  refreshTemplates().then(renderTplList);
  $('tplModal').classList.remove('hidden');
  if (editTpl) {
    $('tplEditForm').classList.remove('hidden');
    $('tId').value = editTpl.id;
    $('tName').value = editTpl.name;
    $('tContent').value = editTpl.content;
    $('btnDeleteTpl').classList.remove('hidden');
  } else resetTplForm();
}
function renderTplList() {
  const el = $('tplList');
  el.innerHTML = '';
  if (!allTemplates.length) {
    el.innerHTML = '<p class="hint">テンプレートがありません。</p>';
    return;
  }
  for (const t of allTemplates) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `<strong></strong> <span class="hint"></span>`;
    div.querySelector('strong').textContent = t.name;
    div.querySelector('.hint').textContent = (t.content || '').slice(0, 60).replace(/\n/g, ' ');
    div.onclick = () => openTplModal(t);
    el.appendChild(div);
  }
}
function resetTplForm() {
  $('tplEditForm').classList.add('hidden');
  $('tId').value = ''; $('tName').value = ''; $('tContent').value = '';
  $('btnDeleteTpl').classList.add('hidden');
}
async function saveTpl() {
  const id = $('tId').value;
  const body = { name: $('tName').value, content: $('tContent').value };
  if (id) await api('/api/templates/' + id, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/templates', { method: 'POST', body: JSON.stringify(body) });
  await refreshTemplates();
  renderTplList();
  resetTplForm();
}
async function deleteTpl() {
  const id = $('tId').value;
  if (!id || !(await appConfirm('このテンプレートを削除しますか？'))) return;
  await api('/api/templates/' + id, { method: 'DELETE' });
  await refreshTemplates();
  renderTplList();
  resetTplForm();
}

// 詳細パラメータ（AIのべりすとAPI全対応）
const ADV_FIELDS = [
  ['sRepPen', 'repPen'], ['sFreqPen', 'freqPen'], ['sPresPen', 'presPen'],
  ['sTopK', 'topK'], ['sTopA', 'topA'], ['sMinP', 'minP'],
  ['sTailfree', 'tailfree'], ['sTypicalP', 'typicalP'],
  ['sSeed', 'seed'], ['sBadwords', 'badwords'], ['sStoptokens', 'stoptokens']
];
const MODEL_INFO = {
  spiko_ultra: '最上位モデル。20万トークンの長文脈と最大の知識量。推奨。',
  spiko_solid: '指示への追従を重視したモード。設定無視が少ない。',
  spiko_max: 'クリエイティブと指示のバランス型。長編向け推奨。',
  spiko: '軽量・高速なスタンダードモデル。',
  derrida_03: '詩的で叙情的な文体が特徴の詩モデル。',
  damsel_ray: '第三世代の生文特化モデル。指示追従・論理は苦手だが人間味のある文章。',
  supertrin_highpres: '高密度プリセット系モデル。',
  supertrin_maxpres: '最高密度プリセット系モデル。'
};
const PROVIDER_URLS = {
  tringpt: 'https://api.tringpt.com/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  custom: ''
};
function detectProvider(baseUrl) {
  const b = (baseUrl || '').replace(/\/+$/, '');
  for (const [k, v] of Object.entries(PROVIDER_URLS)) if (v && b === v) return k;
  return 'custom';
}
function updateModelHint() {
  const m = $('sModel').value;
  $('modelHint').textContent = MODEL_INFO[m] || '';
}
// config.params → API body へのマッピング
const PARAM_MAP = {
  temperature: 'temperature', topP: 'top_p', maxTokens: 'max_tokens',
  repPen: 'repetition_penalty', freqPen: 'frequency_penalty', presPen: 'presence_penalty',
  topK: 'top_k', topA: 'top_a', minP: 'min_p', tailfree: 'tailfree', typicalP: 'typical_p',
  seed: 'seed', badwords: 'badwords', stoptokens: 'stoptokens'
};
const STRING_PARAMS = new Set(['badwords', 'stoptokens']);
function buildRequestBody(messages, stream) {
  const p = config.params || {};
  const body = {
    model: config.model,
    messages,
    stream
  };
  if (stream) body.stream_options = { include_usage: true };
  for (const [key, apiName] of Object.entries(PARAM_MAP)) {
    let v = p[key];
    if (v === undefined || v === null || v === '') continue;
    if (!STRING_PARAMS.has(key)) v = Number(v);
    if (Number.isNaN(v)) continue;
    body[apiName] = v;
  }
  if (p.multilingual) body.multilingual_mode = true;
  if (p.effort) body.reasoning_effort = p.effort;
  return body;
}

// ---------- Settings ----------
function openSettings() {
  $('sApiKeyStatus').textContent = config.hasApiKey ? `設定済み: ${config.apiKeyMasked}` : '未設定';
  $('sApiKey').value = '';
  $('sApiKey').placeholder = config.hasApiKey ? config.apiKeyMasked : 'APIキーを入力';
  $('sModel').value = config.model;
  $('sProvider').value = detectProvider(config.baseUrl);
  $('sBaseUrl').value = config.baseUrl || '';
  $('sNoAuth').checked = config.noAuth === true;
  $('sLanAccess').checked = config.lanAccess === true;
  $('sTemperature').value = config.params.temperature;
  $('sTopP').value = config.params.topP;
  $('sMaxTokens').value = config.params.maxTokens;
  $('sEffort').value = config.params.effort;
  $('sStream').checked = config.stream !== false;
  $('sSendOnEnter').checked = config.sendOnEnter === true;
  $('sTemperatureVal').textContent = config.params.temperature;
  $('sTopPVal').textContent = config.params.topP;
  $('sSystemPrompt').value = config.systemPrompt || '';
  $('sWorldMemo').value = config.worldMemo || '';
  $('lanHint').textContent = config.lanAccess
    ? (config.lanUrl ? `スマホ等からはこのURLで開けます: ${config.lanUrl}` : 'LAN公開中（IPアドレスを取得できませんでした）')
    : 'LAN公開はOFF（このPCのみ）';
  $('sStylePreset').value = Object.keys(STYLE_PRESETS).find(k => STYLE_PRESETS[k] === (config.stylePreset || '')) || '';
  for (const [elId, key] of ADV_FIELDS) {
    $(elId).value = config.params[key] ?? '';
  }
  $('sMultilingual').checked = config.params.multilingual === true;
  $('sCtxBudget').value = config.params.ctxBudget ?? 120000;
  $('sHistoryLimit').value = config.params.historyLimit ?? 0;
  $('sAutoCards').checked = config.params.autoCards !== false;
  $('sAutoCompress').checked = config.params.autoCompress !== false;
  $('sRealTokens').checked = config.params.realTokens === true;
  $('sNoMarkdown').checked = config.params.noMarkdown !== false;
  $('sNoEmoji').checked = config.params.noEmoji !== false;
  $('sJpReasoning').checked = config.params.jpReasoning !== false;
  updateModelHint();
  refreshTemplates();
  $('settingsModal').classList.remove('hidden');
}
async function saveSettings() {
  const body = {
    model: $('sModel').value,
    params: {
      temperature: parseFloat($('sTemperature').value),
      topP: parseFloat($('sTopP').value),
      maxTokens: parseInt($('sMaxTokens').value) || 8192,
      effort: $('sEffort').value,
      multilingual: $('sMultilingual').checked,
      ctxBudget: parseInt($('sCtxBudget').value) || 120000,
      historyLimit: parseInt($('sHistoryLimit').value) || 0,
      autoCards: $('sAutoCards').checked,
      autoCompress: $('sAutoCompress').checked,
      realTokens: $('sRealTokens').checked,
      noMarkdown: $('sNoMarkdown').checked,
      noEmoji: $('sNoEmoji').checked,
      jpReasoning: $('sJpReasoning').checked
    },
    stream: $('sStream').checked,
    sendOnEnter: $('sSendOnEnter').checked,
    baseUrl: $('sBaseUrl').value.trim() || PROVIDER_URLS[$('sProvider').value] || PROVIDER_URLS.tringpt,
    noAuth: $('sNoAuth').checked,
    lanAccess: $('sLanAccess').checked,
    systemPrompt: $('sSystemPrompt').value,
    worldMemo: $('sWorldMemo').value,
    stylePreset: STYLE_PRESETS[$('sStylePreset').value] || ''
  };
  for (const [elId, key] of ADV_FIELDS) {
    const v = $(elId).value.trim();
    body.params[key] = v;
  }
  if ($('sApiKey').value.trim()) body.apiKey = $('sApiKey').value.trim();
  await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  config = await api('/api/config');
  $('settingsSaved').textContent = '保存しました';
  setTimeout(() => $('settingsSaved').textContent = '', 2000);
  setTimeout(() => $('settingsModal').classList.add('hidden'), 600);
  syncPresetState();
}

// ---------- プリセット（設定のスナップショットを名前付きで保存・即時切替） ----------
const PRESET_KEY = 'ai_presets';
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch { return []; }
}
function savePresets(list) { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); }

function snapshotConfig() {
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    noAuth: config.noAuth === true,
    params: JSON.parse(JSON.stringify(config.params || {})),
    systemPrompt: config.systemPrompt || '',
    worldMemo: config.worldMemo || '',
    stylePreset: config.stylePreset || '',
    stream: config.stream !== false,
    sendOnEnter: config.sendOnEnter === true
  };
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const r = {};
    for (const k of Object.keys(v).sort()) r[k] = canon(v[k]);
    return r;
  }
  return v;
}
function presetMatches(p) {
  return JSON.stringify(canon(p.data)) === JSON.stringify(canon(snapshotConfig()));
}
function syncPresetState() {
  const match = loadPresets().find(presetMatches);
  const aid = match ? match.id : null;
  if (aid) localStorage.setItem('preset_active', aid);
  else localStorage.removeItem('preset_active');
  updatePresetButton();
}
function updatePresetButton() {
  const el = $('presetLabel');
  if (!el) return;
  const p = loadPresets().find(x => x.id === localStorage.getItem('preset_active'));
  el.textContent = p ? p.name : 'なし';
}
function renderPresetMenu() {
  const list = $('presetList');
  if (!list) return;
  const presets = loadPresets();
  const activeId = localStorage.getItem('preset_active');
  list.innerHTML = '';
  if (!presets.length) {
    list.innerHTML = '<div class="menu-item menu-static hint">プリセットなし</div>';
    return;
  }
  for (const p of presets) {
    const item = document.createElement('div');
    item.className = 'menu-item preset-item' + (p.id === activeId ? ' active' : '');
    item.innerHTML = `<span class="preset-name"></span><button class="preset-del" title="削除">×</button>`;
    item.querySelector('.preset-name').textContent = p.name;
    item.onclick = async () => {
      await applyPreset(p);
    };
    item.querySelector('.preset-del').onclick = (e) => {
      e.stopPropagation();
      savePresets(loadPresets().filter(x => x.id !== p.id));
      if (localStorage.getItem('preset_active') === p.id) localStorage.removeItem('preset_active');
      renderPresetMenu();
      updatePresetButton();
    };
    list.appendChild(item);
  }
}
async function applyPreset(p) {
  const d = p.data || {};
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      model: d.model, baseUrl: d.baseUrl, noAuth: d.noAuth === true,
      params: d.params || {}, systemPrompt: d.systemPrompt || '',
      worldMemo: d.worldMemo || '', stylePreset: d.stylePreset || '',
      stream: d.stream !== false, sendOnEnter: d.sendOnEnter === true
    })
  });
  config = await api('/api/config');
  localStorage.setItem('preset_active', p.id);
  renderPresetMenu();
  updatePresetButton();
  appAlert(`プリセット「${p.name}」を適用しました`);
}
async function savePreset() {
  const name = await appPrompt('プリセット名を入力（例: 創作モード / 推敲モード）', '');
  if (!name || !name.trim()) return;
  const list = loadPresets();
  const exist = list.findIndex(x => x.name === name.trim());
  const entry = { id: exist >= 0 ? list[exist].id : Date.now().toString(36), name: name.trim(), data: snapshotConfig() };
  if (exist >= 0) list[exist] = entry; else list.push(entry);
  savePresets(list);
  localStorage.setItem('preset_active', entry.id);
  renderPresetMenu();
  updatePresetButton();
}

// ---------- Search ----------
function onSearchInput() {
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

// ---------- 変数置換（{{user}} {{ai}} {{char}} {{title}} {{date}}） ----------
function applyVars(text) {
  if (!text) return text;
  const aiName = fun.aiName || 'AI';
  return String(text)
    .replace(/\{\{\s*user\s*\}\}/g, 'ユーザー')
    .replace(/\{\{\s*ai\s*\}\}/g, aiName)
    .replace(/\{\{\s*char\s*\}\}/g, aiName)
    .replace(/\{\{\s*title\s*\}\}/g, current?.title || '無題')
    .replace(/\{\{\s*date\s*\}\}/g, new Date().toLocaleDateString('ja-JP'));
}

// ---------- Lorebook（キーワード自動注入カード） ----------
function lorebookCardsText() {
  if (!allCards.length || !current) return '';
  const recent = apiMessages().slice(-15).map(m => m.content || '').join('\n');
  if (!recent.trim()) return '';
  const already = new Set(effectiveCardIds());
  const matched = [];
  for (const c of allCards) {
    if (already.has(c.id)) continue;
    const kws = String(c.triggers || '').split(/[,、\s]+/).map(s => s.trim()).filter(s => s.length >= 2);
    if (!kws.length) continue;
    if (kws.some(k => recent.includes(k))) {
      matched.push(c);
      if (matched.length >= 8) break;
    }
  }
  if (!matched.length) return '';
  return matched.map(c =>
    `【${CARD_KINDS[c.kind] || '設定'}: ${c.name}（キーワード検出）】\n${c.content}`
  ).join('\n\n');
}

// ---------- #タグ呼び出しカード ----------
function cardTagList(c) {
  return String(c.tags || '').split(/[,、\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
}
function allCardTags() {
  const set = new Set();
  for (const c of allCards) for (const t of cardTagList(c)) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}
// 会話内の #タグ / ##タグ を収集
//   #タグ  : 使った時点以降ずっと有効（その会話内）
//   ##タグ : 直前のユーザーメッセージへの返答のみ有効（一度きり）
function collectHashTags() {
  const persist = new Set(), single = new Set();
  if (!current) return { persist, single };
  const msgs = apiMessages().filter(m => m.role === 'user');
  const re = /(#{1,2})([^\s#、。，,.!?！？「」『』（）()]+)/g;
  msgs.forEach((m, i) => {
    const isLast = i === msgs.length - 1;
    for (const mm of (m.content || '').matchAll(re)) {
      const tag = mm[2].toLowerCase();
      if (mm[1] === '##') { if (isLast) single.add(tag); }
      else persist.add(tag);
    }
  });
  return { persist, single };
}
function tagCardsText() {
  if (!allCards.length || !current) return '';
  const { persist, single } = collectHashTags();
  const wanted = new Set([...persist, ...single]);
  if (!wanted.size) return '';
  const already = new Set(effectiveCardIds()); // 選択・自動注入済みは重複させない
  const parts = [];
  for (const c of allCards) {
    if (already.has(c.id)) continue;
    const tags = cardTagList(c);
    const isPersist = tags.some(t => persist.has(t));
    const isSingle = !isPersist && tags.some(t => single.has(t));
    if (isPersist || isSingle) {
      const mark = isPersist ? '（#タグ呼び出し）' : '（##タグ・今回のみ）';
      parts.push(`【${CARD_KINDS[c.kind] || '設定'}: ${c.name}${mark}】\n${c.content}`);
    }
  }
  return parts.join('\n\n');
}

// ---------- #タグサジェスト ----------
let tagSugEl = null, tagSugItems = [], tagSugIdx = -1, tagSugRange = null;
function ensureTagSug() {
  if (tagSugEl) return tagSugEl;
  tagSugEl = document.createElement('div');
  tagSugEl.id = 'tagSuggest';
  tagSugEl.className = 'hidden';
  document.body.appendChild(tagSugEl);
  return tagSugEl;
}
function hideTagSug() {
  if (tagSugEl) tagSugEl.classList.add('hidden');
  tagSugItems = []; tagSugIdx = -1; tagSugRange = null;
}
function renderTagSug() {
  const el = ensureTagSug();
  el.innerHTML = '';
  tagSugItems.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tag-suggest-item' + (i === tagSugIdx ? ' active' : '');
    d.textContent = '#' + t;
    d.onmousedown = (e) => { e.preventDefault(); applyTagSug(t); };
    el.appendChild(d);
  });
  const r = inputEl.getBoundingClientRect();
  el.style.left = Math.max(8, r.left) + 'px';
  el.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  el.style.width = Math.max(200, Math.min(r.width, 340)) + 'px';
  el.classList.remove('hidden');
}
function updateTagSug() {
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const m = inputEl.value.slice(0, pos).match(/#([^\s#、。，,.!?！？「」『』（）()]*)$/);
  if (!m) { hideTagSug(); return; }
  const prefix = m[1].toLowerCase();
  tagSugItems = allCardTags().filter(t => t.toLowerCase().startsWith(prefix));
  if (!tagSugItems.length) { hideTagSug(); return; }
  tagSugIdx = 0;
  tagSugRange = { start: pos - m[0].length, end: pos };
  renderTagSug();
}
function applyTagSug(tag) {
  if (!tagSugRange) return;
  const v = inputEl.value;
  inputEl.value = v.slice(0, tagSugRange.start) + '#' + tag + ' ' + v.slice(tagSugRange.end);
  hideTagSug();
  inputEl.dispatchEvent(new Event('input'));
  inputEl.focus();
}
function tagSugKey(e) {
  if (!tagSugEl || tagSugEl.classList.contains('hidden') || !tagSugItems.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    tagSugIdx = (tagSugIdx + (e.key === 'ArrowDown' ? 1 : -1) + tagSugItems.length) % tagSugItems.length;
    renderTagSug();
    return true;
  }
  if ((e.key === 'Tab' || e.key === 'Enter') && !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    applyTagSug(tagSugItems[tagSugIdx]);
    return true;
  }
  if (e.key === 'Escape') { hideTagSug(); return true; }
  return false;
}

// ---------- Send ----------
function composeSystemPrompt() {
  const p = current?.profile || {};
  const parts = [];
  if (p.systemPrompt?.trim()) parts.push(applyVars(p.systemPrompt.trim()));
  if (p.stylePreset) parts.push(applyVars('文体指定: ' + p.stylePreset));
  if (p.plot?.trim()) parts.push('【プロット】\n' + applyVars(p.plot.trim()));
  if (p.summary?.trim()) parts.push('【これまでのあらすじ（圧縮済み）】\n' + applyVars(p.summary.trim()));
  if (p.worldMemo?.trim()) parts.push('【文脈メモ】\n' + applyVars(p.worldMemo.trim()));
  const cardsText = selectedCardsText();
  if (cardsText) parts.push('【設定カード】\n' + cardsText);
  const lb = lorebookCardsText();
  if (lb) parts.push('【キーワード自動注入】\n' + lb);
  const tc = tagCardsText();
  if (tc) parts.push('【#タグで呼び出されたカード】\n' + tc);
  // ソース参照（NotebookLM的Q&A）：会話プロファイルでプロジェクト選択時、資料を注入して出典付き回答を指示
  const sp = p.sourceProject || (p.useSources ? '__all' : '');
  const srcList = sp ? allSources.filter(s => sp === '__all' || (s.project || '') === sp) : [];
  if (srcList.length) {
    const budget = 40000;
    let used = 0;
    const blocks = [];
    for (const s of srcList) {
      const label = s.project ? `${s.name}（${s.project}）` : s.name;
      const head = `【ソース: ${label}】\n`;
      const room = budget - used - head.length;
      if (room <= 500) break;
      const body = (s.content || '').slice(0, room);
      used += head.length + body.length;
      blocks.push(head + body + ((s.content || '').length > room ? '\n…（以下省略）' : ''));
    }
    if (blocks.length) {
      parts.push('【参照ソース】\n' + blocks.join('\n\n') +
        '\n\n※回答には根拠となったソース名を【出典: ソース名】の形式で明記してください。ソースに書かれていないことは推測である旨を明示してください。');
    }
  }
  const gp = config.params || {};
  const rules = [];
  if (gp.noMarkdown !== false) rules.push('Markdown記法（#・##・*・-・`・>・[]()など）は使用せず、プレーンテキストの小説文として出力してください。');
  if (gp.noEmoji !== false) rules.push('絵文字・顔文字・特殊記号による装飾は使用しないでください。');
  if (gp.jpReasoning !== false) rules.push('思考・推論の過程は必ず日本語で行ってください。');
  if (rules.length) parts.push('【出力ルール】\n' + rules.join('\n'));
  if (fun.aiName) parts.push(`（あなたの名前は「${fun.aiName}」です。呼ばれたらその名前で応答してください）`);
  parts.push(`（あなたの現在の機嫌: ${fun.mood}。機嫌を反映した自然な口調で応答してください）`);
  return parts.join('\n\n');
}

// APIに送るメッセージ（scene等の特殊roleを除外）
function apiMessages() {
  return current.messages.filter(m => m.role === 'user' || m.role === 'assistant');
}
// AIが実際に読む会話履歴（メモリ設定: params.historyLimit 件まで。0=全て）
function contextMessages() {
  const msgs = apiMessages();
  const n = parseInt(config.params.historyLimit) || 0;
  return n > 0 ? msgs.slice(-n) : msgs;
}

function apiKeyMissing() { return !(config.hasApiKey || config.noAuth); }
function apiWarnMissing() { if (apiKeyMissing()) { openSettings(); appAlert('APIキーを設定してください（ローカルLLMの場合は「APIキー不要」にチェック）'); return true; } return false; }

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy || !current) return;
  if (apiWarnMissing()) return;

  if (current.messages.length === 0 && (!current.title || current.title === '新しい会話')) {
    current.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  }
  fun.infiniteCount = 0; // 手動送信で無限カウントリセット
  const outgoing = fun.neko ? nekoifyInput(text) : text;
  logChars(outgoing.length);
  const msgObj = { role: 'user', content: outgoing };
  current.messages.push(msgObj);
  const uEl = addMsg('user', outgoing);
  addUserActions(uEl, msgObj);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  localStorage.removeItem(draftKey());
  hideTagSug();
  await runCompletion();
}

async function runCompletion() {
  const conv = current; // 生成対象の会話を固定（途中でタブを切り替えても別会話に混入しないように）
  if (!conv) { setBusy(false); return; }
  setBusy(true);
  const botEl = addBotMsg();
  let fullText = '', reasoning = '', inTok = 0, outTok = 0;

  const messages = [];
  const sys = composeSystemPrompt();
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of contextMessages()) messages.push({ role: m.role, content: m.content });

  const body = buildRequestBody(messages, config.stream !== false);

  abortCtrl = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortCtrl.signal
    });

    if (!res.ok) {
      let err = res.statusText;
      try { err = (await res.json()).error || err; } catch {}
      throw new Error(`${res.status}: ${err}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', renderQueued = false, lastRender = 0;
      const scheduleRender = () => {
        if (renderQueued) return;
        const wait = Math.max(0, 80 - (Date.now() - lastRender));
        renderQueued = true;
        setTimeout(() => {
          renderQueued = false;
          lastRender = Date.now();
          botEl.classList.remove('thinking');
          renderBotContent(botEl, fullText, reasoning || '');
          scrollChat();
        }, wait);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            if (json.usage) {
              inTok = json.usage.prompt_tokens || inTok;
              outTok = json.usage.completion_tokens || outTok;
            }
            const delta = json.choices?.[0]?.delta || {};
            const r = delta.reasoning || delta.reasoning_content || '';
            if (r && !r.includes('ENCRYPTED-TEXT')) reasoning += r;
            if (delta.content) {
              fullText += delta.content;
              scheduleRender();
            }
          } catch {}
        }
      }
      // ストリーム終了後に最終状態を必ず描画
      botEl.classList.remove('thinking');
      renderBotContent(botEl, fullText, reasoning || '');
      scrollChat();
    } else {
      const json = await res.json();
      const msg = json.choices?.[0]?.message || {};
      reasoning = (msg.reasoning || msg.reasoning_content || '');
      if (reasoning.includes('ENCRYPTED-TEXT')) reasoning = '';
      fullText = msg.content || '';
      if (json.usage) {
        inTok = json.usage.prompt_tokens || 0;
        outTok = json.usage.completion_tokens || 0;
      }
      botEl.classList.remove('thinking');
      renderBotContent(botEl, fullText || '(空の応答)', reasoning);
    }

    if (fullText.trim()) {
      logChars(fullText.length);
      const msgObj = { role: 'assistant', content: fullText };
      if (pendingSummary) { msgObj._summary = true; pendingSummary = false; }
      if (pendingStyle) { msgObj._style = true; pendingStyle = false; }
      conv.messages.push(msgObj);
      addBotActions(botEl, msgObj);
      if (current === conv) updateCharCount();
    } else {
      botEl.remove();
      pendingSummary = false;
    }
    scheduleInfinite(conv);
  } catch (e) {
    if (e.name === 'AbortError') {
      fun.infinite = false; fun.infiniteCount = 99;
      syncFunButtons();
      if (fullText.trim()) {
        const msgObj = { role: 'assistant', content: fullText + '\n\n〔停止されました〕' };
        conv.messages.push(msgObj);
        botEl.classList.remove('thinking');
        renderBotContent(botEl, fullText, reasoning);
        const note = document.createElement('div');
        note.innerHTML = '<hr><i style="color:var(--text-dim);font-size:12px">〔ユーザーにより停止〕</i>';
        botEl.querySelector('.content').appendChild(note);
        addBotActions(botEl, msgObj);
      } else botEl.remove();
    } else {
      botEl.className = 'msg bot error';
      botEl.innerHTML = '<div class="content">' + esc(String(e.message || e)) + '</div>';
      fun.infinite = false; fun.infiniteCount = 99;
      syncFunButtons();
      // 送信したuserメッセージをロールバック
      if (conv.messages.length && conv.messages[conv.messages.length-1].role === 'user') {
        conv.messages.pop();
        if (current === conv) {
          const users = chatEl.querySelectorAll('.msg.user');
          if (users.length) users[users.length-1].remove();
        }
      }
    }
  } finally {
    abortCtrl = null;
    pendingSummary = false;
    pendingStyle = false;
    setBusy(false);
    if (!inTok && !outTok) {
      // usageを返さないAPI向けに文字数から推定（日本語は約1.5文字=1トークン）
      const inChars = messages.reduce((s, m) => s + (m.content || '').length, 0);
      inTok = Math.ceil(inChars / 1.5);
      outTok = Math.ceil(((fullText || '') + (reasoning || '')).length / 1.5);
    }
    if (inTok || outTok) {
      conv.totalTokens = conv.totalTokens || { input: 0, output: 0 };
      conv.totalTokens.input += inTok;
      conv.totalTokens.output += outTok;
    }
    updateTokenBadge();
    saveConversation(conv);
    renderConvList();
    setTimeout(() => { if (current === conv) maybeAutoCompress(); }, 800);
    inputEl.focus();
  }
}

async function regenerate(botEl) {
  if (busy || !current) return;
  captureSnapshot('再生成前');
  // 末尾側にある最後のassistantメッセージを削除（scene区切りは残す）
  for (let i = current.messages.length - 1; i >= 0; i--) {
    const m = current.messages[i];
    if (m.role === 'assistant') { current.messages.splice(i, 1); break; }
    if (m.role === 'user') break; // それより前にuserがあれば中断（直前応答のみ再生成）
  }
  botEl.remove();
  await runCompletion();
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  stopBtn.classList.toggle('hidden', !b);
  inputEl.disabled = b;
}

function updateTokenBadge() {
  if (!current) { tokenBadgeEl.textContent = ''; return; }
  const t = current.totalTokens || { input: 0, output: 0 };
  const cost = t.input * PRICE_IN_PER_TOKEN + t.output * PRICE_OUT_PER_TOKEN;
  // コンテキスト推定（日本語は約1.5文字=1トークン）
  let chars = (composeSystemPrompt() || '').length;
  for (const m of contextMessages()) chars += (m.content || '').length;
  const ctx = Math.ceil(chars / 1.5);
  tokenBadgeEl.textContent = `Σ ${t.input.toLocaleString()}+${t.output.toLocaleString()} tok · 約¥${cost.toFixed(2)} · ctx ~${ctx.toLocaleString()}`;
  refreshRealCtx();
}

// ---------- Export ----------
function convToLines() {
  const lines = [];
  for (const m of current.messages) {
    if (m.role === 'scene') lines.push({ type: 'scene', label: (m.kind === 'chapter' ? '章: ' : '') + (m.label || 'シーン') });
    else if (m.role === 'user') lines.push({ type: 'user', content: m.content });
    else lines.push({ type: 'ai', content: m.content });
  }
  return lines;
}
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function exportDoc() {
  if (!current || !current.messages.length) { appAlert('エクスポートする会話がありません'); return; }
  const format = $('exportFormat').value;
  const safeName = current.title.replace(/[\\/:*?"<>|]/g, '_');
  const lines = convToLines();

  if (format === 'txt') {
    // 小説投稿サイト向け: AI応答のみを本文として出力（ユーザー発言は除外）
    let out = '';
    for (const l of lines) {
      if (l.type === 'scene') out += `\n\n〔${l.label}〕\n\n`;
      else if (l.type === 'ai') out += l.content + '\n\n';
    }
    downloadFile(safeName + '.txt', out.trim(), 'text/plain');
    return;
  }
  if (format === 'html') {
    let body = '';
    for (const l of lines) {
      if (l.type === 'scene') body += `<h2>▤ ${esc(l.label)}</h2>`;
      else if (l.type === 'user') body += `<div class="u"><b>ユーザー</b><p>${esc(l.content)}</p></div>`;
      else body += `<div class="a"><b>AI</b><div>${mdRender(l.content)}</div></div>`;
    }
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>${esc(current.title)}</title>
<style>body{font-family:"Yu Mincho",serif;max-width:720px;margin:40px auto;line-height:2;padding:0 20px}h1{font-size:22px}.u{background:#eee;padding:10px;border-radius:8px;margin:16px 0}.a{margin:16px 0}h2{border-bottom:1px dashed #ccc;padding-bottom:4px}</style></head>
<body><h1>${esc(current.title)}</h1>${body}</body></html>`;
    downloadFile(safeName + '.html', html, 'text/html');
    return;
  }
  // markdown（デフォルト）
  let md = `# ${current.title}\n\n`;
  const cardsText = selectedCardsText();
  if (cardsText) md += `> 使用カード:\n${cardsText.split('\n').map(l => '> ' + l).join('\n')}\n\n`;
  for (const l of lines) {
    if (l.type === 'scene') md += `\n---\n\n## シーン: ${l.label}\n\n`;
    else if (l.type === 'user') md += `## ユーザー\n\n${l.content}\n\n`;
    else md += `## AI\n\n${l.content}\n\n`;
  }
  downloadFile(safeName + '.md', md, 'text/markdown');
}

// ---------- 文字数カウント ----------
function updateCharCount() {
  if (!current) { $('charCount').textContent = ''; return; }
  let chars = 0;
  for (const m of current.messages) {
    if (m.role === 'user' || m.role === 'assistant') chars += (m.content || '').length;
  }
  const sheets = Math.ceil(chars / 400);
  $('charCount').textContent = `${chars.toLocaleString()}字 ≒ 原稿用紙${sheets}枚`;
}

// ---------- 無限生成 ----------
function scheduleInfinite(conv) {
  if (!fun.infinite || fun.infiniteCount >= 5 || !conv) return;
  fun.infiniteCount++;
  setTimeout(async () => {
    if (!fun.infinite || busy || current !== conv) return; // タブを切り替えたら中断
    const text = '続きを書いてください';
    const msgObj = { role: 'user', content: text };
    current.messages.push(msgObj);
    const uEl = addMsg('user', text);
    addUserActions(uEl, msgObj);
    await runCompletion();
  }, 800);
}

// ---------- クイック指示 ----------
async function sendInstruction(text, opts = {}) {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  captureSnapshot('指示前');
  if (opts.summary) pendingSummary = true;
  if (opts.style) pendingStyle = true;
  const content = `【指示】${text}\n\n（直前の応答についての指示です。指示に従って修正・続きを生成してください）`;
  const msgObj = { role: 'user', content };
  current.messages.push(msgObj);
  const uEl = addMsg('user', content);
  addUserActions(uEl, msgObj);
  fun.infiniteCount = 0;
  await runCompletion();
}

// ---------- 選択範囲への指示 ----------
let selPopup = null;
function initSelectionPopup() {
  chatEl.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel.toString().trim();
      if (!text || text.length < 2 || !sel.anchorNode) {
        if (selPopup) selPopup.remove();
        selPopup = null;
        return;
      }
      const range = sel.getRangeAt(0);
      const inBot = range.commonAncestorContainer.parentElement?.closest?.('.msg.bot');
      if (!inBot) { if (selPopup) selPopup.remove(); selPopup = null; return; }
      const rect = range.getBoundingClientRect();
      if (selPopup) selPopup.remove();
      selPopup = document.createElement('button');
      selPopup.className = 'qb sel-popup';
      selPopup.style.cssText = `position:fixed;z-index:200;left:${rect.left}px;top:${rect.top - 34}px;`;
      selPopup.textContent = 'この範囲を指示';
      selPopup.onclick = async () => {
        const instruction = await appPrompt(`選択範囲への指示を入力\n\n「${text.slice(0, 50)}${text.length > 50 ? '…' : ''}」`);
        selPopup.remove(); selPopup = null;
        window.getSelection().removeAllRanges();
        if (instruction && instruction.trim()) {
          sendInstruction(`${instruction.trim()}\n\n対象箇所: 「${text}」`);
        }
      };
      document.body.appendChild(selPopup);
    }, 10);
  });
  document.addEventListener('mousedown', (e) => {
    if (selPopup && !selPopup.contains(e.target)) { selPopup.remove(); selPopup = null; }
  });
}

// ---------- 音声入力 ----------
let recognition = null;
let listening = false;
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { appAlert('お使いのブラウザは音声認識に対応していません'); return; }
  if (listening) { recognition?.stop(); return; }
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;
  const base = inputEl.value;
  recognition.onresult = (e) => {
    let interim = '';
    for (const r of e.results) interim += r[0].transcript;
    inputEl.value = base + interim;
    inputEl.dispatchEvent(new Event('input'));
  };
  recognition.onend = () => { listening = false; $('qbVoice').classList.remove('active'); };
  recognition.onerror = () => { listening = false; $('qbVoice').classList.remove('active'); };
  recognition.start();
  listening = true;
  $('qbVoice').classList.add('active');
}

// ---------- 桜吹雪 ----------
function toggleSakura() {
  fun.sakura = !fun.sakura;
  saveFun('sakura');
  $('qbSakura').classList.toggle('active', fun.sakura);
  let layer = $('sakura-layer');
  if (fun.sakura) {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'sakura-layer';
      document.body.appendChild(layer);
    }
    layer.innerHTML = '';
    for (let i = 0; i < 24; i++) {
      const p = document.createElement('div');
      p.className = 'petal';
      p.style.left = Math.random() * 100 + 'vw';
      p.style.animationDuration = (7 + Math.random() * 9) + 's';
      p.style.animationDelay = (Math.random() * 10) + 's';
      p.style.transform = `scale(${0.6 + Math.random() * 0.9})`;
      layer.appendChild(p);
    }
  } else if (layer) {
    layer.remove();
  }
}

// ---------- にゃんモード ----------
function toggleNeko() {
  fun.neko = !fun.neko;
  saveFun('neko');
  $('qbNeko').classList.toggle('active', fun.neko);
  // 表示中のメッセージを再描画
  if (current) {
    clearChat();
    for (const m of current.messages) renderMessage(m);
    scrollChat();
  }
}

// ---------- 無限生成ボタン ----------
function toggleInfinite() {
  fun.infinite = !fun.infinite;
  if (fun.infinite) fun.infiniteCount = 0;
  $('qbInfinite').classList.toggle('active', fun.infinite);
  $('qbInfinite').title = fun.infinite ? '無限生成ON（5回まで自動継続）' : '無限生成（5回まで自動で続きを生成）';
}

function syncFunButtons() {
  $('qbNeko').classList.toggle('active', fun.neko);
  $('qbSakura').classList.toggle('active', fun.sakura);
  $('qbInfinite').classList.toggle('active', fun.infinite);
  $('btnExitWriting').classList.toggle('hidden', !fun.writingMode);
}

// ---------- テーマ ----------
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  fun.theme = order[(order.indexOf(fun.theme) + 1) % order.length];
  localStorage.setItem('ui_theme', fun.theme);
  applyTheme();
}
function applyTheme() {
  const el = document.documentElement;
  if (fun.theme === 'auto') delete el.dataset.theme;
  else el.dataset.theme = fun.theme;
  $('qbTheme').textContent = 'テーマ:' + { auto: '自動', light: 'ライト', dark: 'ダーク' }[fun.theme];
}

// ---------- 機嫌 ----------
function onMoodChange() {
  fun.mood = $('qbMood').value;
  localStorage.setItem('fun_mood', fun.mood);
}
async function moodUp() {
  if (!current) return;
  await sendInstruction('がんばって！いつもありがとう！');
}

// ---------- 会話の複製 ----------
async function duplicateConversation(c) {
  const conv = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({
      title: c.title + '（コピー）',
      messages: c.messages,
      profile: c.profile,
      cardIds: c.cardIds,
      totalTokens: { input: 0, output: 0 }
    })
  });
  await refreshConvList();
  await openConversation(conv.id);
}

// ---------- スクロール制御 ----------
function isNearBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
}
function scrollChat(force) {
  if (force || isNearBottom()) chatEl.scrollTop = chatEl.scrollHeight;
}
function initScrollWatch() {
  chatEl.addEventListener('scroll', () => {
    $('btnScrollBottom').classList.toggle('hidden', isNearBottom());
  });
  $('btnScrollBottom').onclick = () => scrollChat(true);
}

// ---------- サイドバー開閉（状態を永続化） ----------
function toggleSidebar() {
  const collapsed = document.documentElement.dataset.sidebar === 'collapsed';
  if (collapsed) delete document.documentElement.dataset.sidebar;
  else document.documentElement.dataset.sidebar = 'collapsed';
  localStorage.setItem('sidebar_collapsed', collapsed ? '0' : '1');
}

// ---------- 履歴モーダル ----------
function openHistoryModal() {
  if (!current) return;
  const el = $('historyList');
  el.innerHTML = '';
  const snaps = [...(current.snapshots || [])].reverse();
  if (!snaps.length) {
    el.innerHTML = '<p class="hint">履歴がありません。指示・再生成・別案を実行すると自動で保存されます。</p>';
    $('historyModal').classList.remove('hidden');
    return;
  }
  for (const s of snaps) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `<strong>${esc(s.label || '版')}</strong> <span class="hint">${new Date(s.ts).toLocaleString('ja-JP')} · ${s.content.length}字</span>
      <details style="margin-top:6px"><summary class="hint" style="cursor:pointer">内容を表示</summary><div class="history-content">${mdRender(s.content)}</div></details>
      <div class="params-row" style="margin-top:6px">
        <button class="qb">コピー</button>
        <button class="qb qb-restore">この内容を確認</button>
      </div>`;
    div.querySelector('.qb').onclick = () => navigator.clipboard.writeText(s.content);
    div.querySelector('.qb-restore').onclick = () => {
      appAlert(s.content.slice(0, 2000) + (s.content.length > 2000 ? '\n…' : ''));
    };
    el.appendChild(div);
  }
  $('historyModal').classList.remove('hidden');
}

// ---------- 執筆タイマー ----------
function toggleTimer() {
  const btn = $('qbTimer');
  if (timerState.running) {
    timerState.elapsed += Date.now() - timerState.startedAt;
    timerState.running = false;
    clearInterval(timerState.timerId);
    btn.classList.remove('active');
  } else {
    timerState.startedAt = Date.now();
    timerState.running = true;
    btn.classList.add('active');
    timerState.timerId = setInterval(updateTimerDisplay, 1000);
  }
  updateTimerDisplay();
}
function updateTimerDisplay() {
  const sec = Math.floor((timerState.elapsed + (timerState.running ? Date.now() - timerState.startedAt : 0)) / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  $('timerDisplay').textContent = `${m}:${s}`;
}

// ---------- BGM（環境音：雨） ----------
let audioCtx = null, rainGain = null;
function toggleBgm() {
  const btn = $('qbBgm');
  fun.bgm = !fun.bgm;
  btn.classList.toggle('active', fun.bgm);
  if (fun.bgm && !audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const len = audioCtx.sampleRate * 2;
    const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buffer; src.loop = true;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 800;
    rainGain = audioCtx.createGain();
    rainGain.gain.value = 0.04;
    src.connect(filter); filter.connect(rainGain); rainGain.connect(audioCtx.destination);
    src.start();
  } else if (audioCtx) {
    rainGain.gain.value = fun.bgm ? 0.04 : 0;
  }
}

// ---------- 猫耳モード ----------
function toggleEars() {
  fun.ears = !fun.ears;
  localStorage.setItem('fun_ears', fun.ears ? '1' : '0');
  document.body.classList.toggle('cat-ears', fun.ears);
  $('qbEars').classList.toggle('active', fun.ears);
}

// ---------- AIの名前 ----------
async function setAiName() {
  const name = await appPrompt('AIの名前を入力（空で解除）', fun.aiName);
  if (name === null) return;
  fun.aiName = name.trim();
  localStorage.setItem('fun_ainame', fun.aiName);
  updateAiNameTag();
}
function updateAiNameTag() {
  let tag = $('aiNameTag');
  if (fun.aiName) {
    if (!tag) {
      tag = document.createElement('span');
      tag.id = 'aiNameTag';
      tag.className = 'hint';
      tag.style.marginLeft = '8px';
      convTitleEl.after(tag);
    }
    tag.textContent = `「${fun.aiName}」`;
  } else if (tag) tag.remove();
}

// ---------- 目次（章・シーン構成ツリー） ----------
function showOutline() {
  if (!current) { appAlert('会話を選択してください'); return; }
  const nodes = [];
  let cur = null, sceneOrd = -1;
  const ensureHead = () => {
    if (!cur) { cur = { label: '（冒頭）', isCh: false, count: 0, ord: -1 }; nodes.push(cur); }
  };
  for (const m of current.messages) {
    if (m.role === 'scene') {
      const isCh = m.kind === 'chapter';
      sceneOrd++;
      cur = { label: m.label || (isCh ? '章' : 'シーン'), isCh, count: 0, ord: sceneOrd };
      nodes.push(cur);
    } else if (m.role === 'user' || m.role === 'assistant') {
      ensureHead();
      cur.count++;
    }
  }
  if (!nodes.length) { appAlert('まだ章・シーン区切りがありません。「ツール」から挿入できます'); return; }
  const dividers = [...chatEl.querySelectorAll('.scene-divider')];
  const html = nodes.map((n, i) =>
    `<div class="outline-item${n.isCh ? ' ch' : ''}" data-i="${i}">
      <span class="outline-label">${n.isCh ? '▣ ' : '└ '}${esc(n.label)}</span>
      <span class="hint">${n.count}件</span>
    </div>`
  ).join('');
  $('resultTitle').textContent = `目次 — ${current.title}`;
  $('resultBody').innerHTML = html;
  $('resultBody').querySelectorAll('.outline-item').forEach(el => {
    el.onclick = () => {
      const n = nodes[parseInt(el.dataset.i, 10)];
      $('resultModal').classList.add('hidden');
      if (n.ord >= 0 && dividers[n.ord]) {
        dividers[n.ord].scrollIntoView({ behavior: 'smooth', block: 'center' });
        dividers[n.ord].style.outline = '2px solid var(--accent)';
        setTimeout(() => dividers[n.ord].style.outline = '', 1200);
      } else {
        chatEl.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
  });
  $('resultModal').classList.remove('hidden');
}

// ---------- クイック指示（Quick Reply） ----------
function quickReplies() {
  try { return JSON.parse(localStorage.getItem('quick_replies') || '[]'); } catch { return []; }
}
function renderQuickReplies() {
  const wrap = $('quickReplyList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const list = quickReplies();
  if (list.length) {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    wrap.appendChild(sep);
    for (const q of list) {
      const b = document.createElement('button');
      b.className = 'menu-item qb';
      b.textContent = q.name || q.text.slice(0, 20);
      b.title = q.text;
      b.onclick = () => sendInstruction(applyVars(q.text));
      wrap.appendChild(b);
    }
    const sep2 = document.createElement('div');
    sep2.className = 'menu-sep';
    wrap.appendChild(sep2);
  }
}
async function addQuickReply() {
  const name = await appPrompt('クイック指示の名前（メニューに表示される短い名前）', 'マイクイック指示');
  if (name === null) return;
  const text = await appPrompt('指示文を入力\n（{{user}} {{ai}} {{title}} が使えます）', '例: {{user}}の視点でこの場面を描写してください');
  if (!text || !text.trim()) return;
  const list = quickReplies();
  list.push({ name: name.trim() || text.trim().slice(0, 15), text: text.trim() });
  localStorage.setItem('quick_replies', JSON.stringify(list));
  renderQuickReplies();
  appAlert('クイック指示を登録しました。「指示」メニューの下部に表示されます');
}

// ---------- TTS読み上げ ----------
let ttsSpeaking = false;
function stripMarkdown(t) {
  return String(t)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`\[\]()]/g, '')
    .replace(/\n{2,}/g, '。');
}
function toggleSpeak(text) {
  if (!('speechSynthesis' in window)) { appAlert('この環境では読み上げに対応していません'); return; }
  if (ttsSpeaking) { speechSynthesis.cancel(); ttsSpeaking = false; return; }
  const u = new SpeechSynthesisUtterance(stripMarkdown(text).slice(0, 8000));
  u.lang = 'ja-JP';
  const voices = speechSynthesis.getVoices().filter(v => v.lang && v.lang.startsWith('ja'));
  if (voices.length) u.voice = voices[0];
  u.onend = u.onerror = () => { ttsSpeaking = false; };
  ttsSpeaking = true;
  speechSynthesis.speak(u);
}

// ---------- 実トークン計測（trin_tokenizer_v3 / transformers.js） ----------
let tfScriptP = null, tfTokenizer = null, tfFailed = false;
const realCtxCache = { key: '', val: 0 };
function loadTransformers() {
  if (window.transformers) return Promise.resolve(window.transformers);
  if (tfScriptP) return tfScriptP;
  tfScriptP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.web.min.js';
    s.onload = () => window.transformers ? resolve(window.transformers) : reject(new Error('transformers未定義'));
    s.onerror = () => reject(new Error('CDN読み込み失敗'));
    document.head.appendChild(s);
  });
  return tfScriptP;
}
async function realTokenCount(text) {
  if (tfFailed || !text) return null;
  try {
    const T = await loadTransformers();
    if (!tfTokenizer) tfTokenizer = await T.AutoTokenizer.from_pretrained('naclbit/trin_tokenizer_v3');
    let total = 0;
    for (let i = 0; i < text.length; i += 8000) {
      const chunk = text.slice(i, i + 8000);
      let ids;
      if (typeof tfTokenizer.encode === 'function') ids = await tfTokenizer.encode(chunk);
      else ids = (await tfTokenizer(chunk)).input_ids;
      total += Array.isArray(ids) ? ids.length : (ids?.length || 0);
    }
    return total;
  } catch (e) {
    tfFailed = true;
    console.warn('実トークン計測を無効化:', e.message);
    return null;
  }
}
async function refreshRealCtx() {
  if (!current || config?.params?.realTokens !== true) return;
  const text = (composeSystemPrompt() || '') + '\n' + contextMessages().map(m => m.content || '').join('\n');
  const key = text.length + '|' + text.slice(0, 100) + '|' + text.slice(-100);
  if (realCtxCache.key === key) { applyRealCtx(realCtxCache.val); return; }
  const n = await realTokenCount(text);
  if (n == null || !current) return;
  realCtxCache.key = key; realCtxCache.val = n;
  applyRealCtx(n);
}
function applyRealCtx(n) {
  tokenBadgeEl.textContent = tokenBadgeEl.textContent.replace(/ctx ~[\d,]+/, 'ctx ' + n.toLocaleString() + ' (実測)');
}

// ---------- Util ----------
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ---------- Context budget & auto cards ----------
function estContextTokens() {
  if (!current) return 0;
  let chars = (composeSystemPrompt() || '').length;
  for (const m of contextMessages()) chars += (m.content || '').length;
  return Math.ceil(chars / 1.5);
}
function contextBudget() { return Math.max(10000, parseInt(config.params.ctxBudget) || 120000); }
function fmtTok(n) { return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

// 手動選択カード＋関連カード自動選択（結果をキャッシュ：送信ごとの全走査を防ぐ）
let cardIdsCache = { key: '', val: [] };
function effectiveCardIds() {
  const manual = current?.cardIds || [];
  if (config.params.autoCards === false || !allCards.length || !current) return [...manual];
  const msgs = apiMessages();
  const cacheKey = [
    current.id, msgs.length,
    msgs.length ? (msgs[msgs.length - 1].content || '').length : 0,
    cardsVersion, manual.join(',')
  ].join('|');
  if (cardIdsCache.key === cacheKey) return cardIdsCache.val;

  const ids = new Set(manual);
  const recent = msgs.slice(-10).map(m => m.content || '').join('\n');
  if (recent.trim()) {
    const scored = [];
    for (const c of allCards) {
      if (ids.has(c.id)) continue;
      const kws = new Set();
      if (c.name && c.name.length >= 2) kws.add(c.name);
      for (const w of (c.content || '').match(/[一-龯ァ-ヶーa-zA-Z0-9]{3,}/g) || []) kws.add(w);
      let score = 0;
      for (const k of kws) {
        let idx = 0;
        while ((idx = recent.indexOf(k, idx)) >= 0) { score++; idx += k.length; if (score > 60) break; }
        if (score > 60) break;
      }
      if (score >= 2) scored.push([score, c.id]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, id] of scored.slice(0, 5)) ids.add(id);
  }
  cardIdsCache = { key: cacheKey, val: [...ids] };
  return cardIdsCache.val;
}

function selectedCardsText() {
  const ids = effectiveCardIds();
  if (!ids.length) return '';
  const parts = [];
  for (const id of ids) {
    const c = allCards.find(x => x.id === id);
    if (c) {
      const status = c.kind === 'foreshadow' ? (c.resolved ? '（回収済み）' : '（未回収）') : '';
      const auto = !(current?.cardIds || []).includes(id) ? '（自動選択）' : '';
      parts.push(`【${CARD_KINDS[c.kind] || '設定'}: ${c.name}${status}${auto}】\n${c.content}`);
    }
  }
  return parts.join('\n\n');
}

// ストリーミングなし1回生成（内部処理用）
async function callApiOnce(messages) {
  const body = buildRequestBody(messages, false);
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let err = res.statusText;
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(res.status + ': ' + err);
  }
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content || '', usage: json.usage };
}

function convTranscript(maxChars = 45000) {
  let s = '';
  for (const m of apiMessages()) {
    s += `${m.role === 'user' ? '【ユーザー】' : '【AI】'}\n${(m.content || '').slice(0, 3000)}\n\n`;
    if (s.length > maxChars) break;
  }
  return s.slice(0, maxChars);
}

// コンテキスト圧縮（古い会話をAI要約に置き換え）
async function compressContext() {
  if (!current || busy) return;
  const conv = current; // 圧縮対象を固定（途中でタブを切り替えたら適用しない）
  const budget = contextBudget();
  const est = estContextTokens();
  if (est < budget * 0.5) {
    await appAlert(`コンテキストはまだ余裕があります（推定 ${fmtTok(est)} tok / 予算 ${fmtTok(budget)} tok）`);
    return;
  }
  const msgs = apiMessages();
  let acc = 0, cut = 0;
  for (let i = 0; i < msgs.length; i++) {
    acc += (msgs[i].content || '').length / 1.5;
    if (acc > budget * 0.45) { cut = i + 1; break; }
  }
  cut = Math.min(cut, msgs.length - 2);
  if (cut < 2) { await appAlert('圧縮できるほど古い会話がありません'); return; }
  const old = msgs.slice(0, cut);
  const transcript = old.map(m =>
    `${m.role === 'user' ? '【ユーザー】' : '【AI】'}\n${(m.content || '').slice(0, 3000)}`
  ).join('\n\n').slice(0, 55000);

  setBusy(true);
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説の編集者です。会話ログを読み、物語の進行・設定・登場人物・未解決の要素を400字程度のあらすじに圧縮してください。' },
      { role: 'user', content: transcript }
    ]);
    const summary = (text || '').trim();
    if (!summary) throw new Error('要約の生成に失敗しました');
    if (current !== conv) return; // 別タブに切り替わっていたら適用しない
    let removed = 0;
    conv.messages = conv.messages.filter(m => {
      if ((m.role === 'user' || m.role === 'assistant') && removed < cut) { removed++; return false; }
      return true;
    });
    current.messages.unshift({ role: 'scene', kind: 'chapter', label: 'ここまでを要約済み', ts: Date.now() });
    current.profile = current.profile || {};
    current.profile.summary = (current.profile.summary ? current.profile.summary + '\n\n' : '') +
      `【${new Date().toLocaleDateString('ja-JP')}時点】\n` + summary;
    clearChat();
    for (const m of current.messages) renderMessage(m);
    saveConversation();
    updateTokenBadge();
    await appAlert(`コンテキストを圧縮しました（${cut}件のメッセージを要約に置き換え）`);
  } finally { setBusy(false); }
}

function maybeAutoCompress() {
  if (busy || !current) return;
  if (config.params.autoCompress === false) return;
  if (estContextTokens() > contextBudget()) compressContext();
}

// ---------- 執筆パイプライン ----------
const PIPELINE_STEPS = [
  ['推敲', '直前の応答を推敲して、より自然で読みやすい文章に書き直してください。'],
  ['文体統一', '直前の応答の文体を、この会話全体の文体・トーンに統一してください。'],
  ['誤字脱字チェック', '直前の応答の誤字・脱字・表記ゆれ・文法の誤りをチェックし、修正した全文を出力してください。']
];
async function runPipeline() {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  if (!current.messages.some(m => m.role === 'assistant')) {
    await appAlert('推敲対象のAI応答がありません'); return;
  }
  for (const [name, text] of PIPELINE_STEPS) {
    if (busy || !current) return;
    await sendInstruction(`【パイプライン:${name}】${text}`);
  }
}

// ---------- N案並列生成 ----------
function adoptVariant(text) {
  if (!current) return;
  const msgObj = { role: 'assistant', content: text };
  current.messages.push(msgObj);
  const el = addBotMsg(false);
  renderBotContent(el, text, '');
  addBotActions(el, msgObj);
  updateCharCount();
  saveConversation();
  renderConvList();
  scrollChat();
}
async function genVariants(n = 3) {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  let idx = -1;
  for (let i = current.messages.length - 1; i >= 0; i--) {
    const m = current.messages[i];
    if (m.role === 'assistant') { idx = i; break; }
    if (m.role === 'user') break;
  }
  if (idx < 0) { appAlert('別案の対象となるAI応答がありません'); return; }
  current.messages.splice(idx, 1);
  captureSnapshot('別案生成前');
  setBusy(true);
  try {
    const sys = composeSystemPrompt();
    const base = [];
    if (sys) base.push({ role: 'system', content: sys });
    for (const m of contextMessages()) base.push({ role: m.role, content: m.content });
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const msgs = base.concat([{ role: 'user', content: `【指示】これまでの流れに対して、案${i + 1}として別の展開・別の文体で続きを書いてください。他の案と明確に差別化してください。` }]);
      jobs.push(callApiOnce(msgs).then(r => r.text).catch(e => '（生成失敗: ' + e.message + '）'));
    }
    const results = await Promise.all(jobs);
    const body = document.createElement('div');
    results.forEach((t, i) => {
      const sec = document.createElement('div');
      sec.style.marginBottom = '14px';
      sec.innerHTML = `<h4 style="margin:0 0 6px">案${i + 1}</h4><div class="variant-text"></div>`;
      try { sec.querySelector('.variant-text').innerHTML = mdRender(t); }
      catch { sec.querySelector('.variant-text').textContent = t; }
      body.appendChild(sec);
    });
    $('resultTitle').textContent = `別案候補（${n}案）`;
    $('resultBody').innerHTML = '';
    $('resultBody').appendChild(body);
    const bar = document.createElement('div');
    bar.className = 'params-row'; bar.style.marginTop = '8px';
    results.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'btn-ghost btn-sm';
      b.textContent = `案${i + 1}を採用`;
      b.onclick = () => { $('resultModal').classList.add('hidden'); adoptVariant(t); };
      bar.appendChild(b);
    });
    $('resultBody').appendChild(bar);
    $('resultModal').classList.remove('hidden');
  } finally { setBusy(false); }
}

// ---------- 感情曲線分析 ----------
async function analyzeEmotion() {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  const segs = [];
  let label = '冒頭', buf = [];
  const flush = () => { if (buf.length) segs.push({ label, text: buf.join('\n').slice(0, 1500) }); buf = []; };
  for (const m of current.messages) {
    if (m.role === 'scene') { flush(); label = (m.kind === 'chapter' ? '章: ' : '') + (m.label || 'シーン'); }
    else if (m.role === 'assistant') buf.push(m.content);
  }
  flush();
  if (!segs.length) { appAlert('分析対象の本文がありません'); return; }
  const list = segs.map((s, i) => `${i + 1}. ${s.label}`).join('\n');
  setBusy(true);
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説の編集者です。各シーンの「緊張度」を10段階で評価してください。出力は各行「番号|緊張度(1-10の数字)|感情(20字以内)」の形式のみ。説明・前置きは不要です。' },
      { role: 'user', content: `シーン一覧:\n${list}\n\n各シーンの本文（冒頭のみ）:\n` + segs.map((s, i) => `【${i + 1}. ${s.label}】\n${s.text}`).join('\n\n') }
    ]);
    const rows = [];
    for (const line of (text || '').split('\n')) {
      const m = line.match(/(\d+)\s*[\|｜、,]\s*(\d{1,2})\s*[\|｜、,]\s*(.+)/);
      if (m) {
        const t = Math.min(10, Math.max(1, parseInt(m[2], 10)));
        rows.push({ label: segs[parseInt(m[1], 10) - 1]?.label || ('シーン' + m[1]), score: t, mood: m[3].trim().slice(0, 20) });
      }
    }
    if (!rows.length) {
      $('resultTitle').textContent = '感情曲線';
      $('resultBody').innerHTML = '<p class="hint">解析できませんでした。生の出力:</p><pre style="white-space:pre-wrap;font-size:12px">' + esc(text || '') + '</pre>';
      $('resultModal').classList.remove('hidden');
      return;
    }
    const max = Math.max(...rows.map(r => r.score), 1);
    const html = rows.map(r =>
      `<div class="emo-row"><span class="emo-label">${esc(r.label)}</span>` +
      `<div class="emo-bar"><div class="emo-fill" style="width:${r.score / max * 100}%"></div></div>` +
      `<span class="emo-score">${r.score}</span><span class="emo-mood">${esc(r.mood)}</span></div>`
    ).join('');
    $('resultTitle').textContent = '感情曲線（緊張度 1-10）';
    $('resultBody').innerHTML = html;
    $('resultModal').classList.remove('hidden');
  } finally { setBusy(false); }
}

// ---------- 伏線・用語 自動収集 ----------
const COLLECT_KIND_MAP = { 'キャラ': 'character', '世界観': 'world', '用語': 'term', '伏線': 'foreshadow' };
async function collectTerms() {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  setBusy(true);
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説の設定管理者です。会話全体を読み、登場人物・世界観・用語・未回収の伏線候補を抽出してください。出力は各行「種別|名前|内容1-2文」の形式のみ。種別は「キャラ」「世界観」「用語」「伏線」から選択。重複は除き、最大20件。' },
      { role: 'user', content: convTranscript() }
    ]);
    const items = [];
    for (const line of (text || '').split('\n')) {
      const m = line.match(/^([^|｜]+)[\|｜]([^|｜]+)[\|｜](.+)$/);
      if (m) {
        const kindLabel = m[1].trim();
        const kind = COLLECT_KIND_MAP[kindLabel] || COLLECT_KIND_MAP[Object.keys(COLLECT_KIND_MAP).find(k => kindLabel.includes(k))] || 'term';
        items.push({ kind, name: m[2].trim().slice(0, 100), content: m[3].trim().slice(0, 2000) });
      }
    }
    if (!items.length) {
      $('resultTitle').textContent = '自動収集';
      $('resultBody').innerHTML = '<p class="hint">抽出できませんでした。生の出力:</p><pre style="white-space:pre-wrap;font-size:12px">' + esc(text || '') + '</pre>';
      $('resultModal').classList.remove('hidden');
      return;
    }
    const wrap = document.createElement('div');
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'collect-item';
      row.innerHTML = `<span class="card-kind">${CARD_KINDS[it.kind] || it.kind}</span> <strong></strong> <span class="hint"></span>`;
      row.querySelector('strong').textContent = it.name;
      row.querySelector('.hint').textContent = it.content.slice(0, 80);
      const b = document.createElement('button');
      b.className = 'btn-ghost btn-sm';
      b.textContent = 'カードに追加';
      b.onclick = async () => {
        await api('/api/cards', { method: 'POST', body: JSON.stringify({ name: it.name, kind: it.kind, content: it.content }) });
        await refreshCards();
        b.textContent = '追加済'; b.disabled = true;
      };
      row.appendChild(b);
      wrap.appendChild(row);
    }
    $('resultTitle').textContent = `自動収集（${items.length}件）— カードに追加できます`;
    $('resultBody').innerHTML = '';
    $('resultBody').appendChild(wrap);
    $('resultModal').classList.remove('hidden');
  } finally { setBusy(false); }
}

// ---------- 文体プロファイル ----------
let pendingStyle = false;
function customStyles() {
  try { return JSON.parse(localStorage.getItem('custom_styles') || '[]'); } catch { return []; }
}
function refreshStyleOptions() {
  for (const selId of ['pStylePreset', 'sStylePreset']) {
    const sel = $(selId);
    if (!sel) continue;
    [...sel.options].forEach(o => { if (o.dataset.custom) sel.removeChild(o); });
    for (const s of customStyles()) {
      const o = document.createElement('option');
      o.value = s.text; o.dataset.custom = '1'; o.textContent = '★ ' + s.name;
      sel.appendChild(o);
    }
  }
}
async function saveStyle(content) {
  const name = await appPrompt('文体プリセット名を入力', 'マイ文体');
  if (name === null) return;
  const styles = customStyles();
  styles.push({ name: name.trim() || 'マイ文体', text: content });
  localStorage.setItem('custom_styles', JSON.stringify(styles));
  refreshStyleOptions();
  appAlert('文体プリセットに保存しました。「この会話」の文体プリセットから選べます');
}
async function extractStyle() {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  pendingStyle = true;
  await sendInstruction('これまでの会話で使われている文体を分析し、再現可能な「文体プロファイル」を箇条書きで作成してください（語彙の傾向・文末表現・リズム・描写の癖・会話文の特徴・避けるべき表現など）。');
}

// ---------- 執筆モード ----------
function toggleWritingMode() {
  fun.writingMode = !fun.writingMode;
  localStorage.setItem('fun_writingmode', fun.writingMode ? '1' : '0');
  document.body.classList.toggle('writing-mode', fun.writingMode);
  syncFunButtons();
}

// ---------- 執筆ログ ----------
function wlog() {
  try { return JSON.parse(localStorage.getItem('writing_log') || '{}'); } catch { return {}; }
}
function logChars(n) {
  if (!n) return;
  const log = wlog();
  const d = new Date().toISOString().slice(0, 10);
  log[d] = (log[d] || 0) + n;
  localStorage.setItem('writing_log', JSON.stringify(log));
}
function showWritingLog() {
  const log = wlog();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ d, n: log[d] || 0 });
  }
  const total = days.reduce((a, b) => a + b.n, 0);
  const month = new Date().toISOString().slice(0, 7);
  const monthTotal = Object.entries(log).filter(([k]) => k.startsWith(month)).reduce((a, [, v]) => a + v, 0);
  const max = Math.max(...days.map(d => d.n), 1);
  const rows = days.map(d =>
    `<div class="log-row"><span class="log-date">${d.d.slice(5)}</span>` +
    `<div class="log-bar"><div class="log-fill" style="width:${d.n / max * 100}%"></div></div>` +
    `<span class="log-num">${d.n.toLocaleString()}</span></div>`
  ).join('');
  $('resultTitle').textContent = '執筆ログ';
  $('resultBody').innerHTML =
    `<p class="hint">直近14日合計: <strong>${total.toLocaleString()}</strong>字 ／ 今月: <strong>${monthTotal.toLocaleString()}</strong>字</p>` + rows;
  $('resultModal').classList.remove('hidden');
}

// ---------- 汎用結果モーダル ----------
function showResultModal(title, html) {
  $('resultTitle').textContent = title;
  $('resultBody').innerHTML = html;
  $('resultModal').classList.remove('hidden');
}

// ---------- ウィンドウ最前列固定 ----------
async function togglePin() {
  if (!window.winAPI) return;
  const next = !(await window.winAPI.getAlwaysOnTop());
  window.winAPI.setAlwaysOnTop(next);
  localStorage.setItem('win_always_on_top', next ? '1' : '0');
  $('qbPin').classList.toggle('active', next);
}
async function restorePin() {
  if (!window.winAPI) return;
  const want = localStorage.getItem('win_always_on_top') === '1';
  if (want) {
    window.winAPI.setAlwaysOnTop(true);
    $('qbPin')?.classList.add('active');
  }
}

// ---------- クイックマクロ（ホットキー） ----------
const MACRO_COMMANDS = {
  newChat: '新しい会話',
  settings: '設定を開く',
  cards: 'カードを開く',
  cardPick: 'この会話で使うカード',
  compress: 'コンテキストを圧縮',
  outline: '目次を表示',
  history: '版の履歴',
  pipeline: '執筆パイプライン',
  variants3: '別案を3つ並列生成',
  emotion: '感情曲線を分析',
  collect: '伏線・用語を自動収集',
  style: '文体プロファイルを抽出',
  summary: 'あらすじを生成→メモに追加',
  ab: '別展開でもう一案（A/B）',
  instrContinue: '指示: 続きを書いて',
  instrPolish: '指示: 推敲',
  instrShorten: '指示: もっと短く',
  instrDetail: '指示: もっと詳しく',
  pin: '最前列に固定',
  theme: 'テーマ切替',
  writingMode: '執筆モード',
  search: '会話検索にフォーカス',
  scrollBottom: '最新へスクロール',
  voice: '音声入力'
};
let macros = [];
try { macros = JSON.parse(localStorage.getItem('hotkey_macros') || '[]'); } catch { macros = []; }
let macroPendingKey = null, macroRecArmed = false;

function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}
const ACCEL_KEY_MAP = { 'CapsLock': 'Capslock', 'Escape': 'Esc', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', ' ': 'Space' };
function toAccelerator(combo) {
  return combo.split('+').map(p => {
    if (p === 'Ctrl') return 'CommandOrControl';
    return ACCEL_KEY_MAP[p] || p;
  }).join('+');
}
function saveMacros() {
  localStorage.setItem('hotkey_macros', JSON.stringify(macros));
  syncGlobalHotkeys();
}
async function syncGlobalHotkeys() {
  if (!window.winAPI?.setGlobalHotkeys) return;
  const seen = new Set();
  const list = [];
  for (const m of macros) {
    if (!m.keys.includes('Alt') || seen.has(m.keys)) continue;
    seen.add(m.keys);
    list.push({ combo: m.keys, accelerator: toAccelerator(m.keys) });
  }
  try { await window.winAPI.setGlobalHotkeys(list); } catch {}
}
function runHotkeyCommand(id) {
  switch (id) {
    case 'newChat': return newConversation();
    case 'settings': return openSettings();
    case 'cards': return openCardsModal();
    case 'cardPick': return openCardPicker();
    case 'compress': return compressContext();
    case 'outline': return showOutline();
    case 'history': return openHistoryModal();
    case 'pipeline': return runPipeline();
    case 'variants3': return genVariants(3);
    case 'emotion': return analyzeEmotion();
    case 'collect': return collectTerms();
    case 'style': return extractStyle();
    case 'summary': return sendInstruction('これまでの会話全体のあらすじを400字程度で要約してください。時系列で簡潔に。', { summary: true });
    case 'ab': return altVersion();
    case 'instrContinue': return sendInstruction('続きを書いてください');
    case 'instrPolish': return sendInstruction('直前の応答を推敲して、より自然で読みやすい文章に書き直してください。');
    case 'instrShorten': return sendInstruction('もっと短くしてください');
    case 'instrDetail': return sendInstruction('もっと詳しく、情景描写を増やして書いてください');
    case 'pin': return togglePin();
    case 'theme': return cycleTheme();
    case 'writingMode': return toggleWritingMode();
    case 'search': searchBox.focus(); searchBox.select(); return;
    case 'scrollBottom': return scrollChat(true);
    case 'voice': return toggleVoice();
  }
}
function describeMacro(m) {
  const a = m.action || {};
  if (a.type === 'command') return MACRO_COMMANDS[a.cmd] || a.cmd;
  if (a.type === 'instruction') return '指示: ' + String(a.text || '').slice(0, 30);
  return '(不明)';
}
function runMacro(m) {
  const a = m.action || {};
  if (a.type === 'command') runHotkeyCommand(a.cmd);
  else if (a.type === 'instruction' && a.text) sendInstruction(a.text);
}
function fireHotkey(combo) {
  const m = macros.find(x => x.keys === combo);
  if (m) runMacro(m);
}

function openMacroModal() {
  const sel = $('macroAction');
  sel.innerHTML = '';
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '（カスタム指示を下の欄に入力）';
  sel.appendChild(o0);
  for (const [id, label] of Object.entries(MACRO_COMMANDS)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = label;
    sel.appendChild(o);
  }
  for (const q of quickReplies()) {
    const o = document.createElement('option');
    o.value = 'I:' + q.text;
    o.textContent = 'クイック指示: ' + (q.name || q.text.slice(0, 15));
    sel.appendChild(o);
  }
  renderMacroList();
  resetMacroForm();
  $('macroModal').classList.remove('hidden');
}
function renderMacroList() {
  const el = $('macroList');
  el.innerHTML = '';
  if (!macros.length) {
    el.innerHTML = '<p class="hint">割り当てはまだありません。下のフォームから追加してください。</p>';
    return;
  }
  for (const m of macros) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.style.display = 'flex'; div.style.alignItems = 'center'; div.style.gap = '10px';
    div.innerHTML = `<kbd class="macro-key"></kbd> <span class="hint" style="flex:1"></span>`;
    const kbd = div.querySelector('.macro-key');
    kbd.textContent = m.keys;
    div.querySelector('.hint').textContent = describeMacro(m) + (m.keys.includes('Alt') ? '（グローバル）' : '');
    const del = document.createElement('button');
    del.className = 'btn-ghost btn-sm';
    del.textContent = '削除';
    del.onclick = () => {
      macros = macros.filter(x => x !== m);
      saveMacros(); renderMacroList();
    };
    div.appendChild(del);
    el.appendChild(div);
  }
}
function resetMacroForm() {
  macroPendingKey = null; macroRecArmed = false;
  $('macroKeyLabel').textContent = '（未設定）';
  $('macroAction').value = '';
  $('macroCustom').value = '';
}
function armMacroRec() {
  macroRecArmed = true;
  $('macroKeyLabel').textContent = 'キーを押してください…（Escでキャンセル）';
  const h = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // 修飾キー単体は待機
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      macroPendingKey = null;
      document.removeEventListener('keydown', h, true);
      macroRecArmed = false;
      $('macroKeyLabel').textContent = '（未設定）';
      return;
    }
    macroPendingKey = comboFromEvent(e);
    document.removeEventListener('keydown', h, true);
    macroRecArmed = false;
    $('macroKeyLabel').textContent = macroPendingKey;
  };
  document.addEventListener('keydown', h, true);
}
function saveMacro() {
  const keys = macroPendingKey;
  if (!keys) { appAlert('まず「キーを押して登録」でキーを割り当ててください'); return; }
  if (macros.some(m => m.keys === keys)) { appAlert('そのキーは既に使われています'); return; }
  const sel = $('macroAction').value;
  let action;
  if (sel.startsWith('I:')) action = { type: 'instruction', text: sel.slice(2) };
  else if (sel) action = { type: 'command', cmd: sel };
  else {
    const t = $('macroCustom').value.trim();
    if (!t) { appAlert('アクションを選ぶか、カスタム指示文を入力してください'); return; }
    action = { type: 'instruction', text: t };
  }
  macros.push({ keys, action });
  saveMacros();
  renderMacroList();
  resetMacroForm();
  appAlert('マクロを登録しました: ' + keys);
}

// ---------- Bind ----------
function bindUI() {
  $('btnBulkDelete').onclick = deleteSelectedConvs;
  $('btnBulkClear').onclick = clearConvSelection;
  $('btnNewChat').onclick = newConversation;
  $('btnNewTab')?.addEventListener('click', newConversation);
  // モバイル：ハンバーガーでサイドバードロワー開閉
  $('btnMenu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.classList.toggle('sidebar-open');
  });
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('sidebar-open')
        && !e.target.closest('#sidebar') && !e.target.closest('#btnMenu')) {
      document.body.classList.remove('sidebar-open');
    }
  });
  $('btnSidebarToggle').onclick = toggleSidebar;
  // 原稿ペイン
  $('qbManuscript').onclick = toggleManuscriptPane;
  $('btnMsClose').onclick = () => $('manuscriptPane').classList.add('hidden');
  $('btnMsExport').onclick = exportManuscript;
  $('btnMsAddChapter').onclick = msAddChapter;
  $('btnMsAddScene').onclick = msAddScene;
  $('btnMsDel').onclick = msDelete;
  $('msSceneTitle').addEventListener('input', () => {
    const sc = msScene(); if (!sc) return;
    sc.title = $('msSceneTitle').value;
    scheduleMsSave();
  });
  $('msEditor').addEventListener('input', () => {
    const sc = msScene(); if (!sc) return;
    sc.content = $('msEditor').value;
    scheduleMsSave();
    const cnt = document.querySelector('.ms-sc.sel .ms-count');
    if (cnt) cnt.textContent = `${sc.content.length}字`;
  });
  // ソース管理
  $('btnSources').onclick = () => openSourcesModal();
  $('btnCloseSources').onclick = () => $('sourcesModal').classList.add('hidden');
  $('sourcesModal').addEventListener('click', (e) => { if (e.target === $('sourcesModal')) $('sourcesModal').classList.add('hidden'); });
  $('btnNewSource').onclick = () => { $('sourceEditForm').classList.remove('hidden'); $('srcId').value=''; $('srcName').value=''; $('srcContent').value=''; $('btnDeleteSource').classList.add('hidden'); $('srcName').focus(); };
  $('btnSaveSource').onclick = saveSource;
  $('btnCancelSource').onclick = resetSourceForm;
  $('btnDeleteSource').onclick = deleteSource;
  $('btnImportSource').onclick = () => $('srcFileInput').click();
  $('srcProjectFilter').onchange = renderSourceList;
  $('srcFileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importSourceFile(f);
    e.target.value = '';
  });
  // プロンプト最適化
  $('btnOptimizePrompt').onclick = optimizePrompt;
  initScrollWatch();
  $('btnSettings').onclick = openSettings;
  convTitleEl.title = 'ダブルクリックで会話名を変更';
  convTitleEl.ondblclick = async () => {
    if (!current) return;
    const v = await appPrompt('会話名を入力', current.title);
    if (v && v.trim() && v.trim() !== current.title) {
      await renameConversation(current, v);
    }
  };
  $('btnCloseSettings').onclick = () => $('settingsModal').classList.add('hidden');
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden');
  });
  $('btnSaveSettings').onclick = saveSettings;
  $('sModel').onchange = updateModelHint;
  $('sProvider').onchange = () => {
    const u = PROVIDER_URLS[$('sProvider').value];
    if (u) $('sBaseUrl').value = u;
    updateModelHint();
  };
  $('sTemperature').oninput = () => $('sTemperatureVal').textContent = $('sTemperature').value;
  $('sTopP').oninput = () => $('sTopPVal').textContent = $('sTopP').value;
  $('sTemplate').onchange = () => {
    const t = allTemplates.find(x => x.id === $('sTemplate').value);
    if (t) $('sSystemPrompt').value = t.content;
  };
  $('btnManageTemplates').onclick = () => openTplModal();
  $('btnCloseTpl').onclick = () => $('tplModal').classList.add('hidden');
  $('tplModal').addEventListener('click', (e) => { if (e.target === $('tplModal')) $('tplModal').classList.add('hidden'); });
  $('btnNewTpl').onclick = () => openTplModal();
  $('btnSaveTpl').onclick = saveTpl;
  $('btnCancelTpl').onclick = resetTplForm;
  $('btnDeleteTpl').onclick = deleteTpl;

  $('btnCards').onclick = () => openCardsModal();
  $('btnCards2').onclick = openCardPicker;
  $('btnCloseCards').onclick = () => $('cardsModal').classList.add('hidden');
  $('cardsModal').addEventListener('click', (e) => { if (e.target === $('cardsModal')) $('cardsModal').classList.add('hidden'); });
  $('btnNewCard').onclick = () => { $('cardEditForm').classList.remove('hidden'); $('cId').value=''; $('cName').value=''; $('cContent').value=''; $('cTriggers').value=''; $('cTags').value=''; $('btnDeleteCard').classList.add('hidden'); $('cName').focus(); };
  $('btnSaveCard').onclick = saveCard;
  $('btnCancelCard').onclick = resetCardForm;
  $('btnDeleteCard').onclick = deleteCard;

  $('btnCloseCardPick').onclick = () => $('cardPickModal').classList.add('hidden');
  $('cardPickModal').addEventListener('click', (e) => { if (e.target === $('cardPickModal')) $('cardPickModal').classList.add('hidden'); });
  $('btnSaveCardPick').onclick = saveCardPick;

  $('btnParams').onclick = () => $('paramsPanel').classList.toggle('hidden');
  $('btnSaveProfile').onclick = saveProfile;
  $('btnScene').onclick = insertSceneDivider;
  $('btnExport').onclick = exportDoc;
  $('btnHistory').onclick = openHistoryModal;
  $('btnChapter').onclick = insertChapterDivider;
  $('btnCompress').onclick = compressContext;
  $('btnOutline').onclick = showOutline;
  $('btnQuickReplyAdd').onclick = addQuickReply;
  $('qbPipeline').onclick = runPipeline;
  $('qbVariants').onclick = () => genVariants(3);
  $('qbEmotion').onclick = analyzeEmotion;
  $('qbCollect').onclick = collectTerms;
  $('qbStyle').onclick = extractStyle;
  $('qbWritingMode').onclick = toggleWritingMode;
  $('btnExitWriting').onclick = toggleWritingMode;
  $('qbLog').onclick = showWritingLog;
  $('btnCloseResult').onclick = () => $('resultModal').classList.add('hidden');
  $('resultModal').addEventListener('click', (e) => { if (e.target === $('resultModal')) $('resultModal').classList.add('hidden'); });
  $('btnCloseHistory').onclick = () => $('historyModal').classList.add('hidden');
  $('historyModal').addEventListener('click', (e) => { if (e.target === $('historyModal')) $('historyModal').classList.add('hidden'); });
  $('qbPin').onclick = togglePin;
  $('qbAB').onclick = altVersion;

  // クイックマクロ
  $('btnMacros').onclick = openMacroModal;
  $('btnCloseMacro').onclick = () => $('macroModal').classList.add('hidden');
  $('macroModal').addEventListener('click', (e) => { if (e.target === $('macroModal')) $('macroModal').classList.add('hidden'); });
  $('btnMacroRec').onclick = armMacroRec;
  $('btnMacroSave').onclick = saveMacro;
  $('btnMacroCancel').onclick = resetMacroForm;
  // ホットキー発火（マクロ優先：既存ショートカットより先に捕捉）
  document.addEventListener('keydown', (e) => {
    if (macroRecArmed) return;
    if (document.querySelector('.modal:not(.hidden)')) return;
    const hit = macros.find(m => m.keys === comboFromEvent(e));
    if (!hit) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
    if (inField && !(e.ctrlKey || e.altKey)) return; // 入力中は修飾キー無しの割り当てを無効化
    e.preventDefault();
    e.stopImmediatePropagation();
    runMacro(hit);
  }, true);
  window.winAPI?.onHotkey?.((combo) => fireHotkey(combo)); // グローバル発火（非アクティブ時）
  syncGlobalHotkeys();
  $('qbSummary').onclick = () => sendInstruction('これまでの会話全体のあらすじを400字程度で要約してください。時系列で簡潔に。', { summary: true });
  $('qbTimer').onclick = toggleTimer;
  $('qbBgm').onclick = toggleBgm;
  $('qbEars').onclick = toggleEars;
  $('qbName').onclick = setAiName;
  $('btnSend').onclick = send;
  $('btnStop').onclick = () => abortCtrl && abortCtrl.abort();
  searchBox.addEventListener('input', onSearchInput);
  inputEl.addEventListener('keydown', (e) => {
    if (tagSugKey(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    else if (e.key === 'Enter' && !e.shiftKey && config?.sendOnEnter) { e.preventDefault(); send(); }
  });
  // グローバルショートカット
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); newConversation(); }
    else if (k === 'k') { e.preventDefault(); searchBox.focus(); searchBox.select(); }
    else if (k === ',') { e.preventDefault(); openSettings(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    queueDraftSave();
    updateTagSug();
  });
  inputEl.addEventListener('blur', () => setTimeout(hideTagSug, 150));
  inputEl.addEventListener('scroll', hideTagSug);

  // クイックバー
  document.querySelectorAll('.qb[data-instruct]').forEach(b => {
    b.onclick = () => sendInstruction(b.dataset.instruct);
  });
  $('qbVoice').onclick = toggleVoice;
  $('qbNeko').onclick = toggleNeko;
  $('qbSakura').onclick = toggleSakura;
  $('qbInfinite').onclick = toggleInfinite;
  $('qbMood').value = fun.mood;
  $('qbMood').onchange = onMoodChange;
  $('qbMoodUp').onclick = moodUp;
  $('qbTheme').onclick = cycleTheme;
  $('btnPresetSave').onclick = savePreset;
  renderPresetMenu();
  syncPresetState();

  // ドロップダウンメニュー（上部バー・クイックバー共通）
  document.querySelectorAll('.dropdown').forEach(d => {
    const btn = d.querySelector(':scope > button');
    const menu = d.querySelector(':scope > .dropdown-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
      if (willOpen) menu.classList.remove('hidden');
    });
    menu.addEventListener('click', e => {
      if (e.target.closest('.menu-item') && !e.target.closest('select')) menu.classList.add('hidden');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
  });
  initSelectionPopup();
  renderQuickReplies();
  window.speechSynthesis?.getVoices(); // 音声リストを事前読込
  applyTheme();
  refreshStyleOptions();
  if (fun.writingMode) document.body.classList.add('writing-mode');
  syncFunButtons();
  updateAiNameTag();
  if (fun.ears) { document.body.classList.add('cat-ears'); $('qbEars').classList.add('active'); }
  updateTimerDisplay();
  if (fun.sakura) { fun.sakura = false; toggleSakura(); } // 永続化された桜モードを復元
  restorePin();
}

init().catch(e => {
  chatEl.innerHTML = '<div class="msg bot error" style="align-self:center">初期化エラー: ' + esc(String(e)) + '</div>';
});
