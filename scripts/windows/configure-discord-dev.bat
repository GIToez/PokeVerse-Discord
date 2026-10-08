@echo off
rem One-time configuration of the development bot (token, server, game bridge secret).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure-discord-dev.ps1" %*
if errorlevel 1 (
  if not defined PV_NO_PAUSE pause
  exit /b 1
)
exit /b 0
