// ---------- Lorebook（キーワード自動注入カード）/ #タグ呼び出し / #タグサジェスト ----------
import { $ } from './dom.js';
import { inputEl } from './dom.js';
import { allCards, current, CARD_KINDS } from './state.js';
import { apiMessages } from './chat.js';
import { effectiveCardIds } from './context.js';

export function lorebookCardsText() {
  if (!allCards.length || !current) return '';
  const recent = apiMessages().slice(-15).map(m => m.content || '').join('\n');
  if (!recent.trim()) return '';
  const already = new Set(effectiveCardIds());
  const matched = [];
  for (const c of allCards) {
    if (already.has(c.id)) continue;
    const kws = String(c.triggers || '').split(/[,、\s]+/).map(s => s.trim()).filter(s => s.length >= 2);
    if (!kws.length) continue;
    if (kws.some(k => recent.includes(k))) {
      matched.push(c);
      if (matched.length >= 8) break;
    }
  }
  if (!matched.length) return '';
  return matched.map(c =>
    `【${CARD_KINDS[c.kind] || '設定'}: ${c.name}（キーワード検出）】\n${c.content}`
  ).join('\n\n');
}

// ---------- #タグ呼び出しカード ----------
function cardTagList(c) {
  return String(c.tags || '').split(/[,、\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
}
function allCardTags() {
  const set = new Set();
  for (const c of allCards) for (const t of cardTagList(c)) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}
// 会話内の #タグ / ##タグ を収集
//   #タグ  : 使った時点以降ずっと有効（その会話内）
//   ##タグ : 直前のユーザーメッセージへの返答のみ有効（一度きり）
function collectHashTags() {
  const persist = new Set(), single = new Set();
  if (!current) return { persist, single };
  const msgs = apiMessages().filter(m => m.role === 'user');
  const re = /(#{1,2})([^\s#、。，,.!?！？「」『』（）()]+)/g;
  msgs.forEach((m, i) => {
    const isLast = i === msgs.length - 1;
    for (const mm of (m.content || '').matchAll(re)) {
      const tag = mm[2].toLowerCase();
      if (mm[1] === '##') { if (isLast) single.add(tag); }
      else persist.add(tag);
    }
  });
  return { persist, single };
}
export function tagCardsText() {
  if (!allCards.length || !current) return '';
  const { persist, single } = collectHashTags();
  const wanted = new Set([...persist, ...single]);
  if (!wanted.size) return '';
  const already = new Set(effectiveCardIds()); // 選択・自動注入済みは重複させない
  const parts = [];
  for (const c of allCards) {
    if (already.has(c.id)) continue;
    const tags = cardTagList(c);
    const isPersist = tags.some(t => persist.has(t));
    const isSingle = !isPersist && tags.some(t => single.has(t));
    if (isPersist || isSingle) {
      const mark = isPersist ? '（#タグ呼び出し）' : '（##タグ・今回のみ）';
      parts.push(`【${CARD_KINDS[c.kind] || '設定'}: ${c.name}${mark}】\n${c.content}`);
    }
  }
  return parts.join('\n\n');
}

// ---------- #タグサジェスト ----------
let tagSugEl = null, tagSugItems = [], tagSugIdx = -1, tagSugRange = null;
function ensureTagSug() {
  if (tagSugEl) return tagSugEl;
  tagSugEl = document.createElement('div');
  tagSugEl.id = 'tagSuggest';
  tagSugEl.className = 'hidden';
  document.body.appendChild(tagSugEl);
  return tagSugEl;
}
export function hideTagSug() {
  if (tagSugEl) tagSugEl.classList.add('hidden');
  tagSugItems = []; tagSugIdx = -1; tagSugRange = null;
}
function renderTagSug() {
  const el = ensureTagSug();
  el.innerHTML = '';
  tagSugItems.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tag-suggest-item' + (i === tagSugIdx ? ' active' : '');
    d.textContent = '#' + t;
    d.onmousedown = (e) => { e.preventDefault(); applyTagSug(t); };
    el.appendChild(d);
  });
  const r = inputEl.getBoundingClientRect();
  el.style.left = Math.max(8, r.left) + 'px';
  el.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  el.style.width = Math.max(200, Math.min(r.width, 340)) + 'px';
  el.classList.remove('hidden');
}
export function updateTagSug() {
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const m = inputEl.value.slice(0, pos).match(/#([^\s#、。，,.!?！？「」『』（）()]*)$/);
  if (!m) { hideTagSug(); return; }
  const prefix = m[1].toLowerCase();
  tagSugItems = allCardTags().filter(t => t.toLowerCase().startsWith(prefix));
  if (!tagSugItems.length) { hideTagSug(); return; }
  tagSugIdx = 0;
  tagSugRange = { start: pos - m[0].length, end: pos };
  renderTagSug();
}
function applyTagSug(tag) {
  if (!tagSugRange) return;
  const v = inputEl.value;
  inputEl.value = v.slice(0, tagSugRange.start) + '#' + tag + ' ' + v.slice(tagSugRange.end);
  hideTagSug();
  inputEl.dispatchEvent(new Event('input'));
  inputEl.focus();
}
export function tagSugKey(e) {
  if (!tagSugEl || tagSugEl.classList.contains('hidden') || !tagSugItems.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    tagSugIdx = (tagSugIdx + (e.key === 'ArrowDown' ? 1 : -1) + tagSugItems.length) % tagSugItems.length;
    renderTagSug();
    return true;
  }
  if ((e.key === 'Tab' || e.key === 'Enter') && !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    applyTagSug(tagSugItems[tagSugIdx]);
    return true;
  }
  if (e.key === 'Escape') { hideTagSug(); return true; }
  return false;
}
