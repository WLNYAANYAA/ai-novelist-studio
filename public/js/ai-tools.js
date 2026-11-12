// ---------- AIツール（パイプライン/別案/感情分析/自動収集/文体/執筆ログ） ----------
import { $ } from './dom.js';
import { api, esc, appAlert, appPrompt, showResultModal } from './util.js';
import { current, busy, setPendingStyle, CARD_KINDS, allCards } from './state.js';
import { sendInstruction, composeSystemPrompt, contextMessages, apiWarnMissing, setBusy, captureSnapshot } from './chat.js';
import { callApiOnce, convTranscript } from './context.js';
import { addBotMsg, renderBotContent, addBotActions, updateCharCount, mdRender, scrollChat } from './messages.js';
import { saveConversation, renderConvList } from './conversations.js';
import { refreshCards } from './cards.js';
import { msScene } from './manuscript.js';

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
    $('resultTitleText').textContent = `別案候補（${n}案）`;
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
      $('resultTitleText').textContent = '感情曲線';
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
    $('resultTitleText').textContent = '感情曲線（緊張度 1-10）';
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
      $('resultTitleText').textContent = '自動収集';
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
    $('resultTitleText').textContent = `自動収集（${items.length}件）— カードに追加できます`;
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
  $('resultTitleText').textContent = '執筆ログ';
  $('resultBody').innerHTML =
    `<p class="hint">直近14日合計: <strong>${total.toLocaleString()}</strong>字 ／ 今月: <strong>${monthTotal.toLocaleString()}</strong>字</p>` + rows;
  $('resultModal').classList.remove('hidden');
}

// ---------- 文体分析（パラメータ抽出） ----------
const STYLE_RUBRIC = `あなたは文体分析の専門家です。以下の小説本文サンプルを読み、文体を定量的に分析してください。

【出力形式（この形式のみ。前置き・説明・Markdown装飾は不要）】

【パラメータ】
1. 平均文長: 全角文字数の平均と傾向
2. 文長のばらつき: 短文と長文の混ざり方
3. 一文の最大長の目安
4. 読点（、）の頻度: おおよその個数/100字
5. 句点（。）の頻度: おおよその個数/100字
6. 改行頻度: 段落の平均文字数と改行の入れ方の傾向
7. 段落の長さ: 一段落あたりの平均文字数
8. 漢字率: おおよその割合（%）
9. ひらがな率: おおよその割合（%）
10. カタカナ率: おおよその割合（%）
11. 文語/口語のバランス
12. 敬語の使用頻度と種類
13. 常体/敬体の区分
14. 視点: 一人称/三人称/その他
15. 地の文とセリフの比率
16. セリフの文末表現の傾向（〜だ・〜である・〜なの等）
17. 体言止めの使用頻度
18. 擬音語・擬態語の頻度と種類の傾向
19. 語彙の多様性: 同じ言葉の繰り返し具合
20. 語彙レベル: やさしい/標準/硬い/文学的
21. 比喩・装飾表現の頻度
22. 全体のテンポ感: 速い/標準/ゆったり
23. 会話文の特徴: タグの有無・心の声の表現方法
24. 避けるべき要素: この文体に合わない表現

【文体指示文】
（上記分析を踏まえ、この文体をAIが再現できるよう、具体的な指示文を日本語で6〜10文。文長・リズム・語彙・改行・セリフの扱いなどを明確に指示すること）`;

let styleDirective = '';
let styleFullText = '';

export function openStyleAnalyzer() {
  $('styleModal').classList.remove('hidden');
  if (!$('styleSample').value) {
    const sc = msScene();
    if (sc?.content) $('styleSample').value = sc.content.slice(0, 5000);
  }
  $('styleResult').innerHTML = '';
  $('btnStyleSavePreset').classList.add('hidden');
  $('btnStyleSaveCard').classList.add('hidden');
  $('btnStyleSaveDNA')?.classList.add('hidden');
  $('styleStatus').textContent = '';
}

export function fillStyleSample(from) {
  let text = '';
  if (from === 'scene') text = msScene()?.content || '';
  else {
    if (!current) { appAlert('会話を開いてください'); return; }
    for (let i = current.messages.length - 1; i >= 0; i--) {
      if (current.messages[i].role === 'assistant') { text = current.messages[i].content || ''; break; }
    }
  }
  if (!text.trim()) { appAlert('読み込める本文がありません'); return; }
  $('styleSample').value = text.slice(0, 5000);
}

