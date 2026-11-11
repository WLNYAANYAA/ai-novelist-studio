# Download MeCab + UniDic into tools/ to enable the official jReadability score.
# Usage: npm run setup:readability
# After setup, `node server.js` / `npm run dist` auto-detects them.
# NOTE: keep this file ASCII-only — PS 5.1 misreads UTF-8-no-BOM scripts.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Start-Transcript -Path (Join-Path $root 'setup-readability.log') -Force | Out-Null

$ProgressPreference = 'SilentlyContinue'

# --- 1. MeCab (64bit, ikegami-yukino build) ---
$mecabDir = Join-Path $root 'tools\mecab-dist'
$mecabExe = Join-Path $mecabDir 'bin\mecab.exe'
if (-not (Test-Path $mecabExe)) {
    Write-Host '[1/2] Downloading and installing MeCab...'
    $installer = Join-Path $env:TEMP 'mecab-64-0.996.2.exe'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ikegami-yukino/mecab/releases/download/v0.996.2/mecab-64-0.996.2.exe' -OutFile $installer
    # Dir name MUST stay "mecab-dist" (binary resolves etc/mecabrc relatively)
    Start-Process -FilePath $installer -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/DIR=`"$mecabDir`"" -Wait
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    # Wait in case the installer finishes asynchronously via a child process
    $waited = 0
    while (-not (Test-Path $mecabExe) -and $waited -lt 120) { Start-Sleep -Seconds 2; $waited += 2 }
    # IPA dictionary is unused (we use UniDic); remove to save ~95MB
    Remove-Item (Join-Path $mecabDir 'dic') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  -> $mecabDir"
} else {
    Write-Host '[1/2] MeCab already exists. Skipping.'
}

# --- 2. UniDic (unidic-mecab 2.1.1 CWJ, Windows build) ---
$unidicDir = Join-Path $root 'tools\unidic-mecab'
if (-not (Test-Path (Join-Path $unidicDir 'sys.dic'))) {
    Write-Host '[2/2] Downloading and extracting UniDic... (~200MB, may take a few minutes)'
    $zip = Join-Path $env:TEMP 'unidic-mecab-211_windows.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://clrd.ninjal.ac.jp/unidic_archive/cwj/2.1.1/unidic-mecab-211_windows.zip' -OutFile $zip
    $tmp = Join-Path $env:TEMP 'unidic-extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Path $tmp | Out-Null
    # tar.exe (bsdtar) は Expand-Archive よりはるかに高速（CIでのタイムアウト対策）
    & tar.exe -xf $zip -C $tmp
    if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $zip -DestinationPath $tmp }
    $dicSrc = Join-Path $tmp 'Files\dic\unidic-mecab'
    if (Test-Path $unidicDir) { Remove-Item $unidicDir -Recurse -Force }
    Move-Item $dicSrc $unidicDir
    Remove-Item $zip -Force
    Remove-Item $tmp -Recurse -Force
    Write-Host "  -> $unidicDir"
} else {
    Write-Host '[2/2] UniDic already exists. Skipping.'
}

Stop-Transcript | Out-Null

# --- Verify ---
$ok = (Test-Path $mecabExe) -and (Test-Path (Join-Path $unidicDir 'sys.dic'))
if ($ok) {
    Write-Host ''
    Write-Host 'Setup complete. The official jReadability score is now enabled.'
} else {
    Write-Host 'Setup FAILED. Check the errors above.' -ForegroundColor Red
    exit 1
}
