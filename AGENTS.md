# AI Novelist Studio

Express + SQLite（node:sqlite）のバックエンド（server.js）と、バンドルなしのES Modulesフロントエンド（public/js/、app.jsがエントリ）。Electron対応。

## コマンド

- 起動: `npm start`（http://localhost:3737）
- 検証: `node --check server.js`、ブラウザで `/` を開く
- データ: `%APPDATA%/AI Novelist Studio/data/app.db`（SQLite docsテーブル、kind+idで全データ管理）

## リッチテキストエディタ（ドキュメント機能）

- エディタはTipTap v2。ソースは `editor/index.js`、成果物は `public/js/editor.bundle.js`（IIFE、`window.DocEditor`）。
- リビルド: `npm run build:editor`
- **注意**: ワークスペースがUNCパス（\\server\share）上にあると esbuild の cmd 起動と npm の postinstall が失敗する。
  - npm install は `npm i --ignore-scripts` を使う（electron-winstaller のスクリプトがUNCで落ちる）
  - esbuild がUNCで動かない場合はローカル一時ディレクトリに tiptap+esbuild を入れてそこでバンドルし、生成物を `public/js/` にコピーする
- ドキュメントAPI: `/api/documents` CRUD（server.js、kind='doc'）
- フロント: `public/js/documents.js`。タブは `{type:'conv'|'doc', id}` で localStorage `open_tabs` に保存（docタブは `d:` プレフィックス）

## 構成メモ

- タブ・会話一覧は conversations.js、ドキュメントは documents.js。タブ種別の追加は `registerTabOpener(type, fn)` で登録
- ビュー切替は showChatView / showDocView（conversations.js）
