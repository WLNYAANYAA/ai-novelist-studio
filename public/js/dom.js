// DOM要素の共有参照（モジュールはdefer実行なのでDOM構築済み）
export const $ = (id) => document.getElementById(id);
export const chatEl = $('chat'), inputEl = $('input'), sendBtn = $('btnSend'), stopBtn = $('btnStop');
export const convListEl = $('convList'), convTitleEl = $('convTitle'), tokenBadgeEl = $('tokenBadge');
export const searchBox = $('convSearch'), searchResultsEl = $('searchResults');