export async function runStyleAnalysis() {
  const sample = ($('styleSample').value || '').trim();
  if (!sample) { appAlert('サンプル本文を入力してください'); return; }
  if (apiWarnMissing()) return;
  const btn = $('btnStyleAnalyze');
  btn.disabled = true;
  $('styleStatus').textContent = '分析中…（APIを1回呼び出します）';
  $('styleResult').innerHTML = '';
  // 機械計測（jReadability: MeCab+UniDicがあれば実計測、なければ近似）
  let metricsBlock = '', metricsNote = '';
  try {
    const r = await api('/api/readability', { method: 'POST', body: JSON.stringify({ text: sample.slice(0, 20000) }) });
    if (r?.metrics) {
      const m = r.metrics;
      metricsBlock = `<div class="hint" style="margin-bottom:6px">【機械計測（jReadability${r.approx ? '・近似' : ''}）】読みやすさスコア: <strong>${r.score ?? '—'}</strong>（高いほど易しい文体）</div>` +
        `<div class="history-content" style="max-height:140px;margin-bottom:10px">文数 ${m.sentences} · 平均文長 ${m.avgSentenceLen}字 · 文長のばらつきσ${m.sentLenStd} · 漢字率 ${m.kanjiPct}% · ひらがな ${m.hiraganaPct}% · カタカナ ${m.katakanaPct}% · 読点 ${m.commaPer100}/100字 · 句点 ${m.periodPer100}/100字 · 改行 ${m.newlinePer100}/100字 · 漢語系 ${m.kangoTokenPct}% / 和語系 ${m.wagoTokenPct}%</div>`;
      metricsNote = '\n\n【機械計測値（参考データ。この値を踏まえて評価すること）】\n' + JSON.stringify(m) + (r.approx ? '（形態素解析なしの近似値）' : '');
    }
  } catch {}
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: STYLE_RUBRIC },
      { role: 'user', content: sample.slice(0, 6000) + metricsNote }
    ]);
    styleFullText = (text || '').trim();
    const m = styleFullText.match(/【文体指示文】\s*([\s\S]*)$/);
    styleDirective = m ? m[1].trim() : '';
    const paramsPart = m ? styleFullText.slice(0, m.index).trim() : styleFullText;
    $('styleResult').innerHTML = metricsBlock +
      `<div class="hint" style="margin-bottom:6px">【文体指示文】（プリセット/カードに保存される内容）</div>` +
      `<div class="history-content" style="max-height:180px;margin-bottom:10px">${esc(styleDirective || styleFullText)}</div>` +
      `<details><summary class="hint" style="cursor:pointer">パラメータ詳細（${(paramsPart.match(/\n\d+\./g) || []).length || '?'}項目）</summary>` +
      `<div class="history-content" style="max-height:260px;margin-top:6px;white-space:pre-wrap">${esc(paramsPart)}</div></details>`;
    $('btnStyleSavePreset').classList.remove('hidden');
    $('btnStyleSaveCard').classList.remove('hidden');
    $('btnStyleSaveDNA')?.classList.remove('hidden');
    $('styleStatus').textContent = '';
  } catch (e) {
    $('styleStatus').textContent = '';
    appAlert('分析に失敗しました: ' + (e.message || e));
  } finally { btn.disabled = false; }
}

export async function saveStyleAnalysisAsPreset() {
  if (!styleDirective && !styleFullText) return;
  await saveStyle(styleDirective || styleFullText);
}

export async function saveStyleAnalysisAsCard() {
  if (!styleDirective && !styleFullText) return;
  const name = await appPrompt('カード名を入力', '文体プロファイル');
  if (name === null) return;
  await api('/api/cards', {
    method: 'POST',
    body: JSON.stringify({
      name: name.trim() || '文体プロファイル',
      kind: 'style',
      content: (styleDirective ? '【文体指示文】\n' + styleDirective + '\n\n' : '') + '【分析パラメータ】\n' + styleFullText.slice(0, 8000)
    })
  });
  await refreshCards();
  appAlert('カードに追加しました。「この会話で使うカード」から選択すると文体指入文が注入されます');
}

// ---------- 文体DNA（分析結果を全会話のシステムプロンプトに自動注入） ----------
export function styleDnaText() {
  try { return localStorage.getItem('style_dna') || ''; } catch { return ''; }
}
export function saveStyleDNA() {
  const t = (styleDirective || styleFullText || '').trim();
  if (!t) { appAlert('先に文体分析を実行してください'); return; }
  localStorage.setItem('style_dna', t.slice(0, 4000));
  appAlert('文体DNAを保存しました。以降の全会話のシステムプロンプトに自動注入されます（設定で解除は「文体DNAを解除」）');
}
export function clearStyleDNA() {
  localStorage.removeItem('style_dna');
  appAlert('文体DNAを解除しました');
}
export function hasStyleDNA() { return !!styleDnaText(); }

