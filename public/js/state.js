// 共有状態（モジュール間で読み書きする可変状態）
// 注意: export した let への直接代入は他モジュールからは不可。再代入は必ず setXxx を使う
// （読み取りは live binding で常に最新値が見える）

export let config = null;
export let allCards = [];
export let allTemplates = [];
export let allSources = [];
export let cardsVersion = 0; // カード変更検知用（effectiveCardIdsキャッシュの無効化）
export let current = null;
export let busy = false;
export let abortCtrl = null;
export let pendingStyle = false; // 文体プロファイル抽出の生成を待っているフラグ

export const setConfig = (v) => { config = v; };
export const setAllCards = (v) => { allCards = v; };
export const setAllTemplates = (v) => { allTemplates = v; };
export const setAllSources = (v) => { allSources = v; };
export const setCardsVersion = (v) => { cardsVersion = v; };
export const setCurrent = (v) => { current = v; };
export const setBusyState = (v) => { busy = v; };
export const setAbortCtrl = (v) => { abortCtrl = v; };
export const setPendingStyle = (v) => { pendingStyle = v; };

// 下書き保存キー（会話ごと）
export const draftKey = () => 'draft_' + (current?.id || '');

export const STYLE_PRESETS = {
  '': '',
  'normal': 'ノーマルな小説文で、自然で読みやすい日本語を心がけてください。',
  'ranobe': 'ライトノベル風の軽快でテンポの良い文体で書いてください。',
  'jidaigeki': '時代劇・歴史小説のような格式高い文体で書いてください。',
  'horror': 'ホラー・ミステリー小説のように、緊張感と陰影のある文体で書いてください。',
  'bungei': '文芸小説のように詩的で装飾的な文体で書いてください。'
};
export const CARD_KINDS = { character: 'キャラ', world: '世界観', term: '用語', foreshadow: '伏線' };

// お楽しみ機能・細かい設定（localStorage）
export const fun = {
  neko: localStorage.getItem('fun_neko') === '1',
  sakura: localStorage.getItem('fun_sakura') === '1',
  infinite: false,
  infiniteCount: 0,
  mood: localStorage.getItem('fun_mood') || '機嫌がいい',
  theme: localStorage.getItem('ui_theme') || 'auto',
  aiName: localStorage.getItem('fun_ainame') || '',
  ears: localStorage.getItem('fun_ears') === '1',
  bgm: false,
  writingMode: localStorage.getItem('fun_writingmode') === '1'
};
export const saveFun = (k) => localStorage.setItem('fun_' + k, fun[k] ? '1' : '0');
localStorage.setItem('fun_mood', fun.mood);
