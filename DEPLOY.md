# スマホ/ChromeOSで使うためのデプロイ手順（各自デプロイ方式）

このアプリは「PCでサーバーを動かす」前提ですが、Render等のクラウドに**各自が自分のインスタンスを立てる**ことで、スマホやChromeOSのブラウザだけで使えます。

- データ・APIキーは**自分のインスタンスにだけ**保存されます（他人と共有されません）
- 必要なのは Render無料アカウント と AIのべりすとのAPIキー（ルミナ）のみ

## 手順（約10分）

### 1. Renderアカウント作成

- https://render.com → 「Get Started for Free」（GitHubアカウントでOK、カード登録不要）

### 2. このリポジトリをデプロイ

このフォルダをGitHubにpushしてから：

- Render Dashboard → 「New」→「Blueprint」
- GitHubリポジトリを選択 → `render.yaml` を検出 → 「Apply」
- `ACCESS_TOKEN` の入力を求められる → **自分だけが知る合言葉を設定**
  - これを設定しないと、URLを知った誰でもあなたのインスタンスでAPIを使えてしまいます

### 3. AIのべりすとのAPIキーを設定

- デプロイ完了後、発行される `https://xxx.onrender.com` を開く
- アクセスキーを入力して入室
- 設定画面で **APIキー（AIのべりすと開発者向けAPI）** とモデル等を設定して保存

### 4. スマホ/ChromeOSから使う

- スマホ・ChromeOSのブラウザで `https://xxx.onrender.com` を開く
- ブックマーク or 「ホーム画面に追加」でアプリアイコン化

## 注意

- **Render無料枠は15分無操作でスリープ**します。初回アクセスに数十秒かかることがあります
- **無料枠はディスク非対応＝再起動・再デプロイで会話履歴が消えます**。
  - 気になる場合は Render有料プラン（$7/月〜）にして `render.yaml` の disk 設定を有効化
  - または Fly.io / Railway 等のボリューム対応ホスト（Dockerfileはそのまま使えます）
- APIキーは設定画面からいつでも変更・再設定できます
- ACCESS_TOKENを忘れた場合はRenderの環境変数から確認・変更できます
