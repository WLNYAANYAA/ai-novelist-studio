/* AI Novelist Studio - frontend entry (init + UI bind) */
import { $, chatEl, inputEl, convTitleEl, searchBox } from './dom.js';
import { api, esc, appPrompt } from './util.js';
import { config, fun, abortCtrl, allTemplates, current, setConfig, setAllCards, setAllTemplates } from './state.js';
import { loadManuscript, toggleManuscriptPane, exportManuscript, msAddChapter, msAddScene, msDelete, msScene, scheduleMsSave, msSetGoal, msForeshadowCheck, updateMsStats } from './manuscript.js';
import { refreshSources, openSourcesModal, fillSourceProjectSelect, resetSourceForm, saveSource, deleteSource, importSourceFile, renderSourceList } from './sources.js';
import { refreshConvList, restoreTabs, newConversation, renameConversation, saveProfile, deleteSelectedConvs, clearConvSelection, renderConvList, onSearchInput, queueDraftSave } from './conversations.js';
import { initScrollWatch, exportDoc } from './messages.js';
import { send, sendInstruction, insertSceneDivider, insertChapterDivider, altVersion } from './chat.js';
import { compressContext } from './context.js';
import { updateTagSug, hideTagSug, tagSugKey } from './tags.js';
import { openSettings, saveSettings, updateModelHint, PROVIDER_URLS, openTplModal, saveTpl, resetTplForm, deleteTpl, optimizePrompt, renderPresetMenu, syncPresetState, savePreset } from './settings.js';
import { openCardsModal, openCardPicker, saveCard, resetCardForm, deleteCard, saveCardPick } from './cards.js';
import { runPipeline, genVariants, analyzeEmotion, collectTerms, extractStyle, showWritingLog, refreshStyleOptions } from './ai-tools.js';
import { togglePin, toggleTimer, toggleBgm, toggleEars, setAiName, toggleVoice, toggleNeko, toggleSakura, toggleInfinite, onMoodChange, moodUp, cycleTheme, applyTheme, updateAiNameTag, syncFunButtons, updateTimerDisplay, restorePin, initSelectionPopup, renderQuickReplies, addQuickReply, toggleWritingMode, showOutline, openHistoryModal, toggleSidebar } from './features.js';
import { openMacroModal, armMacroRec, saveMacro, resetMacroForm, macroRecArmed, macros, comboFromEvent, runMacro, fireHotkey, syncGlobalHotkeys } from './macros.js';

// ---------- Init ----------
async function init() {
  setConfig(await api('/api/config'));
  setAllCards(await api('/api/cards'));
  setAllTemplates(await api('/api/templates'));
  loadManuscript();
  refreshSources();
  await refreshConvList();
  await restoreTabs();
  bindUI();
}

