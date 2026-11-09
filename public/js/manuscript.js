// ---------- Manuscript（原稿ペイン） ----------
import { $ } from './dom.js';
import { api, appPrompt, appConfirm, appAlert, downloadFile } from './util.js';

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
  renderMsTree();
  updateMsEditor();
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
function updateMsEditor() {
  const sc = msScene();
  $('msSceneTitle').value = sc ? sc.title : '';
  $('msEditor').value = sc ? sc.content : '';
}
export function toggleManuscriptPane() {
  $('manuscriptPane').classList.toggle('hidden');
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
