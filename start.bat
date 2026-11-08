@echo off
pushd "%~dp0"

rem --- Node.js チェック＆自動インストール ---
where node >nul 2>nul
if not errorlevel 1 goto :run
if exist "C:\Program Files\nodejs\node.exe" (
  set "PATH=%PATH%;C:\Program Files\nodejs"
  goto :run
)

echo Node.js が見つかりません。インストールを試みます...
where winget >nul 2>nul
if errorlevel 1 (
  echo winget が見つかりません。https://nodejs.org から Node.js LTS を手動インストールして再実行してください。
  pause
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
if errorlevel 1 (
  echo インストールに失敗しました。https://nodejs.org から Node.js LTS を手動インストールしてください。
  pause
  exit /b 1
)
rem インストール直後はPATHに未反映のため手動で追加
set "PATH=%PATH%;C:\Program Files\nodejs"
where node >nul 2>nul
if errorlevel 1 (
  echo インストールは完了しました。このウィンドウを閉じて再度 start.bat を実行してください。
  pause
  exit /b 1
)

:run
echo AI Novelist Studio を起動します...
start "" http://localhost:3737
node server.js
popd
pause
