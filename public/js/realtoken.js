// ---------- 実トークン計測（trin_tokenizer_v3 / transformers.js） ----------
import { tokenBadgeEl } from './dom.js';
import { current, config } from './state.js';
import { composeSystemPrompt, contextMessages } from './chat.js';

let tfScriptP = null, tfTokenizer = null, tfFailed = false;
const realCtxCache = { key: '', val: 0 };
function loadTransformers() {
  if (window.transformers) return Promise.resolve(window.transformers);
  if (tfScriptP) return tfScriptP;
  tfScriptP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.web.min.js';
    s.onload = () => window.transformers ? resolve(window.transformers) : reject(new Error('transformers未定義'));
    s.onerror = () => reject(new Error('CDN読み込み失敗'));
    document.head.appendChild(s);
  });
  return tfScriptP;
}
async function realTokenCount(text) {
  if (tfFailed || !text) return null;
  try {
    const T = await loadTransformers();
    if (!tfTokenizer) tfTokenizer = await T.AutoTokenizer.from_pretrained('naclbit/trin_tokenizer_v3');
    let total = 0;
    for (let i = 0; i < text.length; i += 8000) {
      const chunk = text.slice(i, i + 8000);
      let ids;
      if (typeof tfTokenizer.encode === 'function') ids = await tfTokenizer.encode(chunk);
      else ids = (await tfTokenizer(chunk)).input_ids;
      total += Array.isArray(ids) ? ids.length : (ids?.length || 0);
    }
    return total;
  } catch (e) {
    tfFailed = true;
    console.warn('実トークン計測を無効化:', e.message);
    return null;
  }
}
export async function refreshRealCtx() {
  if (!current || config?.params?.realTokens !== true) return;
  const text = (composeSystemPrompt() || '') + '\n' + contextMessages().map(m => m.content || '').join('\n');
  const key = text.length + '|' + text.slice(0, 100) + '|' + text.slice(-100);
  if (realCtxCache.key === key) { applyRealCtx(realCtxCache.val); return; }
  const n = await realTokenCount(text);
  if (n == null || !current) return;
  realCtxCache.key = key; realCtxCache.val = n;
  applyRealCtx(n);
}
function applyRealCtx(n) {
  tokenBadgeEl.textContent = tokenBadgeEl.textContent.replace(/ctx ~[\d,]+/, 'ctx ' + n.toLocaleString() + ' (実測)');
}
