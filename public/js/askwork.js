// ---------- 作品に聞く：原稿・カード・ドキュメント・ソースを横断するAI Q&A ----------
import { $ } from './dom.js';
import { api, appAlert, esc } from './util.js';
import { allCards, allDocs, allSources } from './state.js';
import { callApiOnce } from './context.js';
import { listManuscriptScenes } from './manuscript.js';
import { openCardsModal } from './cards.js';

const stripHtml = (h) => String(h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|li|blockquote|pre)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n').trim();

let corpus = null;   // { items: Map<key, item>, prompt: string }
let asking = false;

// 作品データを収集してプロンプト化。各項目に S番号 を振り、AIに引用させる
async function buildCorpus() {
  const items = new Map();
  const parts = [];
  let n = 0;
  const add = (type, id, label, text, jump) => {
    const key = 'S' + (++n);
    const body = String(text || '').slice(0, 1400);
    if (!body.trim()) return;
    items.set(key, { type, id, label, jump });
    parts.push(`【${key}】${label}\n${body}`);
  };

  // 原稿（最重要なので多めに）
  const scenes = listManuscriptScenes();
  for (const s of scenes.slice(0, 50)) {
    add('scene', s.id, `原稿「${s.chapter} / ${s.title}」`, s.content, () => window.__openScene?.(s.id));
  }
  // カード
  for (const c of allCards.slice(0, 40)) {
    add('card', c.id, `カード「${c.name}」（${c.kind || '設定'}）`, c.content, () => openCardsModal(c));
  }
  // ドキュメント（本文を取得。多すぎる場合は先頭25件）
  const docFull = await Promise.all(allDocs.slice(0, 25).map(async (d) => {
    try { return await api('/api/documents/' + d.id); } catch { return null; }
  }));
  for (const f of docFull.filter(Boolean)) {
    add('doc', f.id, `ドキュメント「${f.title || '無題'}」`, stripHtml(f.content), () => window.__openDocument?.(f.id));
  }
  // ソース
  for (const s of allSources.slice(0, 20)) {
    add('source', s.id, `ソース「${s.name || '無題'}」`, s.content, () => window.__openSources?.());
  }

  // 総量が大きすぎる場合は末尾（ソース側）から削る
  let prompt = parts.join('\n\n');
  const MAX = 60000;
  if (prompt.length > MAX) {
    // 頭から MAX 以内に収まる項目だけ残す（原稿優先）
    const kept = [];
    let acc = 0;
    for (const p of parts) { if (acc + p.length > MAX) break; acc += p.length; kept.push(p); }
    prompt = kept.join('\n\n');
    // items から残らなかったキーを除去
    const keptKeys = new Set([...prompt.matchAll(/【(S\d+)】/g)].map(m => m[1]));
    for (const k of [...items.keys()]) if (!keptKeys.has(k)) items.delete(k);
  }
  return { items, prompt };
}

function setStatus(msg) { const el = $('askStatus'); if (el) el.textContent = msg; }

function renderAnswer(text) {
  const box = $('askAnswer');
  box.textContent = '';
  // 【S12】トークンを出典チップに変換
  const re = /【(S\d+)】/g;
  let last = 0, m;
  const frag = document.createDocumentFragment();
  const pushText = (t) => { if (t) frag.appendChild(document.createTextNode(t)); };
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    const key = m[1];
    const item = corpus?.items.get(key);
    if (item) {
      const btn = document.createElement('button');
      btn.className = 'ask-src';
      btn.textContent = '📄 ' + item.label.replace(/「.*?」/, '');
      btn.title = item.label + ' を開く';
      btn.onclick = () => { item.jump?.(); $('askModal')?.classList.add('hidden'); };
      frag.appendChild(btn);
    } else {
      frag.appendChild(document.createTextNode(m[0]));
    }
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  box.appendChild(frag);
}

async function ask() {
  const q = ($('askQuery')?.value || '').trim();
  if (!q) { appAlert('質問を入力してください'); return; }
  if (asking) return;
  asking = true;
  $('askSend').disabled = true;
  try {
    // 毎回最新データで再構築（原稿・カードは頻繁に更新されるためキャッシュしない）
    setStatus('作品データを収集中…');
    corpus = await buildCorpus();
    setStatus('AIが作品全体を読んでいます…');
    $('askAnswer').textContent = '';
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたはこの作品の編集者であり熱心な読者です。以下の作品データ（原稿・カード・ドキュメント・ソース）だけを根拠に質問へ答えてください。回答は日本語で簡潔に。根拠となる箇所には必ず対応する【S番号】を文中に含めてください（例：【S3】によると…）。作品データに無いことは「データにありません」と正直に言い、推測する場合は「推測ですが」と明記してください。' },
      { role: 'user', content: `【作品データ】\n${corpus.prompt}\n\n【質問】\n${q}` }
    ]);
    setStatus('');
    renderAnswer((text || '').trim() || '（応答がありませんでした）');
  } catch (e) {
    setStatus('');
    $('askAnswer').textContent = '失敗: ' + (e.message || e);
  } finally {
    asking = false;
    $('askSend').disabled = false;
  }
}

export function openAskWork() {
  $('askModal')?.classList.remove('hidden');
  $('askQuery')?.focus();
  setStatus('');
}

export function initAskWork() {
  $('miAskWork') && ($('miAskWork').onclick = openAskWork);
  $('btnCloseAsk') && ($('btnCloseAsk').onclick = () => $('askModal').classList.add('hidden'));
  $('askModal') && $('askModal').addEventListener('click', (e) => {
    if (e.target === $('askModal')) $('askModal').classList.add('hidden');
  });
  $('askSend') && ($('askSend').onclick = ask);
  $('askQuery') && $('askQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ask(); }
  });
}
