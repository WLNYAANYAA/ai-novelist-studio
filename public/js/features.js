// ---------- お楽しみ機能・UI補助（音声/桜/猫/テーマ/タイマー/BGM等） ----------
import { $, chatEl, inputEl, convTitleEl } from './dom.js';
import { appAlert, appPrompt, esc } from './util.js';
import { current, fun, saveFun } from './state.js';
import { clearChat, renderMessage, scrollChat, mdRender } from './messages.js';
import { sendInstruction, applyVars } from './chat.js';

// ---------- 音声入力 ----------
let recognition = null;
let listening = false;
export function toggleVoice() {
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
export function toggleSakura() {
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
export function toggleNeko() {
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
export function toggleInfinite() {
  fun.infinite = !fun.infinite;
  if (fun.infinite) fun.infiniteCount = 0;
  $('qbInfinite').classList.toggle('active', fun.infinite);
  $('qbInfinite').title = fun.infinite ? '無限生成ON（5回まで自動継続）' : '無限生成（5回まで自動で続きを生成）';
}

export function syncFunButtons() {
  $('qbNeko').classList.toggle('active', fun.neko);
  $('qbSakura').classList.toggle('active', fun.sakura);
  $('qbInfinite').classList.toggle('active', fun.infinite);
  $('btnExitWriting').classList.toggle('hidden', !fun.writingMode);
}

// ---------- テーマ ----------
export function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  fun.theme = order[(order.indexOf(fun.theme) + 1) % order.length];
  localStorage.setItem('ui_theme', fun.theme);
  applyTheme();
}
export function applyTheme() {
  const el = document.documentElement;
  if (fun.theme === 'auto') delete el.dataset.theme;
  else el.dataset.theme = fun.theme;
  $('qbTheme').textContent = 'テーマ:' + { auto: '自動', light: 'ライト', dark: 'ダーク' }[fun.theme];
}

// ---------- 機嫌 ----------
export function onMoodChange() {
  fun.mood = $('qbMood').value;
  localStorage.setItem('fun_mood', fun.mood);
}
export async function moodUp() {
  if (!current) return;
  await sendInstruction('がんばって！いつもありがとう！');
}

// ---------- サイドバー開閉（状態を永続化） ----------
export function toggleSidebar() {
  const collapsed = document.documentElement.dataset.sidebar === 'collapsed';
  if (collapsed) delete document.documentElement.dataset.sidebar;
  else document.documentElement.dataset.sidebar = 'collapsed';
  localStorage.setItem('sidebar_collapsed', collapsed ? '0' : '1');
}

// ---------- 履歴モーダル ----------
export function openHistoryModal() {
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
const timerState = { running: false, elapsed: 0, startedAt: 0, timerId: null };
export function toggleTimer() {
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
export function updateTimerDisplay() {
  const sec = Math.floor((timerState.elapsed + (timerState.running ? Date.now() - timerState.startedAt : 0)) / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  $('timerDisplay').textContent = `${m}:${s}`;
}

// ---------- BGM（環境音：雨） ----------
let audioCtx = null, rainGain = null;
export function toggleBgm() {
  const btn = $('qbBgm');
  fun.bgm = !fun.bgm;
  btn.classList.toggle('active', fun.bgm);
  if (fun.bgm && !audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { fun.bgm = false; btn.classList.remove('active'); appAlert('この環境ではBGMに対応していません'); return; }
    audioCtx = new AC();
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
export function toggleEars() {
  fun.ears = !fun.ears;
  localStorage.setItem('fun_ears', fun.ears ? '1' : '0');
  document.body.classList.toggle('cat-ears', fun.ears);
  $('qbEars').classList.toggle('active', fun.ears);
}

// ---------- AIの名前 ----------
export async function setAiName() {
  const name = await appPrompt('AIの名前を入力（空で解除）', fun.aiName);
  if (name === null) return;
  fun.aiName = name.trim();
  localStorage.setItem('fun_ainame', fun.aiName);
  updateAiNameTag();
}
export function updateAiNameTag() {
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
export function showOutline() {
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
export { quickReplies };
export function renderQuickReplies() {
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
export async function addQuickReply() {
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
export function toggleSpeak(text) {
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

// ---------- 選択範囲への指示 ----------
let selPopup = null;
export function initSelectionPopup() {
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

// ---------- ウィンドウ最前列固定 ----------
export async function togglePin() {
  if (!window.winAPI) return;
  const next = !(await window.winAPI.getAlwaysOnTop());
  window.winAPI.setAlwaysOnTop(next);
  localStorage.setItem('win_always_on_top', next ? '1' : '0');
  $('qbPin').classList.toggle('active', next);
}
export async function restorePin() {
  if (!window.winAPI) return;
  const want = localStorage.getItem('win_always_on_top') === '1';
  if (want) {
    window.winAPI.setAlwaysOnTop(true);
    $('qbPin')?.classList.add('active');
  }
}

// ---------- 執筆モード ----------
export function toggleWritingMode() {
  fun.writingMode = !fun.writingMode;
  localStorage.setItem('fun_writingmode', fun.writingMode ? '1' : '0');
  document.body.classList.toggle('writing-mode', fun.writingMode);
  syncFunButtons();
}
