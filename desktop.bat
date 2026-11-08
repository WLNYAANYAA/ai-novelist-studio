@echo off
pushd "%~dp0"

rem --- Node.js �`�F�b�N�������C���X�g�[�� ---
where node >nul 2>nul
if not errorlevel 1 goto :run
if exist "C:\Program Files\nodejs\node.exe" (
  set "PATH=%PATH%;C:\Program Files\nodejs"
  goto :run
)

echo Node.js ��������܂���B�C���X�g�[�������݂܂�...
where winget >nul 2>nul
if errorlevel 1 (
  echo winget ��������܂���Bhttps://nodejs.org ���� Node.js LTS ���蓮�C���X�g�[�����čĎ��s���Ă��������B
  pause
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
if errorlevel 1 (
  echo �C���X�g�[���Ɏ��s���܂����Bhttps://nodejs.org ���� Node.js LTS ���蓮�C���X�g�[�����Ă��������B
  pause
  exit /b 1
)
set "PATH=%PATH%;C:\Program Files\nodejs"
where node >nul 2>nul
if errorlevel 1 (
  echo �C���X�g�[���͊������܂����B���̃E�B���h�E����čēx desktop.bat �����s���Ă��������B
  pause
  exit /b 1
)

:run
set "ELECTRON_RUN_AS_NODE="

rem �l�b�g���[�N�h���C�u(UNC)��ł�Electron���s����Ȃ��߁A���s���̓u���E�U�ł��ē�
npx electron .
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo Electron �̋N���Ɏ��s���܂����B�l�b�g���[�N�h���C�u��ł͕s����ȏꍇ������܂��B
  echo �t�H���_�����[�J���f�B�X�N�ɃR�s�[���Ď��s���邩�Astart.bat �Ńu���E�U�ł������p���������B
  pause
)
