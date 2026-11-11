# MeCab + UniDic をダウンロードして tools/ に配置するセットアップスクリプト。
# 文体分析の「本家 jReadability スコア」を有効化するために必要。
# 使い方: npm run setup:readability
# 配置後は `node server.js` / `npm run dist` で自動検出される。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequestの進捗表示を抑制

# --- 1. MeCab (64bit, ikegami-yukino ビルド) ---
$mecabDir = Join-Path $root 'tools\mecab-dist'
if (-not (Test-Path (Join-Path $mecabDir 'bin\mecab.exe'))) {
    Write-Host '[1/2] MeCab をダウンロード・インストール中...'
    $installer = Join-Path $env:TEMP 'mecab-64-0.996.2.exe'
    Invoke-WebRequest -Uri 'https://github.com/ikegami-yukino/mecab/releases/download/v0.996.2/mecab-64-0.996.2.exe' -OutFile $installer
    # /DIR はインストール先。ディレクトリ名は mecab-dist 固定
    # （バイナリが相対パスで etc/mecabrc を参照するためリネーム不可）
    Start-Process -FilePath $installer -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/DIR=`"$mecabDir`"" -Wait
    Remove-Item $installer -Force
    # IPA辞書は使わない（UniDicを使う）ので削除して容量削減
    Remove-Item (Join-Path $mecabDir 'dic') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  -> $mecabDir"
} else {
    Write-Host '[1/2] MeCab は既に存在します。スキップ。'
}

# --- 2. UniDic (unidic-mecab 2.1.1 CWJ, Windows版) ---
$unidicDir = Join-Path $root 'tools\unidic-mecab'
if (-not (Test-Path (Join-Path $unidicDir 'sys.dic'))) {
    Write-Host '[2/2] UniDic をダウンロード・展開中...（約200MB・数分かかります）'
    $zip = Join-Path $env:TEMP 'unidic-mecab-211_windows.zip'
    Invoke-WebRequest -Uri 'https://clrd.ninjal.ac.jp/unidic_archive/cwj/2.1.1/unidic-mecab-211_windows.zip' -OutFile $zip
    $tmp = Join-Path $env:TEMP 'unidic-extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp
    $dicSrc = Join-Path $tmp 'Files\dic\unidic-mecab'
    if (Test-Path $unidicDir) { Remove-Item $unidicDir -Recurse -Force }
    Move-Item $dicSrc $unidicDir
    Remove-Item $zip -Force
    Remove-Item $tmp -Recurse -Force
    Write-Host "  -> $unidicDir"
} else {
    Write-Host '[2/2] UniDic は既に存在します。スキップ。'
}

# --- 検証 ---
$ok = (Test-Path (Join-Path $mecabDir 'bin\mecab.exe')) -and (Test-Path (Join-Path $unidicDir 'sys.dic'))
if ($ok) {
    Write-Host ''
    Write-Host 'セットアップ完了。文体分析で本家 jReadability スコアが有効になります。'
} else {
    Write-Host 'セットアップに失敗しました。上記のエラーを確認してください。' -ForegroundColor Red
    exit 1
}
