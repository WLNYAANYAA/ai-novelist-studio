// ---------- Settings / プリセット / Templates / プロンプト最適化 ----------
import { $, inputEl } from './dom.js';
import { api, appAlert, appDialog, appPrompt, appConfirm } from './util.js';
import { config, setConfig, allTemplates, setAllTemplates, STYLE_PRESETS } from './state.js';
import { callApiOnce } from './context.js';
import { apiWarnMissing } from './chat.js';

// 詳細パラメータ（AIのべりすとAPI全対応）
const ADV_FIELDS = [
  ['sRepPen', 'repPen'], ['sFreqPen', 'freqPen'], ['sPresPen', 'presPen'],
  ['sTopK', 'topK'], ['sTopA', 'topA'], ['sMinP', 'minP'],
  ['sTailfree', 'tailfree'], ['sTypicalP', 'typicalP'],
  ['sSeed', 'seed'], ['sBadwords', 'badwords'], ['sStoptokens', 'stoptokens'], ['sAuxModel', 'auxModel']
];
const MODEL_INFO = {
  spiko_ultra: '最上位モデル。20万トークンの長文脈と最大の知識量。推奨。',
  spiko_solid: '指示への追従を重視したモード。設定無視が少ない。',
  spiko_max: 'クリエイティブと指示のバランス型。長編向け推奨。',
  spiko: '軽量・高速なスタンダードモデル。',
  derrida_03: '詩的で叙情的な文体が特徴の詩モデル。',
  damsel_ray: '第三世代の生文特化モデル。指示追従・論理は苦手だが人間味のある文章。',
  supertrin_highpres: '高密度プリセット系モデル。',
  supertrin_maxpres: '最高密度プリセット系モデル。'
};
export const PROVIDER_URLS = {
  tringpt: 'https://api.tringpt.com/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  custom: ''
};
function detectProvider(baseUrl) {
  const b = (baseUrl || '').replace(/\/+$/, '');
  for (const [k, v] of Object.entries(PROVIDER_URLS)) if (v && b === v) return k;
  return 'custom';
}
export function updateModelHint() {
  const m = $('sModel').value;
  $('modelHint').textContent = MODEL_INFO[m] || '';
}

