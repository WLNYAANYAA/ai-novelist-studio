// ---------- プロジェクトプリセット（プロジェクト単位でカード・ソース・文体を一括適用） ----------
import { $ } from './dom.js';
import { api, appAlert, appConfirm } from './util.js';
import { current, allPresets, setAllPresets, allCards } from './state.js';
import { saveConversation, loadProfileToPanel } from './conversations.js';

export async function refreshPresets() {
  try { setAllPresets(await api('/api/project-presets')); }
  catch { setAllPresets([]); }
}
export function presetFor(project) {
  return allPresets.find(p => p.project === project) || null;
}
function validCardIds(ids) {
  const s = new Set(allCards.map(c => String(c.id)));
  return (ids || []).map(String).filter(id => s.has(id));
}

// 現在の会話設定（カード選択・ソース参照・文体プリセット）をプリセットとして保存
export async function saveProjectPreset() {
  if (!current?.project) {
    appAlert('先に「この会話の設定」でプロジェクトを選択し、「この会話に保存」で確定してください');
    return;
  }
  const p = current.profile || {};
  const preset = {
    cardIds: [...(current.cardIds || [])],
    sourceProject: p.sourceProject || '',
    useSources: !!(p.sourceProject || p.useSources),
    stylePreset: p.stylePreset || '',
    autoApply: $('pPresetAuto')?.checked === true
  };
  await api('/api/project-presets/' + encodeURIComponent(current.project), {
    method: 'PUT',
    body: JSON.stringify(preset)
  });
  await refreshPresets();
  updatePresetStatus();
  appAlert(`プロジェクト「${current.project}」のプリセットを保存しました`);
}

// 保存済みプリセットを現在の会話に適用
export async function applyProjectPreset() {
  if (!current?.project) { appAlert('プロジェクトが設定されていません'); return; }
  const preset = presetFor(current.project);
  if (!preset) { appAlert(`プロジェクト「${current.project}」のプリセットがありません`); return; }
  applyPresetToCurrent(preset);
  await saveConversation();
  loadProfileToPanel();
  updatePresetStatus();
  appAlert('プリセットを適用しました');
}

export async function clearProjectPreset() {
  if (!current?.project) return;
  const preset = presetFor(current.project);
  if (!preset) { appAlert('プリセットがありません'); return; }
  if (!(await appConfirm(`プロジェクト「${current.project}」のプリセットを削除しますか？（会話自体の設定は変わりません）`))) return;
  await api('/api/project-presets/' + encodeURIComponent(current.project), { method: 'DELETE' });
  await refreshPresets();
  updatePresetStatus();
}

function applyPresetToCurrent(preset) {
  current.cardIds = validCardIds(preset.cardIds);
  current.profile = {
    ...(current.profile || {}),
    sourceProject: preset.sourceProject || '',
    useSources: preset.useSources === true,
    stylePreset: preset.stylePreset || ''
  };
}

// 会話を開いた時、プリセットが「自動適用ON」かつ会話側が未設定なら自動で適用
export async function maybeAutoApplyPreset() {
  const preset = presetFor(current?.project);
  if (!preset || preset.autoApply !== true) return;
  const p = current.profile || {};
  const isEmpty = !(current.cardIds || []).length && !p.sourceProject && !p.useSources && !p.stylePreset;
  if (!isEmpty) return;
  applyPresetToCurrent(preset);
  await saveConversation();
  loadProfileToPanel();
}

// パネルのステータス表示と自動適用チェックの同期
export function updatePresetStatus() {
  const el = $('presetStatus');
  if (!el) return;
  const cb = $('pPresetAuto');
  const preset = presetFor(current?.project);
  if (cb) cb.checked = preset ? preset.autoApply === true : false;
  if (!current?.project) { el.textContent = 'プロジェクト未設定'; return; }
  el.textContent = preset
    ? `プリセットあり: カード${preset.cardIds.length}件` +
      (preset.sourceProject ? `・ソース:${preset.sourceProject}` : '') +
      (preset.useSources && !preset.sourceProject ? '・全ソース' : '') +
      (preset.stylePreset ? '・文体あり' : '') +
      (preset.autoApply ? '・自動適用ON' : '')
    : 'プリセットなし';
}
