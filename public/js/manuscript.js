// ---------- Manuscript（原稿ペイン） ----------
import { $ } from './dom.js';
import { api, appPrompt, appConfirm, appAlert, appDialog, downloadFile, showResultModal, esc } from './util.js';
import { allCards, current, config } from './state.js';
import { callApiOnce } from './context.js';
import { Chart, registerables } from './vendor.bundle.js';

let manuscript = { title: '無題', chapters: [] };
let msSel = { chapterId: null, sceneId: null };
let msSaveTimer = null;
const msUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function loadManuscript() {
  try { manuscript = await api('/api/manuscript'); }
  catch { manuscript = { title: '無題', chapters: [] }; }
  if (!Array.isArray(manuscript.chapters)) manuscript.chapters = [];
  msSel.chapterId = manuscript.chapters[0]?.id || null;
  msSel.sceneId = manuscript.chapters[0]?.scenes[0]?.id || null;
  const goalEl = $('msGoal');
  if (goalEl) goalEl.value = manuscript.goal || '';
  renderMsTree();
  updateMsEditor();
}

// ---------- 執筆統計 ----------
function msTotalChars() {
  let n = 0;
  for (const ch of manuscript.chapters) for (const sc of ch.scenes) n += (sc.content || '').length;
  return n;
}
export function updateMsStats() {
  const el = $('msStats');
  if (!el) return;
  const total = msTotalChars();
  const goal = parseInt(manuscript.goal, 10) || 0;
  const today = new Date().toISOString().slice(0, 10);
  manuscript._stats = manuscript._stats || { date: '', dayChars: 0, totalChars: 0, days: {} };
  manuscript._stats.days = manuscript._stats.days || {};
  if (manuscript._stats.date !== today) {
    manuscript._stats.date = today;
    manuscript._stats.dayChars = 0;
  }
  const diff = total - (manuscript._stats.totalChars || 0);
  if (diff > 0) manuscript._stats.dayChars += diff;
  manuscript._stats.totalChars = total;
  manuscript._stats.days[today] = manuscript._stats.dayChars;
  // 90日より古い履歴は削除
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(manuscript._stats.days)) {
    if (d < cutoff) delete manuscript._stats.days[d];
  }
  const pct = goal ? Math.min(100, Math.round(total / goal * 100)) : 0;
  el.textContent = `総計 ${total.toLocaleString()}字`
    + (goal ? ` / 目標 ${goal.toLocaleString()}字 (${pct}%)` : '')
    + ` · 本日 +${manuscript._stats.dayChars.toLocaleString()}字`;
  const bar = $('msProgressBar');
  if (bar) {
    bar.style.width = goal ? pct + '%' : '0%';
    bar.parentElement.style.display = goal ? '' : 'none';
  }
}
export function msSetGoal(v) {
  manuscript.goal = String(v || '').trim();
  updateMsStats();
  scheduleMsSave();
}

// ---------- 執筆グラフ（chart.js） ----------
let chartRegistered = false;
let msChart = null;
export function openWritingChart() {
  const days = manuscript._stats?.days || {};
  const labels = Object.keys(days).sort().slice(-30);
  if (!labels.length) { appAlert('まだグラフにできる執筆データがありません'); return; }
  showResultModal('日別の執筆文字数（直近' + labels.length + '日）', '<canvas id="msChartCanvas" height="240"></canvas>');
  const canvas = $('msChartCanvas');
  if (!canvas) return;
  if (!chartRegistered) {
    Chart.register(...registerables);
    chartRegistered = true;
  }
  if (msChart) { msChart.destroy(); msChart = null; }
  msChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels.map(d => d.slice(5)),
      datasets: [{
        label: '文字数',
        data: labels.map(d => days[d]),
        backgroundColor: 'rgba(0,0,0,.35)',
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { color: '#888' }, grid: { color: 'rgba(128,128,128,.15)' } },
        x: { ticks: { color: '#888', maxRotation: 60 }, grid: { display: false } },
      },
    },
  });
}
function scheduleMsSave() {
  clearTimeout(msSaveTimer);
  msSaveTimer = setTimeout(flushMsSave, 600);
}
function flushMsSave() {
  clearTimeout(msSaveTimer);
  msSaveTimer = null;
  api('/api/manuscript', { method: 'PUT', body: JSON.stringify(manuscript) })
    .catch(() => { const el = $('msStatus'); if (el) el.textContent = '原稿の保存に失敗しました'; });
}
// タブを閉じる・バックグラウンド化する直前にデバウンス分を確定保存
window.addEventListener('pagehide', flushMsSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushMsSave(); });
export { scheduleMsSave };
function msChapter() { return manuscript.chapters.find(c => c.id === msSel.chapterId); }
export function msScene() {
  const ch = msChapter();
  return ch ? ch.scenes.find(s => s.id === msSel.sceneId) : null;
}

