# AI Novelist Studio

AIのべりすと等のOpenAI互換APIと会話しながら小説を生成・蓄積していく、軽量なAI執筆スタジオです。

会話の中で `#タグ` を使ってカード（世界観・キャラ設定・伏線など）を呼び出したり、原稿ペインに本文を蓄積したり、複数の会話・資料をプロジェクト単位で管理できます。PCはもちろん、スマホやChromeOSのブラウザからも使えます。

## 特徴

### 創作ワークフロー
- **会話しながら生成** — AIとのチャットがそのまま創作の現場。ストリーミング表示対応
- **原稿ペイン** — AIの応答をワンタップで原稿に採用。章・シーン構成で整理して執筆
- **執筆統計** — 総文字数・目標達成率・本日の執筆ペースをリアルタイム表示
- **次の一手提案** — 応答完了ごとに次の指示候補を3つ提示（ワンタップ送信・設定でOFF可）
- **伏線トラッカー** — 伏線カードの未回収/回収済を管理し、AIが「このシーンで回収すべき伏線」を提案
- **文体分析** — サンプル本文（最大約6000字）から文長・文字種比率・語彙特性など約24項目をAIが評価し、再現用の「文体指示文」をプリセット/カードに保存。jReadabilityによる本家の読みやすさスコアも計測（MeCab+UniDic同梱版は実計測、未導入環境は近似値）
- **カード＆タグ呼び出し** — `#タグ` で会話中にいつでも注入（`##タグ` は今回のみ）
- **プロンプト最適化** — 入力中の指示文をAIが推敲してから送信

### 記憶とコスト管理
- **ハイブリッド記憶** — 直近1往復は生テキストで完全記憶、過去9往復は英語に圧縮して保持。口調を保ちつつトークンを節約
- **コンテキスト自動圧縮** — 予算超過時に古いやり取りを要約。使用量はトークンバッジで可視化
- **実トークン計測** — オプションで正確なトークン数を計測（初回のみモデルDL）

### 資料・プロジェクト管理
- **ソース（NotebookLM的Q&A）** — 資料をプロジェクトごとに登録し、AIが【出典: ソース名】付きで回答
- **会話プロジェクト** — 複数の会話を作品単位でグループ化・フィルタ
- **クイックマクロ** — 任意のキー割り当てで指示・ツールを即実行（アプリ内／グローバルホットキー対応）
- **ブラウザ風タブ** — 複数の会話をタブで並行管理。下書きは会話ごとに自動保存

### 対応環境
- **デスクトップ** — Windowsインストーラー / ポータブルexe（Electron）
- **ブラウザ・スマホ・ChromeOS** — 同一LAN内アクセスやセルフホストでURLを開くだけ

## インストール

[Releases](https://github.com/WLNYAANYAA/ai-novelist-studio/releases) から最新の `AI.Novelist.Studio.Setup.x.x.x.exe`（インストーラー）または `AI.Novelist.Studio.exe`（ポータブル）をダウンロードしてください。

## 起動方法（開発者向け）

```sh
npm install
npm start          # → http://localhost:3737
npm run desktop    # Electronアプリとして起動
npm run dist       # Windowsインストーラーをビルド
```

### 文体分析の本家スコア（MeCab + UniDic）

ツールメニューの「文体を分析」は、MeCab + UniDic があれば **jReadability の本家スコアを実計測**します。リリース版インストーラーには `tools/`（約200MB）が同梱されるため追加設定は不要です。開発環境やセルフホストで有効化する場合：

```sh
npm run setup:readability   # MeCab + UniDic を tools/ に自動ダウンロード
```

あるいは環境変数で独自の辞書を指定できます：

- `JREAD_UNIDIC` — UniDic辞書ディレクトリ（`sys.dic` を含むもの）
- `PATH` — `mecab` コマンドが見つかるようにする

MeCab/UniDicが無い環境では自動的に近似メトリクスにフォールバックします。

クラウド（スマホ・ChromeOS）で使う場合は [DEPLOY.md](DEPLOY.md) を参照してください。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=WLNYAANYAA/ai-novelist-studio)

## 設定

初回起動後、設定画面で以下を登録してください：

- **APIプロバイダ / API Base URL**（デフォルト: AIのべりすと `https://api.tringpt.com/v1`、OpenAI・Ollama・LM Studio・カスタムOpenAI互換も可）
- **APIキー**（ローカルLLMの場合は「APIキー不要」にチェック）
- **モデル**（デフォルト: `spiko_ultra`）

## 技術構成

- **サーバー**: Node.js + Express（REST API + AI APIプロキシ + 静的配信）
- **データ**: SQLite（`node:sqlite`、初回起動時に旧JSONから自動移行）
- **フロントエンド**: HTML/CSS/バニラJS ES Modules（marked + DOMPurify）
- **デスクトップ**: Electron（contextIsolation有効）
- **CI/CD**: GitHub Actions でタグpush→Windowsビルド→Releases自動公開

## セキュリティ

- APIキーはサーバー側にのみ保存され、ブラウザには送信されません
- Markdown出力はDOMPurifyでサニタイズ
- クラウド公開時は `ACCESS_TOKEN` 環境変数でアクセスキー認証を推奨
- LAN公開は `lanAccess` 設定で明示的に有効化（同一Wi-Fi内のみ）

## About

AI Novelist Studio は、生成AIとの対話を通じて小説を「会話 → 整理 → 原稿化」する流れを一つのツールにまとめた個人開発プロジェクトです。

- **作者**: kirik
- **ライセンス**: MIT（[LICENSE](LICENSE) 参照）
- **リポジトリ**: https://github.com/WLNYAANYAA/ai-novelist-studio

## クレジット

- フロントエンドのMarkdown描画に [marked.js](https://marked.js.org/) / [DOMPurify](https://github.com/cure53/DOMPurify) を使用
- 文体分析に [jreadability](https://github.com/joshdavham/jreadability)（MeCab + UniDic）を使用。MeCabはトライデュアルライセンス（BSD選択）、UniDicはNINJALのライセンスに基づき同梱
- AI推論はユーザー自身のAPIキーまたはローカルLLMで実行（本ソフトウェア自体はAIモデルを内蔵しません）
