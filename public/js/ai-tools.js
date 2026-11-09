// ---------- AIツール（パイプライン/別案/感情分析/自動収集/文体/執筆ログ） ----------
import { $ } from './dom.js';
import { api, esc, appAlert, appPrompt } from './util.js';
import { current, busy, setPendingStyle, CARD_KINDS } from './state.js';
import { sendInstruction, composeSystemPrompt, contextMessages, apiWarnMissing, setBusy, captureSnapshot } from './chat.js';
import { callApiOnce, convTranscript } from './context.js';
import { addBotMsg, renderBotContent, addBotActions, updateCharCount, mdRender, scrollChat } from './messages.js';
import { saveConversation, renderConvList } from './conversations.js';
import { refreshCards } from './cards.js';

// ---------- 執筆パイプライン ----------
const PIPELINE_STEPS = [
  ['推敲', '直前の応答を推敲して、より自然で読みやすい文章に書き直してください。'],
  ['文体統一', '直前の応答の文体を、この会話全体の文体・トーンに統一してください。'],
  ['誤字脱字チェック', '直前の応答の誤字・脱字・表記ゆれ・文法の誤りをチェックし、修正した全文を出力してください。']
];
export async function runPipeline() {
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
export async function genVariants(n = 3) {
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
export async function analyzeEmotion() {
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
export async function collectTerms() {
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
function customStyles() {
  try { return JSON.parse(localStorage.getItem('custom_styles') || '[]'); } catch { return []; }
}
export function refreshStyleOptions() {
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
export async function saveStyle(content) {
  const name = await appPrompt('文体プリセット名を入力', 'マイ文体');
  if (name === null) return;
  const styles = customStyles();
  styles.push({ name: name.trim() || 'マイ文体', text: content });
  localStorage.setItem('custom_styles', JSON.stringify(styles));
  refreshStyleOptions();
  appAlert('文体プリセットに保存しました。「この会話」の文体プリセットから選べます');
}
export async function extractStyle() {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  setPendingStyle(true);
  await sendInstruction('これまでの会話で使われている文体を分析し、再現可能な「文体プロファイル」を箇条書きで作成してください（語彙の傾向・文末表現・リズム・描写の癖・会話文の特徴・避けるべき表現など）。');
}

// ---------- 執筆ログ ----------
function wlog() {
  try { return JSON.parse(localStorage.getItem('writing_log') || '{}'); } catch { return {}; }
}
export function logChars(n) {
  if (!n) return;
  const log = wlog();
  const d = new Date().toISOString().slice(0, 10);
  log[d] = (log[d] || 0) + n;
  localStorage.setItem('writing_log', JSON.stringify(log));
}
export function showWritingLog() {
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