// ---------- Bind ----------
function bindUI() {
  $('btnBulkDelete').onclick = deleteSelectedConvs;
  $('btnBulkClear').onclick = clearConvSelection;
  $('btnNewChat').onclick = newConversation;
  $('btnNewTab')?.addEventListener('click', newConversation);
  // モバイル：ハンバーガーでサイドバードロワー開閉
  $('btnMenu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.classList.toggle('sidebar-open');
  });
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('sidebar-open')
        && !e.target.closest('#sidebar') && !e.target.closest('#btnMenu')) {
      document.body.classList.remove('sidebar-open');
    }
  });
  $('btnSidebarToggle').onclick = toggleSidebar;
  // 原稿ペイン
  $('qbManuscript').onclick = toggleManuscriptPane;
  $('btnMsClose').onclick = () => {
    $('manuscriptPane').classList.add('hidden');
    $('qbManuscript')?.classList.remove('active');
  };
  $('btnMsExport').onclick = exportManuscript;
  $('btnMsAddChapter').onclick = msAddChapter;
  $('btnMsAddScene').onclick = msAddScene;
  $('btnMsDel').onclick = msDelete;
  $('btnMsForeshadow').onclick = msForeshadowCheck;
  $('msGoal').onchange = e => msSetGoal(e.target.value);
  $('msSceneTitle').addEventListener('input', () => {
    const sc = msScene(); if (!sc) return;
    sc.title = $('msSceneTitle').value;
    scheduleMsSave();
  });
  $('msEditor').addEventListener('input', () => {
    const sc = msScene(); if (!sc) return;
    sc.content = $('msEditor').value;
    scheduleMsSave();
    const cnt = document.querySelector('.ms-sc.sel .ms-count');
    if (cnt) cnt.textContent = `${sc.content.length}字`;
    updateMsStats();
  });
  // ソース管理
  $('btnSources').onclick = () => openSourcesModal();
  $('btnCloseSources').onclick = () => $('sourcesModal').classList.add('hidden');
  $('sourcesModal').addEventListener('click', (e) => { if (e.target === $('sourcesModal')) $('sourcesModal').classList.add('hidden'); });
  $('btnNewSource').onclick = () => { $('sourceEditForm').classList.remove('hidden'); $('srcId').value=''; $('srcName').value=''; $('srcContent').value=''; fillSourceProjectSelect($('srcProject'), ''); $('btnDeleteSource').classList.add('hidden'); $('srcName').focus(); };
  $('btnNewProject').onclick = async () => {
    const name = await appPrompt('プロジェクト名を入力（例: 作品A / 資料集 / 論文メモ）', '');
    if (!name || !name.trim()) return;
    $('sourceEditForm').classList.remove('hidden');
    $('srcId').value=''; $('srcName').value=''; $('srcContent').value='';
    fillSourceProjectSelect($('srcProject'), name.trim());
    $('btnDeleteSource').classList.add('hidden');
    $('srcName').focus();
  };
  $('btnSaveSource').onclick = saveSource;
  $('btnCancelSource').onclick = resetSourceForm;
  $('btnDeleteSource').onclick = deleteSource;
  $('btnImportSource').onclick = () => $('srcFileInput').click();
  $('srcProjectFilter').onchange = renderSourceList;
  $('srcFileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importSourceFile(f);
    e.target.value = '';
  });
  // プロンプト最適化
  $('btnOptimizePrompt').onclick = optimizePrompt;
  initScrollWatch();
  $('btnSettings').onclick = openSettings;
  convTitleEl.title = 'ダブルクリックで会話名を変更';
  convTitleEl.ondblclick = async () => {
    if (!current) return;
    const v = await appPrompt('会話名を入力', current.title);
    if (v && v.trim() && v.trim() !== current.title) {
      await renameConversation(current, v);
    }
  };
  $('btnCloseSettings').onclick = () => $('settingsModal').classList.add('hidden');
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden');
  });
  $('btnSaveSettings').onclick = saveSettings;
  $('sModel').onchange = updateModelHint;
  $('sProvider').onchange = () => {
    const u = PROVIDER_URLS[$('sProvider').value];
    if (u) $('sBaseUrl').value = u;
    updateModelHint();
  };
  $('sTemperature').oninput = () => $('sTemperatureVal').textContent = $('sTemperature').value;
  $('sTopP').oninput = () => $('sTopPVal').textContent = $('sTopP').value;
  $('sTemplate').onchange = () => {
    const t = allTemplates.find(x => x.id === $('sTemplate').value);
    if (t) $('sSystemPrompt').value = t.content;
  };
  $('btnManageTemplates').onclick = () => openTplModal();
  $('btnCloseTpl').onclick = () => $('tplModal').classList.add('hidden');
  $('tplModal').addEventListener('click', (e) => { if (e.target === $('tplModal')) $('tplModal').classList.add('hidden'); });
  $('btnNewTpl').onclick = () => openTplModal();
  $('btnSaveTpl').onclick = saveTpl;
  $('btnCancelTpl').onclick = resetTplForm;
  $('btnDeleteTpl').onclick = deleteTpl;

  $('btnCards').onclick = () => openCardsModal();
  $('btnCards2').onclick = openCardPicker;
  $('btnCloseCards').onclick = () => $('cardsModal').classList.add('hidden');
  $('cardsModal').addEventListener('click', (e) => { if (e.target === $('cardsModal')) $('cardsModal').classList.add('hidden'); });
  $('btnNewCard').onclick = () => { $('cardEditForm').classList.remove('hidden'); $('cId').value=''; $('cName').value=''; $('cContent').value=''; $('cTriggers').value=''; $('cTags').value=''; $('btnDeleteCard').classList.add('hidden'); $('cName').focus(); };
  $('btnSaveCard').onclick = saveCard;
  $('btnCancelCard').onclick = resetCardForm;
  $('btnDeleteCard').onclick = deleteCard;

  $('btnCloseCardPick').onclick = () => $('cardPickModal').classList.add('hidden');
  $('cardPickModal').addEventListener('click', (e) => { if (e.target === $('cardPickModal')) $('cardPickModal').classList.add('hidden'); });
  $('btnSaveCardPick').onclick = saveCardPick;

  $('btnParams').onclick = () => $('paramsPanel').classList.toggle('hidden');
  $('btnSaveProfile').onclick = saveProfile;
  $('btnScene').onclick = insertSceneDivider;
  $('btnExport').onclick = exportDoc;
  $('btnHistory').onclick = openHistoryModal;
  $('btnChapter').onclick = insertChapterDivider;
  $('btnCompress').onclick = compressContext;
  $('btnOutline').onclick = showOutline;
  $('btnQuickReplyAdd').onclick = addQuickReply;
  $('qbPipeline').onclick = runPipeline;
  $('qbVariants').onclick = () => genVariants(3);
  $('qbEmotion').onclick = analyzeEmotion;
  $('qbCollect').onclick = collectTerms;
  $('qbStyle').onclick = extractStyle;
  $('qbWritingMode').onclick = toggleWritingMode;
  $('btnExitWriting').onclick = toggleWritingMode;
  $('qbLog').onclick = showWritingLog;
  $('btnCloseResult').onclick = () => $('resultModal').classList.add('hidden');
  $('resultModal').addEventListener('click', (e) => { if (e.target === $('resultModal')) $('resultModal').classList.add('hidden'); });
  $('btnCloseHistory').onclick = () => $('historyModal').classList.add('hidden');
  $('historyModal').addEventListener('click', (e) => { if (e.target === $('historyModal')) $('historyModal').classList.add('hidden'); });
  $('qbPin').onclick = togglePin;
  $('qbAB').onclick = altVersion;

  // クイックマクロ
  $('btnMacros').onclick = openMacroModal;
  $('btnCloseMacro').onclick = () => $('macroModal').classList.add('hidden');
  $('macroModal').addEventListener('click', (e) => { if (e.target === $('macroModal')) $('macroModal').classList.add('hidden'); });
  $('btnMacroRec').onclick = armMacroRec;
  $('btnMacroSave').onclick = saveMacro;
  $('btnMacroCancel').onclick = resetMacroForm;
  // ホットキー発火（マクロ優先：既存ショートカットより先に捕捉）
  document.addEventListener('keydown', (e) => {
    if (macroRecArmed) return;
    if (document.querySelector('.modal:not(.hidden)')) return;
    const hit = macros.find(m => m.keys === comboFromEvent(e));
    if (!hit) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
    if (inField && !(e.ctrlKey || e.altKey)) return; // 入力中は修飾キー無しの割り当てを無効化
    e.preventDefault();
    e.stopImmediatePropagation();
    runMacro(hit);
  }, true);
  window.winAPI?.onHotkey?.((combo) => fireHotkey(combo)); // グローバル発火（非アクティブ時）
  syncGlobalHotkeys();
  $('qbSummary').onclick = () => sendInstruction('これまでの会話全体のあらすじを400字程度で要約してください。時系列で簡潔に。', { summary: true });
  $('qbTimer').onclick = toggleTimer;
  $('qbBgm').onclick = toggleBgm;
  $('qbEars').onclick = toggleEars;
  $('qbName').onclick = setAiName;
  $('btnSend').onclick = send;
  $('btnStop').onclick = () => abortCtrl && abortCtrl.abort();
  searchBox.addEventListener('input', onSearchInput);
  $('convProjectFilter').addEventListener('change', renderConvList);
  inputEl.addEventListener('keydown', (e) => {
    if (tagSugKey(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    else if (e.key === 'Enter' && !e.shiftKey && config?.sendOnEnter) { e.preventDefault(); send(); }
  });
  // グローバルショートカット
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); newConversation(); }
    else if (k === 'k') { e.preventDefault(); searchBox.focus(); searchBox.select(); }
    else if (k === ',') { e.preventDefault(); openSettings(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    queueDraftSave();
    updateTagSug();
  });
  inputEl.addEventListener('blur', () => setTimeout(hideTagSug, 150));
  inputEl.addEventListener('scroll', hideTagSug);

  // クイックバー
  document.querySelectorAll('.qb[data-instruct]').forEach(b => {
    b.onclick = () => sendInstruction(b.dataset.instruct);
  });
  $('qbVoice').onclick = toggleVoice;
  $('qbNeko').onclick = toggleNeko;
  $('qbSakura').onclick = toggleSakura;
  $('qbInfinite').onclick = toggleInfinite;
  $('qbMood').value = fun.mood;
  $('qbMood').onchange = onMoodChange;
  $('qbMoodUp').onclick = moodUp;
  $('qbTheme').onclick = cycleTheme;
  $('btnPresetSave').onclick = savePreset;
  renderPresetMenu();
  syncPresetState();

  // ドロップダウンメニュー（上部バー・クイックバー共通）
  document.querySelectorAll('.dropdown').forEach(d => {
    const btn = d.querySelector(':scope > button');
    const menu = d.querySelector(':scope > .dropdown-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
      if (willOpen) menu.classList.remove('hidden');
    });
    menu.addEventListener('click', e => {
      if (e.target.closest('.menu-item') && !e.target.closest('select')) menu.classList.add('hidden');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
  });
  initSelectionPopup();
  renderQuickReplies();
  window.speechSynthesis?.getVoices(); // 音声リストを事前読込
  applyTheme();
  refreshStyleOptions();
  if (fun.writingMode) document.body.classList.add('writing-mode');
  syncFunButtons();
  updateAiNameTag();
  if (fun.ears) { document.body.classList.add('cat-ears'); $('qbEars').classList.add('active'); }
  updateTimerDisplay();
  if (fun.sakura) { fun.sakura = false; toggleSakura(); } // 永続化された桜モードを復元
  restorePin();
}

init().catch(e => {
  chatEl.innerHTML = '<div class="msg bot error" style="align-self:center">初期化エラー: ' + esc(String(e)) + '</div>';
});
