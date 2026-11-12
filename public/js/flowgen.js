// ---------- 流れ生成：指示キューをトークン数でチャンク化し、連続で原稿に流し込む ----------
import { $ } from './dom.js';
import { appAlert, esc } from './util.js';
import { buildRequestBody, composeSystemPrompt } from './chat.js';
import { msAppendGenerated } from './manuscript.js';

const LS_KEY = 'flowgen_items';
let flowCtrl = null;
let flowBound = false;
let flowItems = []; // {text, tokens, status}

function loadItems() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => x && typeof x.text === 'string') : [];
  } catch { return []; }
}
function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(flowItems.map(({ text, tokens }) => ({ text, tokens }))));
  } catch {}
}

// ---------- DOM ----------
function addRow(text = '', tokens = 1000) {
  const wrap = $('flowItems');
  const row = document.createElement('div');
  row.className = 'flow-row';
  row.innerHTML = `
    <input class="flow-text" placeholder="指示（例: 牛を倒すところを描いて）" value="${esc(text)}">
    <input class="flow-tokens" type="number" min="50" step="50" value="${tokens}" title="この項目の目安トークン数">
    <span class="flow-status hint"></span>
    <button class="flow-del" title="削除">×</button>`;
  row.querySelector('.flow-del').onclick = () => {
    const i = flowItems.findIndex(it => it.el === row);
    if (i >= 0) flowItems.splice(i, 1);
    row.remove(); persist();
  };
  const it = { text, tokens, status: '', el: row };
  flowItems.push(it);
  row.querySelector('.flow-text').addEventListener('input', () => { it.text = row.querySelector('.flow-text').value; persist(); });
  row.querySelector('.flow-tokens').addEventListener('input', () => { it.tokens = parseInt(row.querySelector('.flow-tokens').value, 10) || 1000; persist(); });
  wrap.appendChild(row);
  return it;
}
function setStatus(it, st) {
  it.status = st;
  const el = it.el?.querySelector('.flow-status');
  if (el) el.textContent = { run: '生成中…', done: '完了', fail: '失敗', skip: 'スキップ' }[st] || '';
}
function log(msg) {
  const el = $('flowLog');
  if (el) el.textContent += msg + '\n';
}
function updateProgress() {
  const total = flowItems.length || 1;
  const done = flowItems.filter(i => i.status === 'done' || i.status === 'fail' || i.status === 'skip').length;
  const bar = $('flowBar');
  if (bar) bar.style.width = Math.round(done / total * 100) + '%';
  const st = $('flowStatusText');
  if (st) st.textContent = `${done}/${total} 項目`;
}

export function openFlowGen() {
  const modal = $('flowModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (!flowBound) {
    flowBound = true;
    $('btnFlowAdd')?.addEventListener('click', () => addRow());
    $('btnFlowRun')?.addEventListener('click', runFlow);
    $('btnFlowCancel')?.addEventListener('click', () => flowCtrl?.abort());
    const close = () => { modal.classList.add('hidden'); persist(); };
    $('btnCloseFlow')?.addEventListener('click', close);
    $('btnFlowClose')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  }
  // 項目を復元（初回のみ。実行後の再オープンでも現在の一覧を保持）
  if (!$('flowItems')?.children.length) {
    const saved = loadItems();
    if (saved.length) saved.forEach(x => addRow(x.text, x.tokens));
    else addRow('牛を倒すところを描いて', 1000);
  }
}

// ---------- チャンク分割 ----------
function chunkItems(items, chunkSize) {
  const chunks = [];
  let cur = [], sum = 0;
  for (const it of items) {
    const tk = Math.max(50, it.tokens || 1000);
    if (cur.length && sum + tk > chunkSize) { chunks.push(cur); cur = []; sum = 0; }
    cur.push({ ...it, tokens: tk });
    sum += tk;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// `===n===` マーカーで本文を分割
function parseParts(text, n) {
  const map = new Map();
  const re = /^===\s*(\d+)\s*===\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text))) {
    const num = parseInt(m[1], 10);
    if (num >= 1 && num <= n) marks.push({ num, start: m.index + m[0].length, markStart: m.index });
  }
  marks.sort((a, b) => a.num - b.num);
  for (let i = 0; i < marks.length; i++) {
    if (map.has(marks[i].num)) continue;
    const end = i + 1 < marks.length ? marks[i + 1].markStart : text.length;
    map.set(marks[i].num, text.slice(marks[i].start, end).trim());
  }
  return map;
}

