// ---------- 一貫性エンジン（小説lint：設定カードと本文の矛盾検出） ----------
import { $ } from './dom.js';
import { api, esc } from './util.js';
import { allCards, allDocs, allSources } from './state.js';
import { listManuscriptScenes } from './manuscript.js';
import { openCardsModal } from './cards.js';

const stripHtml = (h) => String(h || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

// 文分割（句点・改行区切り）
const SENT_RE = /[^。！？!?\n]+[。！？!?]?/g;
const sentencesOf = (text) => String(text || '').match(SENT_RE) || [];

// 「16歳」「160cm」等の数値+単位を抽出。unitは age/cm/kg/km に正規化
const NUM_RE = /(\d+(?:\.\d+)?)\s*(歳|才|cm|kg|km)/gi;
const UNIT_NORM = { '歳': 'age', '才': 'age', 'cm': 'cm', 'kg': 'kg', 'km': 'km' };
function extractFacts(text) {
  const facts = {}; // unit -> Set(values)
  for (const m of String(text || '').matchAll(NUM_RE)) {
    const unit = UNIT_NORM[m[2].toLowerCase()] || UNIT_NORM[m[2]];
    if (!unit) continue;
    (facts[unit] = facts[unit] || new Set()).add(parseFloat(m[1]));
  }
  return facts;
}
const UNIT_LABEL = { age: '歳', cm: 'cm', kg: 'kg', km: 'km' };

// ---- テキスト収集 ----
async function collectTexts() {
  const out = [];
  for (const s of listManuscriptScenes()) {
    out.push({ type: 'scene', id: s.id, label: `${s.chapter} / ${s.title}`, text: s.content || '' });
  }
  const docs = await Promise.all(allDocs.map(async (d) => {
    try {
      const f = await api('/api/documents/' + d.id);
      return { type: 'doc', id: f.id, label: f.title || '無題', text: stripHtml(f.content) };
    } catch { return null; }
  }));
  out.push(...docs.filter(Boolean));
  for (const s of allSources) {
    out.push({ type: 'source', id: s.id, label: s.name || '無題', text: s.content || '' });
  }
  return out;
}

const TYPE_LABEL = { scene: '原稿', doc: 'ドキュメント', source: 'ソース' };
const KIND_LABEL = { character: 'キャラ', world: '世界観', term: '用語', foreshadow: '伏線', style: '文体' };

// ---- チェック実行 ----
export async function runConsistency() {
  const texts = await collectTexts();
  const issues = [];
  const seen = new Set();
  const push = (issue) => {
    const key = [issue.kind, issue.cardId || '', issue.targetId || '', issue.detail || ''].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  // カード名の出現を全文対象でスキャン
  const lowerTexts = texts.map(t => ({ ...t, lower: t.text.toLowerCase(), sents: sentencesOf(t.text) }));
  const cards = allCards.filter(c => c.name && String(c.name).trim().length >= 2);

  for (const c of cards) {
    const name = String(c.name).trim();
    const lname = name.toLowerCase();
    let count = 0;
    const nameSents = []; // {target, sentence}
    for (const t of lowerTexts) {
      // 出現回数
      let idx = t.lower.indexOf(lname);
      while (idx !== -1) { count++; idx = t.lower.indexOf(lname, idx + lname.length); }
      // 名前を含む文
      for (const sent of t.sents) {
        if (sent.toLowerCase().includes(lname)) nameSents.push({ target: t, sentence: sent.trim() });
      }
    }

    // --- 数値矛盾 ---
    const facts = extractFacts(c.content);
    const units = Object.keys(facts);
    if (units.length) {
      for (const { target, sentence } of nameSents) {
        for (const m of sentence.matchAll(NUM_RE)) {
          const unit = UNIT_NORM[m[2].toLowerCase()] || UNIT_NORM[m[2]];
          if (!unit || !facts[unit]) continue;
          const val = parseFloat(m[1]);
          if (facts[unit].has(val)) continue;
          push({
            kind: 'contradiction', severity: 'warn', cardId: c.id, cardName: name, cardKind: c.kind,
            targetType: target.type, targetId: target.id, targetLabel: target.label,
            detail: `${unit === 'age' ? '年齢' : '数値'}矛盾：カードは${[...facts[unit]].join('/')} ${UNIT_LABEL[unit]}、本文は「${m[0].trim()}」`,
            snippet: sentence.slice(0, 120)
          });
        }
      }
    }

    // --- 未登場 ---
    if (count === 0 && c.kind !== 'style') {
      if (c.kind === 'foreshadow') {
        push({
          kind: 'foreshadow', severity: c.resolved ? 'info' : 'warn', cardId: c.id, cardName: name, cardKind: c.kind,
          detail: c.resolved ? '回収済みだが本文に一度も登場しない' : '未回収のまま本文に一度も登場しない（張られていない可能性）'
        });
      } else {
        push({
          kind: 'unused', severity: 'info', cardId: c.id, cardName: name, cardKind: c.kind,
          detail: '設定を書いたが本文に一度も登場しない'
        });
      }
    }
  }

  // --- カード名重複 ---
  const byName = new Map();
  for (const c of allCards) {
    const n = String(c.name || '').trim().toLowerCase();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(c);
  }
  for (const [n, list] of byName) {
    if (list.length > 1) {
      for (const c of list) {
        push({
          kind: 'duplicate', severity: 'warn', cardId: c.id, cardName: c.name, cardKind: c.kind,
          detail: `同名カードが${list.length}件ある（${list.map(x => KIND_LABEL[x.kind] || x.kind).join('・')}）`
        });
      }
    }
  }

  // --- 空カード ---
  for (const c of allCards) {
    if (!String(c.name || '').trim() || !String(c.content || '').trim()) {
      push({
        kind: 'empty', severity: 'info', cardId: c.id, cardName: c.name || '（無題）', cardKind: c.kind,
        detail: !String(c.name || '').trim() ? 'カード名が空' : '本文が空'
      });
    }
  }

  // 並び替え: severity warn優先 → kind順
  const KIND_ORDER = { contradiction: 0, foreshadow: 1, duplicate: 2, unused: 3, empty: 4 };
  issues.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  return { issues, texts: lowerTexts.length };
}

// ---- UI ----
const KIND_BADGE = {
  contradiction: ['矛盾', 'var(--danger,#e05555)'],
  foreshadow: ['伏線', 'var(--warn,#d9a03f)'],
  duplicate: ['重複', 'var(--warn,#d9a03f)'],
  unused: ['未登場', 'var(--accent,#5b8def)'],
  empty: ['空', 'var(--text-dim,#888)']
};
const KIND_TITLE = {
  contradiction: '数値・設定の矛盾',
  foreshadow: '伏線の異常',
  duplicate: 'カード名の重複',
  unused: '未登場の設定',
  empty: '空のカード'
};

function jumpTo(issue) {
  if (issue.targetType === 'scene') window.__openScene?.(issue.targetId);
  else if (issue.targetType === 'doc') window.__openDocument?.(issue.targetId);
  else if (issue.targetType === 'source') window.__openSources?.();
  $('consModal')?.classList.add('hidden');
}
function openCard(issue) {
  const c = allCards.find(x => x.id === issue.cardId);
  if (c) openCardsModal(c);
  else openCardsModal();
}

let lastIssues = [];

export function openConsistency() {
  $('consModal').classList.remove('hidden');
  renderConsistency('<p class="hint">チェック中…（原稿・ドキュメント・ソースをスキャン）</p>');
  runConsistency().then(({ issues, texts }) => {
    lastIssues = issues;
    renderConsistency(buildHtml(issues, texts));
    bindIssueButtons();
  }).catch(e => {
    renderConsistency(`<p class="hint">チェックに失敗しました: ${esc(e.message)}</p>`);
  });
}
function renderConsistency(html) { $('consResults').innerHTML = html; }

function buildHtml(issues, texts) {
  const warn = issues.filter(i => i.severity === 'warn').length;
  const info = issues.filter(i => i.severity === 'info').length;
  if (!issues.length) {
    return `<p style="padding:12px">✓ 問題は見つかりませんでした（${texts}テキストをスキャン）</p>`;
  }
  let html = `<div class="cons-summary hint">${texts}テキストをスキャン：要確認 ${warn}件 / 参考 ${info}件</div>`;
  const groups = {};
  for (const i of issues) (groups[i.kind] = groups[i.kind] || []).push(i);
  for (const kind of Object.keys(KIND_TITLE)) {
    const list = groups[kind];
    if (!list) continue;
    const [label, color] = KIND_BADGE[kind];
    html += `<div class="cons-group-title"><span style="color:${color}">●</span> ${KIND_TITLE[kind]}（${list.length}）</div>`;
    for (const i of list.slice(0, 100)) {
      html += `<div class="sr-group cons-item" data-kind="${kind}" data-idx="${issues.indexOf(i)}">
        <div class="sr-head">
          <span class="sr-type">${label}</span>
          <strong class="sr-title"></strong>
          ${i.targetType ? `<span class="hint">${TYPE_LABEL[i.targetType]}：${esc(i.targetLabel || '')}</span>` : ''}
          ${i.targetType ? '<button class="btn-ghost btn-sm cons-jump">開く</button>' : ''}
          <button class="btn-ghost btn-sm cons-card">カード</button>
        </div>
        <div class="sr-snippet"></div>
      </div>`;
    }
    if (list.length > 100) html += `<p class="hint">…他 ${list.length - 100} 件</p>`;
  }
  return html;
}

function bindIssueButtons() {
  const issues = lastIssues;
  document.querySelectorAll('#consResults .cons-item').forEach(el => {
    const idx = +el.dataset.idx;
    const issue = issues[idx];
    if (!issue) return;
    el.querySelector('.sr-title').textContent = issue.cardName;
    el.querySelector('.sr-snippet').textContent =
      (issue.detail ? '⚠ ' + issue.detail + '　' : '') + (issue.snippet ? '「' + issue.snippet + '」' : '');
    const j = el.querySelector('.cons-jump');
    if (j) j.onclick = () => jumpTo(issue);
    el.querySelector('.cons-card').onclick = () => openCard(issue);
  });
}

export function initConsistency() {
  $('btnCloseCons') && ($('btnCloseCons').onclick = () => $('consModal').classList.add('hidden'));
  $('consModal') && $('consModal').addEventListener('click', (e) => {
    if (e.target === $('consModal')) $('consModal').classList.add('hidden');
  });
  $('miConsistency') && ($('miConsistency').onclick = openConsistency);
  $('btnConsRun') && ($('btnConsRun').onclick = openConsistency);
}