// ---------- シーン一覧・シーン紐付け ----------
export function listManuscriptScenes() {
  const out = [];
  for (const ch of manuscript.chapters) {
    for (const sc of ch.scenes) {
      out.push({ id: sc.id, title: sc.title, chapter: ch.title, content: sc.content || '' });
    }
  }
  return out;
}
// 会話に紐付いたシーン（current.sceneId）を解決
export function resolveLinkedScene() {
  const sid = current?.sceneId;
  if (!sid) return null;
  for (const ch of manuscript.chapters) {
    const sc = ch.scenes.find(s => s.id === sid);
    if (sc) return { scene: sc, chapter: ch };
  }
  return null;
}
// システムプロンプト用：紐付きシーンの情報（末尾1200字）
export function linkedSceneContext() {
  const r = resolveLinkedScene();
  if (!r) return null;
  const tail = (r.scene.content || '').trim().slice(-1200);
  return { chapterTitle: r.chapter.title, title: r.scene.title, tail };
}
// 検索結果からのジャンプ用：シーンを選択して原稿ペインを開く
window.__openScene = (sceneId) => {
  for (const ch of manuscript.chapters) {
    if (ch.scenes.some(s => s.id === sceneId)) {
      msSel.chapterId = ch.id; msSel.sceneId = sceneId;
      renderMsTree(); updateMsEditor();
      $('manuscriptPane')?.classList.remove('hidden');
      $('qbManuscript')?.classList.add('active');
      return true;
    }
  }
  return false;
};

// プロファイルパネルの選択肢生成用（循環import回避でwindow経由）
window.__msScenes = () => listManuscriptScenes().map(s => ({ id: s.id, label: `${s.chapter} / ${s.title}` }));
function renderMsTree() {
  const el = $('msTree');
  if (!el) return;
  updateMsStats();
  el.innerHTML = '';
  if (!manuscript.chapters.length) {
    el.innerHTML = '<p class="hint" style="padding:8px">まだ章がありません。「＋章」で作成するか、AI応答の「原稿」ボタンで自動作成できます。</p>';
    return;
  }
  for (const ch of manuscript.chapters) {
    const chEl = document.createElement('div');
    chEl.className = 'ms-ch' + (ch.id === msSel.chapterId ? ' sel' : '');
    chEl.textContent = ch.title;
    chEl.onclick = () => {
      msSel.chapterId = ch.id;
      msSel.sceneId = ch.scenes[0]?.id || null;
      renderMsTree(); updateMsEditor();
    };
    el.appendChild(chEl);
    for (const sc of ch.scenes) {
      const scEl = document.createElement('div');
      scEl.className = 'ms-sc' + (sc.id === msSel.sceneId ? ' sel' : '');
      const cnt = document.createElement('span');
      cnt.className = 'ms-count';
      cnt.textContent = sc.content ? `${sc.content.length}字` : '';
      if (sc.aiSnippets?.length) {
        const badge = document.createElement('span');
        badge.className = 'ms-ai-badge';
        badge.textContent = 'AI';
        badge.title = `AI生成テキスト ${sc.aiSnippets.length}件`;
        scEl.appendChild(badge);
      }
      scEl.appendChild(document.createTextNode(sc.title));
      scEl.appendChild(cnt);
      scEl.onclick = () => { msSel.chapterId = ch.id; msSel.sceneId = sc.id; renderMsTree(); updateMsEditor(); };
      el.appendChild(scEl);
    }
  }
}