// ---------- Settings ----------
export function openSettings() {
  $('sApiKeyStatus').textContent = config.hasApiKey ? `設定済み: ${config.apiKeyMasked}` : '未設定';
  $('sApiKey').value = '';
  $('sApiKey').placeholder = config.hasApiKey ? config.apiKeyMasked : 'APIキーを入力';
  $('sModel').value = config.model;
  $('sProvider').value = 'tringpt';
  $('sBaseUrl').value = PROVIDER_URLS.tringpt;
  $('sNoAuth').removeAttribute('checked');
  $('sLanAccess').checked = config.lanAccess === true;
  $('sTemperature').value = config.params.temperature;
  $('sTopP').value = config.params.topP;
  $('sMaxTokens').value = config.params.maxTokens;
  $('sEffort').value = config.params.effort;
  $('sStream').checked = config.stream !== false;
  $('sSendOnEnter').checked = config.sendOnEnter === true;
  $('sTemperatureVal').textContent = config.params.temperature;
  $('sTopPVal').textContent = config.params.topP;
  $('sSystemPrompt').value = config.systemPrompt || '';
  $('sWorldMemo').value = config.worldMemo || '';
  $('lanHint').textContent = config.lanAccess
    ? (config.accessTokenSet === false
      ? '注意: ACCESS_TOKENが未設定のためLAN公開は無効です（このPCのみ）'
      : (config.lanUrl ? `スマホ等からはこのURLで開けます: ${config.lanUrl}` : 'LAN公開中（IPアドレスを取得できませんでした）'))
    : 'LAN公開はOFF（このPCのみ）';
  // 標準プリセット→カスタム文体（value=本文）の順で一致を探す
  const sp = config.stylePreset || '';
  let customHit = false;
  try { customHit = (JSON.parse(localStorage.getItem('custom_styles') || '[]') || []).some(s => s.text === sp); } catch {}
  $('sStylePreset').value = Object.keys(STYLE_PRESETS).find(k => STYLE_PRESETS[k] === sp)
    || (sp && customHit ? sp : '');
  for (const [elId, key] of ADV_FIELDS) {
    $(elId).value = config.params[key] ?? '';
  }
  $('sMultilingual').checked = config.params.multilingual === true;
  $('sCtxBudget').value = config.params.ctxBudget ?? 120000;
  $('sHistoryLimit').value = config.params.historyLimit ?? 0;
  $('sAutoCards').checked = config.params.autoCards !== false;
  $('sAutoCompress').checked = config.params.autoCompress !== false;
  $('sHybridMem').checked = config.params.hybridMemory !== false;
  $('sSuggestNext').checked = config.params.suggestNext !== false;
  $('sRealTokens').checked = config.params.realTokens === true;
  $('sNoMarkdown').checked = config.params.noMarkdown !== false;
  $('sNoEmoji').checked = config.params.noEmoji !== false;
  $('sJpReasoning').checked = config.params.jpReasoning !== false;
  $('sAdultMode').checked = config.params.adultMode === true;
  updateModelHint();
  refreshTemplates();
  $('settingsModal').classList.remove('hidden');
  fetch('/api/version').then(r => r.json()).then(v => {
    const el = $('aboutInfo');
    if (el && v.version) el.textContent = `${v.name || 'AI Novelist Studio'} v${v.version} · MIT License`;
  }).catch(() => {});
}
export async function saveSettings() {
  const body = {
    model: $('sModel').value,
    params: {
      temperature: parseFloat($('sTemperature').value),
      topP: parseFloat($('sTopP').value),
      maxTokens: parseInt($('sMaxTokens').value) || 8192,
      effort: $('sEffort').value,
      multilingual: $('sMultilingual').checked,
      ctxBudget: parseInt($('sCtxBudget').value) || 120000,
      historyLimit: parseInt($('sHistoryLimit').value) || 0,
      autoCards: $('sAutoCards').checked,
      autoCompress: $('sAutoCompress').checked,
      hybridMemory: $('sHybridMem').checked,
      suggestNext: $('sSuggestNext').checked,
      realTokens: $('sRealTokens').checked,
      noMarkdown: $('sNoMarkdown').checked,
      noEmoji: $('sNoEmoji').checked,
      jpReasoning: $('sJpReasoning').checked,
      adultMode: $('sAdultMode').checked
    },
    stream: $('sStream').checked,
    sendOnEnter: $('sSendOnEnter').checked,
    baseUrl: PROVIDER_URLS.tringpt,
    noAuth: false,
    lanAccess: $('sLanAccess').checked,
    systemPrompt: $('sSystemPrompt').value,
    worldMemo: $('sWorldMemo').value,
    stylePreset: (() => { const v = $('sStylePreset').value; return STYLE_PRESETS[v] || v || ''; })()
  };
  for (const [elId, key] of ADV_FIELDS) {
    const v = $(elId).value.trim();
    body.params[key] = v;
  }
  if ($('sApiKey').value.trim()) body.apiKey = $('sApiKey').value.trim();
  await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
  setConfig(await api('/api/config'));
  $('settingsSaved').textContent = '保存しました';
  setTimeout(() => $('settingsSaved').textContent = '', 2000);
  setTimeout(() => $('settingsModal').classList.add('hidden'), 600);
  syncPresetState();
}

// ---------- プリセット（設定のスナップショットを名前付きで保存・即時切替） ----------
const PRESET_KEY = 'ai_presets';
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch { return []; }
}
function savePresets(list) { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); }

function snapshotConfig() {
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    noAuth: config.noAuth === true,
    params: JSON.parse(JSON.stringify(config.params || {})),
    systemPrompt: config.systemPrompt || '',
    worldMemo: config.worldMemo || '',
    stylePreset: config.stylePreset || '',
    stream: config.stream !== false,
    sendOnEnter: config.sendOnEnter === true
  };
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const r = {};
    for (const k of Object.keys(v).sort()) r[k] = canon(v[k]);
    return r;
  }
  return v;
}
function presetMatches(p) {
  return JSON.stringify(canon(p.data)) === JSON.stringify(canon(snapshotConfig()));
}
function syncPresetState() {
  const match = loadPresets().find(presetMatches);
  const aid = match ? match.id : null;
  if (aid) localStorage.setItem('preset_active', aid);
  else localStorage.removeItem('preset_active');
  updatePresetButton();
}
function updatePresetButton() {
  const el = $('presetLabel');
  if (!el) return;
  const p = loadPresets().find(x => x.id === localStorage.getItem('preset_active'));
  el.textContent = p ? p.name : 'なし';
}
export function renderPresetMenu() {
  const list = $('presetList');
  if (!list) return;
  const presets = loadPresets();
  const activeId = localStorage.getItem('preset_active');
  list.innerHTML = '';
  if (!presets.length) {
    list.innerHTML = '<div class="menu-item menu-static hint">プリセットなし</div>';
    return;
  }
  for (const p of presets) {
    const item = document.createElement('div');
    item.className = 'menu-item preset-item' + (p.id === activeId ? ' active' : '');
    item.innerHTML = `<span class="preset-name"></span><button class="preset-del" title="削除">×</button>`;
    item.querySelector('.preset-name').textContent = p.name;
    item.onclick = async () => {
      await applyPreset(p);
    };
    item.querySelector('.preset-del').onclick = (e) => {
      e.stopPropagation();
      savePresets(loadPresets().filter(x => x.id !== p.id));
      if (localStorage.getItem('preset_active') === p.id) localStorage.removeItem('preset_active');
      renderPresetMenu();
      updatePresetButton();
    };
    list.appendChild(item);
  }
}
async function applyPreset(p) {
  const d = p.data || {};
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      model: d.model, baseUrl: PROVIDER_URLS.tringpt, noAuth: false,
      params: d.params || {}, systemPrompt: d.systemPrompt || '',
      worldMemo: d.worldMemo || '', stylePreset: d.stylePreset || '',
      stream: d.stream !== false, sendOnEnter: d.sendOnEnter === true
    })
  });
  setConfig(await api('/api/config'));
  localStorage.setItem('preset_active', p.id);
  renderPresetMenu();
  updatePresetButton();
  appAlert(`プリセット「${p.name}」を適用しました`);
}
export async function savePreset() {
  const name = await appPrompt('プリセット名を入力（例: 創作モード / 推敲モード）', '');
  if (!name || !name.trim()) return;
  const list = loadPresets();
  const exist = list.findIndex(x => x.name === name.trim());
  const entry = { id: exist >= 0 ? list[exist].id : Date.now().toString(36), name: name.trim(), data: snapshotConfig() };
  if (exist >= 0) list[exist] = entry; else list.push(entry);
  savePresets(list);
  localStorage.setItem('preset_active', entry.id);
  renderPresetMenu();
  updatePresetButton();
}
export { syncPresetState };

