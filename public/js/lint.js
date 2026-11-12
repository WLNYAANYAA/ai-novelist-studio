// ---------- 表現 lint（AI不要の機械的チェック） ----------
import { $ } from './dom.js';
import { esc, showResultModal } from './util.js';
import { current } from './state.js';
import { msScene } from './manuscript.js';

// 対象テキストを推定して取得（表示中のドキュメント > 原稿シーン > 直近AI応答）
export function lintSourceText() {
  const docText = window.__docText ? window.__docText() : '';
  if (docText.trim().length > 50) return { label: 'ドキュメント', text: docText };
  const sc = msScene();
  if (sc && (sc.content || '').trim().length > 50) return { label: `原稿: ${sc.title}`, text: sc.content };
  if (current) {
    for (let i = current.messages.length - 1; i >= 0; i--) {
      const m = current.messages[i];
      if (m.role === 'assistant' && (m.content || '').length > 50) {
        return { label: '最新のAI応答', text: m.content };
      }
    }
  }
  return null;
}

// 文末パターンの抽出（「〜だった。」「〜のだ。」等の常套句検出用）
const ENDING_RES = [
  [/([^。！？\n]{1,12})(だった|だっ[たた]|であった|であっ[たた])。/g, '〜だった。'],
  [/([^。！？\n]{1,12})(のだ|んだ|ものだ|ことだ)。/g, '〜のだ。'],
  [/([^。！？\n]{1,12})(ました|ません|ましょう)。/g, '〜ました。'],
  [/([^。！？\n]{1,12})(である|だ。|だ！)/g, '〜だ・〜である。'],
  [/([^。！？\n]{1,12})(ような気がした|気がした)。/g, '〜気がした。'],
  [/([^。！？\n]{1,12})(に違いない|に違いなかった)。/g, '〜に違いない。']
];

// 4文字以上の漢字・カタカナ複合語っぽい塊の頻度
const NOUN_RE = /[一-龯ァ-ヶー]{4,}/g;

export function analyzeText(text) {
  const issues = [];
  const sentences = (text.match(/[^。！？\n]+[。！？]?/g) || []).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 8) return { issues, sentences: sentences.length };

  // 1) 文末常套句の偏り
  const endingCount = {};
  for (const [re, label] of ENDING_RES) {
    let m;
    while ((m = re.exec(text))) {
      const key = label + '␟' + m[1].slice(-4);
      endingCount[key] = (endingCount[key] || 0) + 1;
    }
  }
  const hotEndings = Object.entries(endingCount)
    .map(([key, n]) => {
      const i = key.indexOf('␟');
      return { label: key.slice(0, i), tail: key.slice(i + 1), n };
    })
    .filter(x => x.n >= Math.max(4, sentences.length * 0.12))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  for (const { label, tail, n } of hotEndings) {
    issues.push({ level: 'warn', text: `文末「${esc(tail)}${label.replace('〜', '')}」系が${n}回（全${sentences.length}文中 ${Math.round(n / sentences.length * 100)}%）。単調になりがちです` });
  }

  // 2) 名詞・複合語の繰り返し（AIっぽさの典型）
  const nounCount = {};
  let nm;
  NOUN_RE.lastIndex = 0;
  while ((nm = NOUN_RE.exec(text))) {
    const w = nm[0];
    if (w.length > 12) continue; // 長すぎる塊は文全体の可能性
    nounCount[w] = (nounCount[w] || 0) + 1;
  }
  const hotNouns = Object.entries(nounCount)
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (hotNouns.length) {
    issues.push({
      level: 'info',
      text: `繰り返し頻出の語: ${hotNouns.map(([w, n]) => `「${esc(w)}」×${n}`).join('、')}（言い換え検討の余地あり）`
    });
  }

  // 3) 類似文末リズム（同じ文字数帯の文が連続）
  const lens = sentences.map(s => s.replace(/[、。！？\s]/g, '').length);
  let run = 1, maxRun = 1;
  for (let i = 1; i < lens.length; i++) {
    if (Math.abs(lens[i] - lens[i - 1]) <= 3) { run++; maxRun = Math.max(maxRun, run); }
    else run = 1;
  }
  if (maxRun >= 10) {
    issues.push({ level: 'warn', text: `ほぼ同じ長さの文が${maxRun}文連続しています。リズムの単調さに注意` });
  }

  // 4) 「〜のような」「〜みたいな」等の比喩頻度
  const simileCount = (text.match(/のような|のように|みたいな|みたいに|ごとく|如く/g) || []).length;
  if (simileCount >= 8 && sentences.length > 0) {
    issues.push({ level: 'info', text: `比喩表現（〜のような等）が${simileCount}箇所。多用するとAIっぽさが出ます` });
  }

  // 5) 一人称・三人称の混在兆候（簡易：同一段落内で「私」と「彼/彼女」が近接）
  const pCount = (text.match(/私は|私は|わたしは|僕は|俺は/g) || []).length;
  const thCount = (text.match(/彼は|彼女は|彼は|あいつは/g) || []).length;
  if (pCount >= 3 && thCount >= 3) {
    issues.push({ level: 'info', text: `一人称表現（${pCount}箇所）と三人称表現（${thCount}箇所）が混在している可能性。視点の統一を確認してください` });
  }

  return { issues, sentences: sentences.length };
}

function showLintResult(label, rawText) {
  const text = rawText.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const { issues, sentences } = analyzeText(text);
  let html;
  if (!issues.length) {
    html = `<p class="hint">✅ 特に気になるパターンは検出されませんでした（${sentences}文を解析）。</p>`;
  } else {
    html = `<p class="hint">対象: ${esc(label)} / ${sentences}文を解析。${issues.length}件の指摘:</p><ul style="line-height:1.9;font-size:13px">` +
      issues.map(i => `<li>${i.level === 'warn' ? '⚠️' : '💡'} ${i.text}</li>`).join('') + '</ul>';
  }
  showResultModal('表現チェック', html);
}

export function runDupCheck() {
  const src = lintSourceText();
  if (!src) { showResultModal('表現チェック', '<p class="hint">チェック対象の本文がありません（原稿シーン・ドキュメント・AI応答のいずれかに50字以上の本文が必要です）</p>'); return; }
  showLintResult(src.label, src.text);
}

// ドキュメントエディタ専用：開いているドキュメントを直接チェック
export function runDocLint() {
  const text = window.__docText ? window.__docText() : '';
  if (!text || text.trim().length < 20) {
    showResultModal('表現チェック', '<p class="hint">ドキュメントを開いて本文を入力してください</p>');
    return;
  }
  showLintResult('ドキュメント', text);
}
