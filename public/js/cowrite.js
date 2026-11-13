// ---------- AI共著執筆：原稿へのインライン提案（採用/却下/別案） ----------
import { $ } from './dom.js';
import { appAlert } from './util.js';
import { allCards, config } from './state.js';
import { callApiOnce } from './context.js';
import { msScene, msCommitAiEdit, listManuscriptScenes } from './manuscript.js';

let pending = null; // { mode:'insert'|'replace', start, end, params }
let generating = false;

const el = (id) => $(id);

function editor() { return el('msEditor'); }

// 選択範囲 or カーソル位置を判定
function captureTarget() {
  const ta = editor();
  if (!ta) return null;
  const v = ta.value || '';
  const s = ta.selectionStart ?? v.length;
  const e = ta.selectionEnd ?? s;
  if (e > s) return { mode: 'replace', start: s, end: e, sel: v.slice(s, e), before: v.slice(0, s), after: v.slice(e) };
  return { mode: 'insert', start: s, end: e, sel: '', before: v.slice(0, s), after: v.slice(e) };
}

function sceneEntry() {
  const sc = msScene();
  if (!sc) return null;
  const flat = listManuscriptScenes();
  return flat.find(x => x.id === sc.id) || { id: sc.id, title: sc.title, chapter: '', content: sc.content || '' };
}

// 関連カード：シーン本文中に名前が出るカード＋文体カード
function relatedCards(text) {
  const named = allCards
    .filter(c => c.name && c.name.length >= 2 && text.includes(c.name))
    .slice(0, 8);
  const style = allCards.filter(c => c.kind === 'style').slice(0, 3);
  const seen = new Set();
  return [...named, ...style].filter(c => !seen.has(c.id) && seen.add(c.id));
}

function buildPrompt(t, instr) {
  const entry = sceneEntry();
  const sc = msScene();
  const flat = listManuscriptScenes();
  const idx = flat.findIndex(x => x.id === sc?.id);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  const fullText = entry?.content || '';
  const cards = relatedCards(fullText)
    .map(c => `【${c.name}】（${c.kind || '設定'}）\n${(c.content || '').slice(0, 500)}`)
    .join('\n\n')
    .slice(0, 8000);
  const styleText = config?.stylePreset || '';

  const ctx = [
    entry ? `【章】${entry.chapter || ''}` : '',
    entry ? `【シーン】${entry.title || ''}` : '',
    styleText ? `【文体指定】${styleText}` : '',
    prev ? `【直前のシーン「${prev.title}」末尾】\n${(prev.content || '').slice(-1000)}` : '',
    next ? `【次のシーン「${next.title}」冒頭】\n${(next.content || '').slice(0, 400)}` : '',
    cards ? `【関連する設定・登場人物】\n${cards}` : ''
  ].filter(Boolean).join('\n\n');

  let task;
  if (t.mode === 'replace') {
    task = [
      `【書き換え対象（選択範囲）】\n${t.sel}`,
      `【選択範囲より前の本文（末尾）】\n${t.before.slice(-1500)}`,
      `【選択範囲より後の本文（冒頭）】\n${t.after.slice(0, 600)}`,
      instr
        ? `【指示】${instr}`
        : '【指示】選択範囲を書き換えてください。内容・事実関係は変えず、文体を整えてください。'
    ].join('\n\n');
  } else {
    task = [
      `【本文（カーソルより前・末尾）】\n${t.before.slice(-2500)}`,
      t.after ? `【本文（カーソルより後・冒頭）】\n${t.after.slice(0, 600)}` : '',
      instr
        ? `【指示】${instr}`
        : '【指示】カーソル位置の直後に続く本文を執筆してください。'
    ].filter(Boolean).join('\n\n');
  }
  return { system: 'あなたは小説の共著者です。ユーザーの指示に従い、本文のみを出力してください。説明・前置き・後書き・Markdown記法は一切不要です。指定がなければ、直前の文体・視点・トーンを維持してください。', user: `${ctx}\n\n${task}` };
}

async function suggest() {
  const t = captureTarget();
  if (!t) { appAlert('原稿エディタが見つかりません'); return; }
  const sc = msScene();
  if (!sc) { appAlert('シーンを選択してください'); return; }
  const instr = (el('msAiInstr')?.value || '').trim();
  pending = { ...t, instr, sceneId: sc.id };
  const { system, user } = buildPrompt(t, instr);
  generating = true;
  setBusyUI(true);
  showPreview('生成中…', '');
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    const out = (text || '').trim();
    if (!out) { showPreview('（応答が空でした）', ''); return; }
    showPreview(out, t.mode === 'replace' ? '選択範囲の書き換え案' : '続きを執筆する案');
  } catch (e) {
    showPreview('生成失敗: ' + (e.message || e), '');
  } finally {
    generating = false;
    setBusyUI(false);
  }
}

function showPreview(text, modeLabel) {
  const p = el('msAiPreview');
  if (!p) return;
  p.classList.remove('hidden');
  el('msAiPrevText').textContent = text;
  el('msAiMode').textContent = modeLabel || '';
}

function hidePreview() {
  el('msAiPreview')?.classList.add('hidden');
  pending = null;
}

function setBusyUI(b) {
  const btn = el('btnMsAiSuggest');
  if (btn) btn.disabled = b;
}

function accept() {
  if (!pending) return;
  if (msScene()?.id !== pending.sceneId) {
    appAlert('シーンが切り替わったため適用できません。もう一度提案を生成してください');
    hidePreview();
    return;
  }
  const text = (el('msAiPrevText')?.textContent || '').trim();
  if (!text || text.startsWith('生成失敗') || text === '（応答が空でした）' || text === '生成中…') return;
  // 選択範囲モードは前後に改行を補う（単語の途中に食い込まないよう）
  let out = text;
  if (pending.mode === 'replace') {
    const needPre = pending.before && !/\s$/.test(pending.before) && !/^[\s、。！？…」』）】]/.test(out) ? '\n' : '';
    const needPost = pending.after && !/^\s/.test(pending.after) && !/[\s、。！？…「『（【]$/.test(out) ? '\n' : '';
    out = needPre + out + needPost;
  }
  msCommitAiEdit(pending.start, pending.end, out);
  hidePreview();
  const st = el('msStatus');
  if (st) { st.textContent = 'AI案を採用しました'; setTimeout(() => { if (st.textContent === 'AI案を採用しました') st.textContent = ''; }, 2500); }
}

export function initCowrite() {
  el('btnMsAiSuggest') && (el('btnMsAiSuggest').onclick = () => { if (!generating) suggest(); });
  el('msAiInstr') && el('msAiInstr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !generating) { e.preventDefault(); suggest(); }
  });
  el('btnMsAiAccept') && (el('btnMsAiAccept').onclick = accept);
  el('btnMsAiAlt') && (el('btnMsAiAlt').onclick = () => { if (!generating) suggest(); });
  el('btnMsAiReject') && (el('btnMsAiReject').onclick = hidePreview);
}
