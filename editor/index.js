// リッチテキストエディタ（TipTap）のエントリ。esbuildで public/js/editor.bundle.js にバンドルする
import { Editor, Extension, Mark } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';

const AssistKey = new PluginKey('writerAssist');

// カーソル直前の文字列がカード名（固有名詞）のプレフィックスに一致したら、
// 残りをゴーストテキストで表示し Tab で補完する
function computeSuggestion(state, getNames) {
  const { $head } = state.selection;
  if (!$head.parent || !$head.parent.isTextblock) return null;
  const blockStart = $head.start();
  const before = state.doc.textBetween(blockStart, $head.pos, ' ', ' ').slice(-30);
  if (before.trim().length < 2) return null;
  const names = (typeof getNames === 'function' ? getNames() : []) || [];
  let best = null;
  for (const raw of names) {
    const n = String(raw || '').trim();
    if (n.length < 3) continue;
    const maxLen = Math.min(before.length, n.length - 1);
    for (let len = maxLen; len >= 2; len--) {
      const suf = before.slice(-len);
      if (n.startsWith(suf)) {
        const rest = n.slice(len);
        if (!rest) break;
        // より長く一致したもの・全体が短いものを優先
        const score = len * 1000 - n.length;
        if (!best || score > best.score) best = { remainder: rest, pos: $head.pos, score, name: n };
        break;
      }
    }
  }
  return best;
}

function makeGhostWidget(text) {
  const span = document.createElement('span');
  span.className = 'ghost-suggest';
  span.textContent = text;
  return span;
}

function WriterAssist(opts = {}) {
  return Extension.create({
    name: 'writerAssist',
    addOptions() {
      return { getNames: () => [], onSuggest: null, ...opts };
    },
    addProseMirrorPlugins() {
      const o = this.options;
      return [new Plugin({
        key: AssistKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old, oldState, newState) {
            // 変化がなければそのまま
            if (!tr.docChanged && !tr.selectionSet) return old.map(tr.mapping, newState.doc);
            const sug = computeSuggestion(newState, o.getNames);
            if (!sug) return DecorationSet.empty;
            const decos = [Decoration.widget(sug.pos, () => makeGhostWidget(sug.remainder), { side: 1, key: 'ghost' })];
            return DecorationSet.create(newState.doc, decos);
          }
        },
        props: {
          decorations(state) { return AssistKey.getState(state); },
          handleKeyDown(view, event) {
            if (event.key !== 'Tab') return false;
            const sug = computeSuggestion(view.state, o.getNames);
            if (!sug) return false;
            event.preventDefault();
            view.dispatch(view.state.tr.insertText(sug.remainder));
            view.focus();
            return true;
          }
        },
        view(editorView) {
          // サジェスト状態をUIに通知（デバウンス）
          let last = '';
          const notify = () => {
            const s = computeSuggestion(editorView.state, o.getNames);
            const cur = s ? s.remainder : '';
            if (cur !== last) { last = cur; if (o.onSuggest) o.onSuggest(s ? s.name : '', s ? s.remainder : ''); }
          };
          editorView.dom.addEventListener('keyup', notify);
          editorView.dom.addEventListener('click', notify);
          return { destroy() { editorView.dom.removeEventListener('keyup', notify); editorView.dom.removeEventListener('click', notify); } };
        }
      })];
    }
  });
}

// ---------- 日本語組版マーク：ルビ・傍点 ----------
const Ruby = Mark.create({
  name: 'ruby',
  addAttributes() {
    return { reading: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'ruby', contentElement: 'rb' }];
  },
  renderHTML({ HTMLAttributes }) {
    const { reading, ...rest } = HTMLAttributes;
    return ['ruby', rest, ['rb', {}, 0], ['rt', {}, reading || '']];
  }
});

const EmphasisDots = Mark.create({
  name: 'emphasisDots',
  parseHTML() {
    return [{ tag: 'span.emphasis-dots' }];
  },
  renderHTML() {
    return ['span', { class: 'emphasis-dots' }, 0];
  }
});

function createEditor(el, { content = '', placeholder = '', onUpdate = null, getNames = null, onSuggest = null } = {}) {
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
      Placeholder.configure({ placeholder }),
      Ruby,
      EmphasisDots,
      WriterAssist({ getNames: getNames || (() => []), onSuggest })
    ],
    content,
    onUpdate: ({ editor }) => { if (onUpdate) onUpdate(editor); }
  });
  return editor;
}

window.DocEditor = { create: createEditor, Editor };
