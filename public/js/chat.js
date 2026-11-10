// ---------- Send / Completion engine ----------
import { $, chatEl, inputEl, sendBtn, stopBtn, tokenBadgeEl } from './dom.js';
import { esc, appAlert, appPrompt, nekoifyInput, api } from './util.js';
import { config, current, fun, busy, abortCtrl, allSources, setBusyState, setAbortCtrl, setPendingStyle, draftKey } from './state.js';
import { addMsg, addBotMsg, addUserActions, addBotActions, addSceneDivider, renderBotContent, scrollChat, updateCharCount } from './messages.js';
import { saveConversation, refreshConvList, openConversation } from './conversations.js';
import { selectedCardsText, maybeAutoCompress, rawStartIndex, compressAgedMemories } from './context.js';
import { lorebookCardsText, tagCardsText, hideTagSug } from './tags.js';
import { openSettings } from './settings.js';
import { logChars } from './ai-tools.js';
import { syncFunButtons } from './features.js';
import { refreshRealCtx } from './realtoken.js';

// 価格目安（AIのべりすと API: 1000tokあたり 0.275/2.25ルミナ ≈ ¥0.33/¥2.79）
const PRICE_IN_PER_TOKEN = 0.00033, PRICE_OUT_PER_TOKEN = 0.00279;

// ---------- 変数置換（{{user}} {{ai}} {{char}} {{title}} {{date}}） ----------
export function applyVars(text) {
  if (!text) return text;
  const aiName = fun.aiName || 'AI';
  return String(text)
    .replace(/\{\{\s*user\s*\}\}/g, 'ユーザー')
    .replace(/\{\{\s*ai\s*\}\}/g, aiName)
    .replace(/\{\{\s*char\s*\}\}/g, aiName)
    .replace(/\{\{\s*title\s*\}\}/g, current?.title || '無題')
    .replace(/\{\{\s*date\s*\}\}/g, new Date().toLocaleDateString('ja-JP'));
}

function composeSystemPrompt() {
  const p = current?.profile || {};
  const parts = [];
  if (p.systemPrompt?.trim()) parts.push(applyVars(p.systemPrompt.trim()));
  if (p.stylePreset) parts.push(applyVars('文体指定: ' + p.stylePreset));
  if (p.plot?.trim()) parts.push('【プロット】\n' + applyVars(p.plot.trim()));
  if (p.summary?.trim()) parts.push('【これまでのあらすじ（圧縮済み）】\n' + applyVars(p.summary.trim()));
  if (config.params.hybridMemory !== false) {
    const mems = current?.profile?.memories;
    if (Array.isArray(mems) && mems.length) parts.push('【長期記憶（英語圧縮メモ・時系列）】\n' + mems.join('\n'));
  }
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
export { composeSystemPrompt };

// APIに送るメッセージ（scene等の特殊roleを除外）
export function apiMessages() {
  return current.messages.filter(m => m.role === 'user' || m.role === 'assistant');
}
// AIが実際に読む会話履歴（メモリ設定: params.historyLimit 件まで。0=全て）
export function contextMessages() {
  const msgs = apiMessages();
  if (config.params.hybridMemory === false) {
    const n = parseInt(config.params.historyLimit) || 0;
    return n > 0 ? msgs.slice(-n) : msgs;
  }
  // ハイブリッド記憶: 直近1往復は生テキスト、_mem印の付いた古い交換は英語圧縮メモリ側で供給。
  // まだ圧縮されていない古いメッセージは生のまま残す（圧縮完了までコンテキストを失わないため）
  const start = rawStartIndex(msgs);
  return msgs.slice(0, start).filter(m => !m._mem).concat(msgs.slice(start));
}

export function apiKeyMissing() { return !(config.hasApiKey || config.noAuth); }
export function apiWarnMissing() { if (apiKeyMissing()) { openSettings(); appAlert('APIキーを設定してください（ローカルLLMの場合は「APIキー不要」にチェック）'); return true; } return false; }

export async function send() {
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

let pendingSummary = false;

export async function runCompletion() {
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

  setAbortCtrl(new AbortController());
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
      if (pendingStyle) { msgObj._style = true; setPendingStyle(false); }
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
    setAbortCtrl(null);
    pendingSummary = false;
    setPendingStyle(false);
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
    setTimeout(() => { if (current === conv) { maybeAutoCompress(); compressAgedMemories(conv); } }, 800);
    inputEl.focus();
  }
}

export async function regenerate(botEl) {
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

export function setBusy(b) {
  setBusyState(b);
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
export { updateTokenBadge };

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
export async function sendInstruction(text, opts = {}) {
  if (!current || busy) return;
  if (apiWarnMissing()) return;
  captureSnapshot('指示前');
  if (opts.summary) pendingSummary = true;
  if (opts.style) setPendingStyle(true);
  const content = `【指示】${text}\n\n（直前の応答についての指示です。指示に従って修正・続きを生成してください）`;
  const msgObj = { role: 'user', content };
  current.messages.push(msgObj);
  const uEl = addMsg('user', content);
  addUserActions(uEl, msgObj);
  fun.infiniteCount = 0;
  await runCompletion();
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
export { insertSceneDivider, insertChapterDivider };

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
export { captureSnapshot };

// あらすじを文脈メモに追加
export function appendToMemo(text) {
  if (!current) return;
  current.profile = current.profile || {};
  const memo = current.profile.worldMemo || '';
  const block = `\n\n【自動生成あらすじ ${new Date().toLocaleString('ja-JP')}】\n${text}`;
  current.profile.worldMemo = (memo + block).slice(0, 19000);
  $('pWorldMemo').value = current.profile.worldMemo;
  saveConversation().then(() => appAlert('文脈メモに追加しました'));
}

export async function instructFrom(targetMsg) {
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
export async function altVersion() {
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

export async function branchFrom(msgObj) {
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

// config.params → API body へのマッピング
const PARAM_MAP = {
  temperature: 'temperature', topP: 'top_p', maxTokens: 'max_tokens',
  repPen: 'repetition_penalty', freqPen: 'frequency_penalty', presPen: 'presence_penalty',
  topK: 'top_k', topA: 'top_a', minP: 'min_p', tailfree: 'tailfree', typicalP: 'typical_p',
  seed: 'seed', badwords: 'badwords', stoptokens: 'stoptokens'
};
const STRING_PARAMS = new Set(['badwords', 'stoptokens']);
export function buildRequestBody(messages, stream) {
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