// ---------- 読者シミュレーター ----------
const READERS = [
  ['📖 ライトノベル読者（10〜20代・娯楽性とテンポ重視）', 'あなたはライトノベルを毎月何冊も買う10〜20代の読者です。面白さ・キャラの魅力・テンポを最優先で評価し、正直な感想を述べます。'],
  ['✒️ 文学青年（30代・文体とテーマ重視）', 'あなたは純文学からエンタメまで読み漁る30代の読者です。文体の美しさ・テーマの深さ・余白の味わいを重視して評価します。'],
  ['🖊️ 書籍編集者（プロの目・売れるかどうか）', 'あなたは小説編集者です。読者の心を掴むか・続きが読みたくなるか・市場で売れるかを冷静かつ的確に評価します。']
];
export async function readerSimulate() {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  // 対象テキスト: 原稿シーン優先、なければ直近のAI応答
  let srcLabel = '', text = '';
  const sc = msScene();
  if (sc && (sc.content || '').trim().length > 80) {
    srcLabel = `原稿「${sc.title}」`; text = sc.content;
  } else {
    for (let i = current.messages.length - 1; i >= 0; i--) {
      const m = current.messages[i];
      if (m.role === 'assistant' && (m.content || '').length > 80) { srcLabel = '直近のAI応答'; text = m.content; break; }
    }
  }
  if (!text.trim()) { appAlert('分析対象の本文がありません'); return; }
  setBusy(true);
  try {
    const sample = text.slice(0, 6000);
    const jobs = READERS.map(([label, persona]) =>
      callApiOnce([
        { role: 'system', content: `${persona}\n\n以下の小説本文を読み、率直な読者としての感想を300字以内で述べてください。良い点・物足りない点・続きを読みたいかどうかを含めてください。` },
        { role: 'user', content: `【${srcLabel}】\n${sample}` }
      ]).then(r => ({ label, text: (r.text || '').trim() })).catch(e => ({ label, text: '（失敗: ' + e.message + '）' }))
    );
    const results = await Promise.all(jobs);
    const cols = results.map(r =>
      `<div class="reader-col"><h4 style="margin:0 0 8px;font-size:14px">${esc(r.label)}</h4><div class="history-content" style="white-space:pre-wrap;font-size:13px;line-height:1.8">${esc(r.text)}</div></div>`
    ).join('');
    showResultModal(`読者シミュレーター — ${srcLabel}`, `<div class="reader-grid">${cols}</div>`);
  } finally { setBusy(false); }
}

// ---------- ブレインダンプ → 構成案 ----------
export function openBrainDump() { $('dumpModal').classList.remove('hidden'); $('dumpInput').focus(); }
export async function runBrainDump() {
  const dump = ($('dumpInput').value || '').trim();
  if (!dump) { appAlert('アイデアを書き殴ってください'); return; }
  if (apiWarnMissing()) return;
  const btn = $('btnDumpRun');
  btn.disabled = true;
  $('dumpStatus').textContent = '構成案を生成中…';
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説の構成作家です。ユーザーのブレインダンプを読み、小説の構成案を3パターン提案してください。各案は「タイトル案/あらすじ3行/3幕構成の要点/この案の強み/この案の弱み」の形式で。全体で1200字以内。' },
      { role: 'user', content: dump.slice(0, 8000) }
    ]);
    $('dumpModal').classList.add('hidden');
    showResultModal('構成案（3パターン）', `<div class="history-content" style="white-space:pre-wrap;line-height:1.9">${esc(text || '（応答なし）')}</div>`);
  } catch (e) {
    $('dumpStatus').textContent = '';
    appAlert('生成に失敗しました: ' + (e.message || e));
  } finally { btn.disabled = false; $('dumpStatus').textContent = ''; }
}

// ---------- 伏線トラッカー（回収管理） ----------
export async function foreshadowTracker() {
  if (!current) { appAlert('会話を選択してください'); return; }
  const fws = allCards.filter(c => c.kind === 'foreshadow');
  if (!fws.length) { appAlert('伏線カードがありません。カード管理で種別「伏線」のカードを作成するか、「伏線・用語を自動収集」を使ってください'); return; }
  const unresolved = fws.filter(c => !c.resolved);
  const resolved = fws.filter(c => c.resolved);
  const row = (c) => `
    <div class="collect-item" data-id="${esc(c.id)}">
      <span class="card-kind">伏線</span> <strong>${esc(c.name)}</strong>
      ${c.resolved ? '<span class="hint">（回収済）</span>' : ''}
      <div class="hint" style="margin:4px 0">${esc((c.content || '').slice(0, 160))}</div>
      <button class="btn-ghost btn-sm" data-act="${c.resolved ? 'unresolve' : 'resolve'}">${c.resolved ? '未回収に戻す' : '回収済みにする'}</button>
    </div>`;
  showResultModal(`伏線トラッカー — 未回収 ${unresolved.length}件 / 回収済 ${resolved.length}件`,
    (unresolved.length ? '<h4 style="margin:8px 0">未回収</h4>' + unresolved.map(row).join('') : '<p class="hint">未回収の伏線はありません</p>') +
    (resolved.length ? '<h4 style="margin:16px 0 8px">回収済み</h4>' + resolved.map(row).join('') : ''));
  $('resultBody').querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      const id = b.closest('.collect-item').dataset.id;
      const card = allCards.find(c => String(c.id) === id);
      if (!card) return;
      await api('/api/cards/' + card.id, { method: 'PUT', body: JSON.stringify({ resolved: b.dataset.act === 'resolve' }) });
      await refreshCards();
      foreshadowTracker();
    };
  });
}
