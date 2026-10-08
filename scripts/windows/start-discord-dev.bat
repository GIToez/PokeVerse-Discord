@echo off
rem Starts the PokeVerse Discord bot with the DEVELOPMENT profile.
rem Start the local game server first ("Start Server.bat" in the game package).
setlocal
title PokeVerse Discord Bot (development)
cd /d "%~dp0"

if not exist "node\node.exe" (
  echo node\node.exe is missing. Extract the complete package again.
  goto :failed
)

if not exist ".env.development" (
  echo No configuration found. Starting the one-time configuration...
  echo.
  call "%~dp0configure-discord-dev.bat"
  if errorlevel 1 goto :failed
  if not exist ".env.development" goto :failed
)

"node\node.exe" bot\bot.cjs check-config --profile development --config-dir "%~dp0." >nul
if errorlevel 1 (
  "node\node.exe" bot\bot.cjs check-config --profile development --config-dir "%~dp0."
  echo Fix .env.development or run configure-discord-dev.bat again.
  goto :failed
)

"node\node.exe" bot\bot.cjs check-bridge --profile development --config-dir "%~dp0."
if errorlevel 1 (
  echo.
  echo The game server is not reachable yet. The bot will keep retrying in the background.
  echo.
)

echo Starting the bot. Press Ctrl+C to stop it.
"node\node.exe" bot\bot.cjs start --profile development --config-dir "%~dp0."
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo The bot stopped with an error. Read the messages above.
echo The log file is logs\bot-development.log
if not defined PV_NO_PAUSE pause
exit /b 1