// ---------- 伏線チェック ----------
export async function msForeshadowCheck() {
  const fws = allCards.filter(c => c.kind === 'foreshadow');
  if (!fws.length) {
    appAlert('伏線カードがありません。カード管理で種別「伏線」のカードを作成してください。');
    return;
  }
  const sc = msScene();
  const sceneText = sc
    ? `【対象シーン】${sc.title}\n${(sc.content || '').slice(0, 4000)}`
    : '（シーンが未選択です。伏線の全体状況を整理してください）';
  const list = fws.map(c =>
    `- ${c.name}${c.resolved ? '（回収済）' : '（未回収）'}: ${(c.content || '').slice(0, 200)}`
  ).join('\n');
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説の編集者です。伏線カードの一覧と現在のシーンを読み、未回収の伏線のうちこのシーンで回収・匂わせるべきものを提案してください。各伏線について、回収の仕方の具体案を1〜2文で箇条書きにしてください。' },
      { role: 'user', content: `【伏線カード】\n${list}\n\n${sceneText}` }
    ]);
    await appDialog(`伏線チェック結果\n\n${(text || '').slice(0, 3000) || '（応答がありませんでした）'}`, { okText: '閉じる' });
  } catch (e) {
    appAlert('伏線チェックに失敗しました: ' + (e.message || e));
  }
}
function updateMsEditor() {
  const sc = msScene();
  $('msSceneTitle').value = sc ? sc.title : '';
  $('msEditor').value = sc ? sc.content : '';
}
export function toggleManuscriptPane() {
  const pane = $('manuscriptPane');
  pane.classList.toggle('hidden');
  $('qbManuscript')?.classList.toggle('active', !pane.classList.contains('hidden'));
}

// ---------- 縦書きプレビュー ----------
export function toggleMsVertical() {
  const pane = $('manuscriptPane');
  const on = pane.classList.toggle('ms-vertical');
  localStorage.setItem('ms_vertical', on ? '1' : '0');
  $('btnMsVertical')?.classList.toggle('active', on);
}
export function restoreMsVertical() {
  if (localStorage.getItem('ms_vertical') === '1') {
    $('manuscriptPane')?.classList.add('ms-vertical');
    $('btnMsVertical')?.classList.add('active');
  }
}
export function adoptToManuscript(text, opts = {}) {
  const { openPane = true, newScene = false } = opts;
  const t = (text || '').trim();
  if (!t) return;
  if (!manuscript.chapters.length) {
    manuscript.chapters.push({ id: msUid(), title: '第1章', scenes: [] });
  }
  // 会話に対象シーンが紐付いていればそこへ追加（選択も同期）
  const linked = resolveLinkedScene();
  if (linked) {
    msSel.chapterId = linked.chapter.id;
    msSel.sceneId = linked.scene.id;
  }
  let ch = msChapter() || manuscript.chapters[0];
  msSel.chapterId = ch.id;
  if (newScene || !ch.scenes.length || !ch.scenes.some(s => s.id === msSel.sceneId)) {
    const sc = { id: msUid(), title: `シーン${ch.scenes.length + 1}`, content: '' };
    ch.scenes.push(sc);
    msSel.sceneId = sc.id;
  }
  const sc = msScene();
  sc.content = (sc.content ? sc.content.replace(/\s+$/, '') + '\n\n' : '') + t;
  if (opts.src === 'ai') recordAiSnippet(sc, t);
  renderMsTree();
  updateMsEditor();
  scheduleMsSave();
  if (openPane) {
    $('manuscriptPane').classList.remove('hidden');
    $('qbManuscript')?.classList.add('active');
  }
  $('msStatus').textContent = `「${sc.title}」に追加しました`;
  setTimeout(() => { if ($('msStatus').textContent.startsWith('「')) $('msStatus').textContent = ''; }, 2500);
}

