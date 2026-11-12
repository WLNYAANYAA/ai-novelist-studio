// ---------- Manuscript（原稿ペイン） ----------
import { $ } from './dom.js';
import { api, appPrompt, appConfirm, appAlert, appDialog, downloadFile, showResultModal } from './util.js';
import { allCards } from './state.js';
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
  msSaveTimer = setTimeout(() => {
    api('/api/manuscript', { method: 'PUT', body: JSON.stringify(manuscript) }).catch(() => {});
  }, 600);
}
export { scheduleMsSave };
function msChapter() { return manuscript.chapters.find(c => c.id === msSel.chapterId); }
export function msScene() {
  const ch = msChapter();
  return ch ? ch.scenes.find(s => s.id === msSel.sceneId) : null;
}
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
export function adoptToManuscript(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (!manuscript.chapters.length) {
    manuscript.chapters.push({ id: msUid(), title: '第1章', scenes: [] });
  }
  let ch = msChapter() || manuscript.chapters[0];
  msSel.chapterId = ch.id;
  if (!ch.scenes.length || !ch.scenes.some(s => s.id === msSel.sceneId)) {
    const sc = { id: msUid(), title: `シーン${ch.scenes.length + 1}`, content: '' };
    ch.scenes.push(sc);
    msSel.sceneId = sc.id;
  }
  const sc = msScene();
  sc.content = (sc.content ? sc.content.replace(/\s+$/, '') + '\n\n' : '') + t;
  renderMsTree();
  updateMsEditor();
  scheduleMsSave();
  $('manuscriptPane').classList.remove('hidden');
  $('qbManuscript')?.classList.add('active');
  $('msStatus').textContent = `「${sc.title}」に追加しました`;
  setTimeout(() => { if ($('msStatus').textContent.startsWith('「')) $('msStatus').textContent = ''; }, 2500);
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
export function exportManuscript() {
  let out = '';
  for (const ch of manuscript.chapters) {
    out += `\n\n【${ch.title}】\n\n`;
    for (const sc of ch.scenes) out += `〔${sc.title}〕\n\n${sc.content}\n\n`;
  }
  if (!out.trim()) { appAlert('原稿がまだありません'); return; }
  downloadFile((manuscript.title || 'manuscript') + '.txt', out.trim(), 'text/plain');
}
