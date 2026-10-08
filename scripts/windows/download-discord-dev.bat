@echo off
rem Downloads the latest development build from GitHub Actions and installs or updates it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0download-discord-dev.ps1" %*
if errorlevel 1 (
  if not defined PV_NO_PAUSE pause
  exit /b 1
)
exit /b 0
