// リッチテキストエディタ（TipTap）のエントリ。esbuildで public/js/editor.bundle.js にバンドルする
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';

function createEditor(el, { content = '', placeholder = '', onUpdate = null } = {}) {
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
      Placeholder.configure({ placeholder })
    ],
    content,
    onUpdate: ({ editor }) => { if (onUpdate) onUpdate(editor); }
  });
  return editor;
}

window.DocEditor = { create: createEditor, Editor };
