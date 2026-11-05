@echo off
rem 手元の文字起こしサーバーを起動する(初回は準備とモデルのダウンロードに数分かかります)
chcp 65001 > nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 初回の準備をしています...
  py -3.12 -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -q --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :error
)
".venv\Scripts\python.exe" server.py %*
pause
exit /b

:error
echo 準備に失敗しました。Python 3.12 が入っているか確認してください。
pause