async function callFlowApi(body) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: flowCtrl ? flowCtrl.signal : undefined
  });
  if (!res.ok) {
    let err = res.statusText;
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(res.status + ': ' + err);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function runFlow() {
  const items = flowItems.filter(it => (it.text || '').trim());
  if (!items.length) { appAlert('指示項目がありません'); return; }
  const chunkSize = Math.max(500, parseInt($('flowChunk')?.value, 10) || 5000);
  const chapter = ($('flowChapter')?.value || '').trim();
  const chunks = chunkItems(items, chunkSize);
  flowCtrl = new AbortController();
  $('btnFlowRun').disabled = true;
  $('btnFlowCancel')?.classList.remove('hidden');
  $('flowProgress')?.classList.remove('hidden');
  $('flowLog').textContent = '';
  items.forEach(it => setStatus(it, 'wait'));
  updateProgress();
  log(`全${items.length}項目を${chunks.length}チャンクに分割（チャンク上限 ${chunkSize.toLocaleString()}トークン）`);

  const sys = composeSystemPrompt() +
    '\n\n※これは原稿への一括執筆タスクです。指定された各項目を、物語として自然につながる本文にしてください。各項目の分量は指定トークン数を目安にしてください。';

  for (let ci = 0; ci < chunks.length; ci++) {
    if (flowCtrl.signal.aborted) { log('中断しました'); break; }
    const chunk = chunks[ci];
    const totalTok = chunk.reduce((a, b) => a + b.tokens, 0);
    log(`── チャンク${ci + 1}/${chunks.length}: ${chunk.length}項目・約${totalTok.toLocaleString()}トークン ──`);
    chunk.forEach(it => setStatus(it, 'run'));
    const list = chunk.map((it, i) => `===${i + 1}=== ${it.text.trim()}（約${it.tokens.toLocaleString()}トークン）`).join('\n');
    const user =
      '以下の項目を順番に小説本文として執筆してください。\n\n' +
      '【出力形式・厳守】\n' +
      '各項目の本文は必ず `===数字===` だけの行で始めてください。次のマーカー行までがその項目の本文です。' +
      'マーカー行自体は本文に含めないでください。項目間の説明・あいさつ・まとめ・区切り線などは一切出力しないでください。\n\n' +
      '【項目】\n' + list;
    const body = buildRequestBody([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], false);
    body.max_tokens = Math.min(32000, Math.max(1000, Math.round(totalTok * 1.4) + 500));
    let text = '';
    try {
      text = await callFlowApi(body);
    } catch (e) {
      log(`チャンク${ci + 1} 生成失敗: ${e.message || e}`);
      chunk.forEach(it => setStatus(it, 'fail'));
      updateProgress();
      continue;
    }
    const parts = parseParts(text, chunk.length);
    if (!parts.size && text.trim()) {
      // マーカーが取れなかった場合：全文を先頭項目のシーンとして保存
      msAppendGenerated({ chapterTitle: chapter, sceneTitle: chunk[0].text.trim().slice(0, 24), content: text, src: 'flowgen' });
      chunk.forEach(it => setStatus(it, 'done'));
      log(`  → マーカー未検出のため1シーンにまとめて保存`);
    } else {
      let got = 0;
      chunk.forEach((it, i) => {
        const content = parts.get(i + 1) || '';
        if (content.trim()) {
          msAppendGenerated({ chapterTitle: chapter, sceneTitle: it.text.trim().slice(0, 24), content, src: 'flowgen' });
          setStatus(it, 'done'); got++;
        } else {
          setStatus(it, 'fail');
        }
      });
      log(`  → ${got}/${chunk.length}項目を原稿に追加`);
    }
    updateProgress();
  }
  $('btnFlowRun').disabled = false;
  $('btnFlowCancel')?.classList.add('hidden');
  flowCtrl = null;
  updateProgress();
  persist();
}
