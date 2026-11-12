// ---------- Message rendering / スクロール / 文字数 / エクスポート ----------
import { $, chatEl, inputEl } from './dom.js';
import { esc, icon, appConfirm, appAlert, downloadFile } from './util.js';
import { current, fun } from './state.js';
import { saveConversation } from './conversations.js';
import { regenerate, branchFrom, instructFrom, appendToMemo, runCompletion, captureSnapshot } from './chat.js';
import { adoptToManuscript } from './manuscript.js';
import { sendTextToDocument } from './documents.js';
import { saveStyle } from './ai-tools.js';
import { toggleSpeak } from './features.js';
import { selectedCardsText } from './context.js';
import { nekoifyOutput } from './util.js';

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
export function clearChat() {
  if (msgObserver) { msgObserver.disconnect(); msgObserver = null; }
  chatEl.innerHTML = '';
}

export function renderMessage(m) {
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

export function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = '<div class="content"></div>';
  chatEl.appendChild(div);
  scrollChat();
  return div;
}
export function addBotMsg(loading = true) {
  const el = addMsg('bot', '');
  if (loading) {
    el.classList.add('thinking');
    el.querySelector('.content').innerHTML = '<em>生成中…</em>';
  }
  return el;
}
export function addSceneDivider(m) {
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

// Markdown→HTML（DOMPurifyでサニタイズ。未読込時は生HTMLにフォールバック）
export function mdRender(text) {
  const html = marked.parse(text);
  return window.DOMPurify ? DOMPurify.sanitize(html) : html;
}
export function renderBotContent(el, text, reasoning) {
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

// 会話をその時点まで巻き戻して再描画
export function rerenderChat() {
  clearChat();
  if (current) for (const m of current.messages) renderMessage(m);
  updateCharCount();
  scrollChat(true);
}

// 「ここからやり直し」: 指定メッセージ以降を全て削除して巻き戻す
export async function rewindTo(msgObj, el) {
  if (!current) return;
  const idx = current.messages.indexOf(msgObj);
  if (idx < 0) return;
  const n = current.messages.length - idx;
  const label = msgObj.role === 'user' ? 'この指示と以降の全てのやり取り' : 'この応答と以降の全てのやり取り';
  if (!(await appConfirm(`${label}（${n}件）を削除して、その時点に巻き戻しますか？`))) return;
  captureSnapshot('巻き戻し前');
  if (msgObj.role === 'user') {
    // ユーザー発言: 指示文を入力欄に戻して修正できるようにする
    inputEl.value = msgObj.content || '';
    inputEl.dispatchEvent(new Event('input'));
    current.messages.length = idx;
    rerenderChat();
    saveConversation();
    inputEl.focus();
  } else {
    // AI応答: その応答以降を削除し、直前のユーザー発言への応答を即再生成
    current.messages.length = idx;
    rerenderChat();
    saveConversation();
    await runCompletion();
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
export function addUserActions(el, msgObj) {
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
  mk('やり直し', 'refresh', () => rewindTo(msgObj, el), 'この指示と以降を削除して入力欄に戻す（修正して送り直せる）');
  mk('削除', 'close', async () => {
    if (await appConfirm('このメッセージを削除しますか？（以降の会話には影響しません）')) removeMessage(msgObj, el);
  });
  el.appendChild(actions);
}

export function addBotActions(el, msgObj, msgIndex) {
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
  mk('ここからやり直し', 'refresh', () => rewindTo(msgObj, el), 'この応答と以降を削除して再生成');
  mk('読み上げ', 'volume', () => toggleSpeak(msgObj.content), 'この応答を音声で読み上げ');
  mk('原稿', 'book', () => adoptToManuscript(msgObj.content, { src: 'ai' }), 'この応答を原稿ペインに追加');
  mk('原稿:新シーン', 'book', () => adoptToManuscript(msgObj.content, { newScene: true, src: 'ai' }), '新しいシーンを作ってこの応答を追加');
  mk('ドキュメント', 'edit', () => sendTextToDocument(msgObj.content), 'リッチテキストドキュメントに送る（同名なら追記）');
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

// ---------- スクロール制御 ----------
function isNearBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
}
export function scrollChat(force) {
  if (force || isNearBottom()) chatEl.scrollTop = chatEl.scrollHeight;
}
export function initScrollWatch() {
  chatEl.addEventListener('scroll', () => {
    $('btnScrollBottom').classList.toggle('hidden', isNearBottom());
  });
  $('btnScrollBottom').onclick = () => scrollChat(true);
}

// ---------- 文字数カウント ----------
export function updateCharCount() {
  if (!current) { $('charCount').textContent = ''; return; }
  let chars = 0;
  for (const m of current.messages) {
    if (m.role === 'user' || m.role === 'assistant') chars += (m.content || '').length;
  }
  const sheets = Math.ceil(chars / 400);
  $('charCount').textContent = `${chars.toLocaleString()}字 ≒ 原稿用紙${sheets}枚`;
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
export function exportDoc() {
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