// ---------- AI挿入テキストの記録（出所追跡） ----------
function recordAiSnippet(sc, text) {
  sc.aiSnippets = sc.aiSnippets || [];
  // 除去時に本文から確実に見つけられるよう全文を保持（シーン上限と同じ100000字まで）
  sc.aiSnippets.push({ ts: Date.now(), text: String(text).slice(0, 100000) });
  if (sc.aiSnippets.length > 50) sc.aiSnippets = sc.aiSnippets.slice(-50);
}

// ---------- 流れ生成などからの一括シーン追加 ----------
// chapterTitle 指定時はその名前の章を探し、無ければ新規作成。未指定なら選択中の章（無ければ先頭/新規）
export function msAppendGenerated({ chapterTitle = '', sceneTitle = '', content = '', src = 'ai', activate = true } = {}) {
  const t = (content || '').trim();
  if (!t) return null;
  if (!manuscript.chapters.length) {
    manuscript.chapters.push({ id: msUid(), title: '第1章', scenes: [] });
  }
  let ch = null;
  const want = (chapterTitle || '').trim();
  if (want) ch = manuscript.chapters.find(c => c.title === want);
  if (!ch) ch = want ? null : msChapter();
  if (!ch) {
    ch = { id: msUid(), title: want || `第${manuscript.chapters.length + 1}章`, scenes: [] };
    manuscript.chapters.push(ch);
  }
  const sc = { id: msUid(), title: (sceneTitle || 'シーン').slice(0, 40), content: '' };
  ch.scenes.push(sc);
  sc.content = t;
  if (src) recordAiSnippet(sc, t);
  if (activate) {
    msSel.chapterId = ch.id;
    msSel.sceneId = sc.id;
    renderMsTree();
    updateMsEditor();
    $('manuscriptPane')?.classList.remove('hidden');
    $('qbManuscript')?.classList.add('active');
  }
  return sc;
}
// バッチ追加後に一度だけUIを更新する用
export function msRefresh() {
  renderMsTree();
  updateMsEditor();
  scheduleMsSave();
}

