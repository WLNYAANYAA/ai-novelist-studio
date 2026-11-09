// ---------- Context budget & auto cards / 圧縮 ----------
import { config, current, allCards, cardsVersion, busy, CARD_KINDS } from './state.js';
import { apiMessages, contextMessages, composeSystemPrompt, buildRequestBody, setBusy, updateTokenBadge } from './chat.js';
import { clearChat, renderMessage } from './messages.js';
import { saveConversation } from './conversations.js';
import { appAlert, fmtTok } from './util.js';

export function estContextTokens() {
  if (!current) return 0;
  let chars = (composeSystemPrompt() || '').length;
  for (const m of contextMessages()) chars += (m.content || '').length;
  return Math.ceil(chars / 1.5);
}
export function contextBudget() { return Math.max(10000, parseInt(config.params.ctxBudget) || 120000); }

// 手動選択カード＋関連カード自動選択（結果をキャッシュ：送信ごとの全走査を防ぐ）
let cardIdsCache = { key: '', val: [] };
export function effectiveCardIds() {
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

export function selectedCardsText() {
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
export async function callApiOnce(messages) {
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

export function convTranscript(maxChars = 45000) {
  let s = '';
  for (const m of apiMessages()) {
    s += `${m.role === 'user' ? '【ユーザー】' : '【AI】'}\n${(m.content || '').slice(0, 3000)}\n\n`;
    if (s.length > maxChars) break;
  }
  return s.slice(0, maxChars);
}

// コンテキスト圧縮（古い会話をAI要約に置き換え）
export async function compressContext() {
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

export function maybeAutoCompress() {
  if (busy || !current) return;
  if (config.params.autoCompress === false) return;
  if (estContextTokens() > contextBudget()) compressContext();
}