// ---------- Templates ----------
export async function refreshTemplates() {
  setAllTemplates(await api('/api/templates'));
  const sel = $('sTemplate');
  sel.innerHTML = '<option value="">（選択）</option>';
  for (const t of allTemplates) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
}
export function openTplModal(editTpl = null) {
  refreshTemplates().then(renderTplList);
  $('tplModal').classList.remove('hidden');
  if (editTpl) {
    $('tplEditForm').classList.remove('hidden');
    $('tId').value = editTpl.id;
    $('tName').value = editTpl.name;
    $('tContent').value = editTpl.content;
    $('btnDeleteTpl').classList.remove('hidden');
  } else resetTplForm();
}
function renderTplList() {
  const el = $('tplList');
  el.innerHTML = '';
  if (!allTemplates.length) {
    el.innerHTML = '<p class="hint">テンプレートがありません。</p>';
    return;
  }
  for (const t of allTemplates) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `<strong></strong> <span class="hint"></span>`;
    div.querySelector('strong').textContent = t.name;
    div.querySelector('.hint').textContent = (t.content || '').slice(0, 60).replace(/\n/g, ' ');
    div.onclick = () => openTplModal(t);
    el.appendChild(div);
  }
}
export function resetTplForm() {
  $('tplEditForm').classList.add('hidden');
  $('tId').value = ''; $('tName').value = ''; $('tContent').value = '';
  $('btnDeleteTpl').classList.add('hidden');
}
export async function saveTpl() {
  const id = $('tId').value;
  const body = { name: $('tName').value, content: $('tContent').value };
  if (id) await api('/api/templates/' + id, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/templates', { method: 'POST', body: JSON.stringify(body) });
  await refreshTemplates();
  renderTplList();
  resetTplForm();
}
export async function deleteTpl() {
  const id = $('tId').value;
  if (!id || !(await appConfirm('このテンプレートを削除しますか？'))) return;
  await api('/api/templates/' + id, { method: 'DELETE' });
  await refreshTemplates();
  renderTplList();
  resetTplForm();
}

// ---------- プロンプト最適化 ----------
export async function optimizePrompt() {
  const draft = inputEl.value.trim();
  if (!draft) { appAlert('先に指示文を入力してください'); return; }
  if (apiWarnMissing()) return;
  const btn = $('btnOptimizePrompt');
  btn.disabled = true;
  try {
    const { text } = await callApiOnce([
      { role: 'system', content: 'あなたは小説生成AIへの指示文を改善するアシスタントです。ユーザーの指示を、AIが最高の結果を出すための具体的で明確な指示文に書き換えてください。出力は改善後の指示文のみとし、説明・前置き・引用符・箇条書き記号は付けないでください。' },
      { role: 'user', content: draft }
    ]);
    const opt = (text || '').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!opt) throw new Error('最適化結果が空でした');
    const use = await appDialog(`最適化された指示文:\n\n${opt.slice(0, 1000)}${opt.length > 1000 ? '…' : ''}`, { okText: '入力欄に反映' });
    if (use === true) {
      inputEl.value = opt;
      inputEl.dispatchEvent(new Event('input'));
      inputEl.focus();
    }
  } catch (e) {
    appAlert('最適化に失敗しました: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}