// ---------- シーンをAIに書かせる ----------
export async function msAiWrite() {
  const sc = msScene();
  if (!sc) { appAlert('シーンを選択してください（ツリーから選択）'); return; }
  const ch = msChapter();
  const hasContent = (sc.content || '').trim().length > 0;
  let lengthHint = '';
  if (!hasContent) {
    const v = await appPrompt(`シーン「${sc.title}」の生成文字数の目安`, '1500');
    if (v === null) return;
    lengthHint = (v || '').trim();
  } else if (!(await appConfirm(`シーン「${sc.title}」の末尾に続きを書きます。よろしいですか？`))) return;

  const btn = $('btnMsWrite');
  if (btn) btn.disabled = true;
  $('msStatus').textContent = 'AIが執筆中…';
  try {
    // 文脈収集：章/シーン情報・直前シーン末尾・選択カード・文体指定
    const flat = manuscript.chapters.flatMap(c => c.scenes);
    const idx = flat.findIndex(s => s.id === sc.id);
    const prev = idx > 0 ? flat[idx - 1] : null;
    const prevTail = prev ? `【直前のシーン「${prev.title}」末尾】\n${(prev.content || '').slice(-1200)}` : '';
    const tail = hasContent ? `【このシーンの既存本文（末尾）】\n${(sc.content || '').slice(-2500)}` : '';

    const selIds = new Set(current?.cardIds || []);
    const cardText = allCards
      .filter(c => selIds.size ? selIds.has(c.id) : true)
      .filter(c => c.content)
      .slice(0, 12)
      .map(c => `【${c.name}】（${c.kind || 'term'}）\n${(c.content || '').slice(0, 700)}`)
      .join('\n\n')
      .slice(0, 9000);

    const styleText = config?.stylePreset || '';
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説家です。指定されたシーンの本文のみを執筆してください。見出し・説明・前置き・Markdown装飾は一切不要で、本文だけを出力してください。文体・視点・トーンは指定があればそれに従い、直前の本文がある場合はその流れを自然に継いでください。' },
      { role: 'user', content: [
        `【章】${ch?.title || ''}`,
        `【シーン】${sc.title}`,
        styleText ? `【文体指定】${styleText}` : '',
        lengthHint ? `【指示】${lengthHint}字程度で執筆してください` : '',
        prevTail,
        tail,
        cardText ? `【設定・登場人物】\n${cardText}` : '',
        hasContent ? '上記の既存本文の直後に続く文章を執筆してください。' : 'このシーンの本文を最初から執筆してください。'
      ].filter(Boolean).join('\n\n') }
    ]);
    const add = (text || '').trim();
    if (!add) { $('msStatus').textContent = '生成結果が空でした'; return; }
    // 生成中にシーンが削除された・ユーザーが本文を編集した場合に備えて再確認
    if (!msChapter()?.scenes.includes(sc)) { $('msStatus').textContent = 'シーンが削除されたため結果を破棄しました'; return; }
    const cur = (sc.content || '').trim();
    sc.content = cur ? cur.replace(/\s+$/, '') + '\n\n' + add : add;
    recordAiSnippet(sc, add);
    renderMsTree();
    updateMsEditor();
    scheduleMsSave();
    $('msStatus').textContent = `「${sc.title}」に${hasContent ? '続きを' : '本文を'}追加しました`;
    setTimeout(() => { if ($('msStatus').textContent.includes('追加しました')) $('msStatus').textContent = ''; }, 3000);
  } catch (e) {
    $('msStatus').textContent = '生成失敗: ' + (e.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}
export async function msAddChapter() {
  const n = manuscript.chapters.length + 1;
  const title = await appPrompt('章名を入力', `第${n}章`);
  if (title === null) return;
  const ch = { id: msUid(), title: title.trim() || `第${n}章`, scenes: [{ id: msUid(), title: 'シーン1', content: '' }] };
  manuscript.chapters.push(ch);
  msSel.chapterId = ch.id; msSel.sceneId = ch.scenes[0].id;
  renderMsTree(); updateMsEditor(); scheduleMsSave();
}
export async function msAddScene() {
  let ch = msChapter() || manuscript.chapters[0];
  if (!ch) return msAddChapter();
  msSel.chapterId = ch.id;
  const sc = { id: msUid(), title: `シーン${ch.scenes.length + 1}`, content: '' };
  ch.scenes.push(sc);
  msSel.sceneId = sc.id;
  renderMsTree(); updateMsEditor(); scheduleMsSave();
}
export async function msDelete() {
  const sc = msScene();
  const ch = msChapter();
  if (sc) {
    if (!(await appConfirm(`シーン「${sc.title}」を削除しますか？`))) return;
    ch.scenes = ch.scenes.filter(s => s.id !== sc.id);
    msSel.sceneId = ch.scenes[0]?.id || null;
  } else if (ch) {
    if (!(await appConfirm(`章「${ch.title}」を削除しますか？`))) return;
    manuscript.chapters = manuscript.chapters.filter(c => c.id !== ch.id);
    msSel.chapterId = manuscript.chapters[0]?.id || null;
    msSel.sceneId = msChapter()?.scenes[0]?.id || null;
  } else return;
  renderMsTree(); updateMsEditor(); scheduleMsSave();
}
// ---------- Plan view（章・シーンのカードボード） ----------
export function toggleMsBoard() {
  const el = $('msBoard');
  if (!el) return;
  const show = el.classList.contains('hidden');
  if (show) renderMsBoard();
  el.classList.toggle('hidden', !show);
  $('btnMsBoard')?.classList.toggle('active', show);
}
function renderMsBoard() {
  const el = $('msBoard');
  el.innerHTML = '';
  if (!manuscript.chapters.length) {
    el.innerHTML = '<p class="hint" style="padding:8px">まだ章がありません</p>';
    return;
  }
  for (const ch of manuscript.chapters) {
    const head = document.createElement('div');
    head.className = 'ms-board-ch';
    head.textContent = ch.title;
    el.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'ms-board-grid';
    for (const sc of ch.scenes) {
      const card = document.createElement('div');
      card.className = 'ms-scene-card' + (sc.id === msSel.sceneId ? ' sel' : '');
      const first = (sc.content || '').replace(/\s+/g, ' ').slice(0, 80);
      card.innerHTML = `<div class="ms-scene-card-title"></div>
        <div class="ms-scene-card-meta hint"></div>
        <div class="ms-scene-card-prev"></div>`;
      card.querySelector('.ms-scene-card-title').textContent = sc.title;
      card.querySelector('.ms-scene-card-meta').textContent =
        `${(sc.content || '').length.toLocaleString()}字` + (sc.aiSnippets?.length ? ` · AI${sc.aiSnippets.length}` : '');
      card.querySelector('.ms-scene-card-prev').textContent = first || '（未執筆）';
      card.onclick = () => {
        msSel.chapterId = ch.id; msSel.sceneId = sc.id;
        renderMsTree(); updateMsEditor(); renderMsBoard();
      };
      grid.appendChild(card);
    }
    el.appendChild(grid);
  }
}

// ---------- AI挿入部分の一覧・除去 ----------
export function msShowAiParts() {
  const sc = msScene();
  if (!sc) { appAlert('シーンを選択してください'); return; }
  const list = sc.aiSnippets || [];
  if (!list.length) { appAlert('このシーンにAI挿入されたテキストはありません'); return; }
  let html = `<p class="hint">シーン「${esc(sc.title)}」にAIが書いた部分（${list.length}件）。「除去」で本文から取り除きます。</p>`;
  list.forEach((sn, i) => {
    const preview = sn.text.replace(/\s+/g, ' ').slice(0, 120);
    html += `<div class="card-item"><div class="hint">${new Date(sn.ts).toLocaleString('ja-JP')}</div>
      <div style="margin:6px 0;white-space:pre-wrap">${esc(preview)}${sn.text.length > 120 ? '…' : ''}</div>
      <button class="qb ai-rm" data-i="${i}">本文から除去</button></div>`;
  });
  showResultModal('AI挿入部分', html);
  $('resultBody').querySelectorAll('.ai-rm').forEach(b => {
    b.onclick = async () => {
      const i = parseInt(b.dataset.i, 10);
      const sn = sc.aiSnippets?.[i];
      if (!sn) return;
      if (!(await appConfirm('このAI挿入テキストを本文から取り除きますか？（取り消し不可）'))) return;
      // 末尾から探す（同一文の重複挿入で最新＝対象側を優先）。見つかった時だけ記録を消す
      const idx = sc.content.lastIndexOf(sn.text);
      if (idx >= 0) {
        sc.content = (sc.content.slice(0, idx) + sc.content.slice(idx + sn.text.length)).replace(/\n{3,}/g, '\n\n');
        sc.aiSnippets.splice(i, 1);
        renderMsTree(); updateMsEditor(); scheduleMsSave();
        msShowAiParts();
      } else {
        appAlert('本文内に該当テキストが見つかりませんでした（編集済みの可能性）。記録は残しています。');
      }
    };
  });
}

export function exportManuscript() {
  let out = '';
  for (const ch of manuscript.chapters) {
    out += `\n\n【${ch.title}】\n\n`;
    for (const sc of ch.scenes) out += `〔${sc.title}〕\n\n${sc.content}\n\n`;
  }
  if (!out.trim()) { appAlert('原稿がまだありません'); return; }
  downloadFile((manuscript.title || 'manuscript') + '.txt', out.trim(), 'text/plain');
}
