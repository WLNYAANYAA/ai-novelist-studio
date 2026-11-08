# AI Novelist Studio

AIのべりすと等のOpenAI互換APIと会話しながら小説を生成する、軽量な執筆支援ツールです。

会話の中で `#タグ` を使ってカード（世界観・キャラ設定など）を呼び出したり、ブラウザ風タブで複数の会話を並行管理したりできます。PCはもちろん、スマホやChromeOSのブラウザからも使えます。

## 特徴

- **会話しながら生成** — AIとのチャットがそのまま創作の現場。ストリーミング表示対応
- **カード＆タグ呼び出し** — 世界観・キャラ設定をカード化し、`#タグ` で会話中にいつでも注入（`##タグ` は今回のみ）
- **ブラウザ風タブ** — 複数の会話をタブで並行管理。下書きは会話ごとに自動保存
- **クイックマクロ** — 任意のキー割り当てで指示・ツールを即実行（アプリ内／グローバルホットキー対応）
- **モバイル対応** — スマホではドロワー式UI。PCと同じデータを共有可能
- **セルフホスト対応** — Render等にデプロイすればURLを開くだけで利用可能

## 起動方法

### ローカル（PC）

```sh
npm install
node server.js
# → http://localhost:3737 をブラウザで開く
```

Electronアプリとして使う場合は `npm start`（要 `npm run build` 済み環境）。

### クラウド（スマホ・ChromeOS対応）

各自が自分のインスタンスを立てる方式です。手順は [DEPLOY.md](DEPLOY.md) を参照してください。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=WLNYAANYAA/ai-novelist-studio)

## 設定

初回起動後、設定画面で以下を登録してください：

- **API Base URL**（デフォルト: `https://api.tringpt.com/v1`）
- **APIキー**（AIのべりすと開発者向けAPI等）
- **モデル名**（デフォルト: `spiko_ultra`）

## 技術構成

- **サーバー**: Node.js + Express（REST API + 静的配信 + AI APIプロキシ）
- **フロントエンド**: HTML/CSS/バニラJS（marked + DOMPurify）
- **デスクトップ**: Electron（contextIsolation有効）
- **データ**: JSONファイル（会話・カード・設定）＋ スナップショット分離

## セキュリティ

- APIキーはサーバー側にのみ保存され、ブラウザには送信されません
- Markdown出力はDOMPurifyでサニタイズ
- クラウド公開時は `ACCESS_TOKEN` 環境変数でアクセスキー認証を推奨

## ライセンス

MIT License（[LICENSE](LICENSE) 参照）
