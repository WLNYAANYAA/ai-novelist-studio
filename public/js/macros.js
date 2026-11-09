// ---------- クイックマクロ（ホットキー） ----------
import { $, searchBox } from './dom.js';
import { appAlert } from './util.js';
import { newConversation } from './conversations.js';
import { openSettings } from './settings.js';
import { openCardsModal, openCardPicker } from './cards.js';
import { compressContext } from './context.js';
import { sendInstruction, altVersion } from './chat.js';
import { scrollChat } from './messages.js';
import { runPipeline, genVariants, analyzeEmotion, collectTerms, extractStyle } from './ai-tools.js';
import { showOutline, openHistoryModal, togglePin, cycleTheme, toggleWritingMode, toggleVoice, quickReplies } from './features.js';

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
export let macros = [];
try { macros = JSON.parse(localStorage.getItem('hotkey_macros') || '[]'); } catch { macros = []; }
export let macroPendingKey = null, macroRecArmed = false;

export function comboFromEvent(e) {
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
export async function syncGlobalHotkeys() {
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
export function runMacro(m) {
  const a = m.action || {};
  if (a.type === 'command') runHotkeyCommand(a.cmd);
  else if (a.type === 'instruction' && a.text) sendInstruction(a.text);
}
export function fireHotkey(combo) {
  const m = macros.find(x => x.keys === combo);
  if (m) runMacro(m);
}

export function openMacroModal() {
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
export function resetMacroForm() {
  macroPendingKey = null; macroRecArmed = false;
  $('macroKeyLabel').textContent = '（未設定）';
  $('macroAction').value = '';
  $('macroCustom').value = '';
}
export function armMacroRec() {
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
export function saveMacro() {
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
