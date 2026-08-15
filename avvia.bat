@echo off
rem Avvio del gestionale sul PC che fa da server sotto il tendone.
rem Lasciare questa finestra APERTA per tutta la serata: se si chiude,
rem le casse smettono di funzionare.

chcp 65001 >nul
title SimoBS - gestione festa
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js non risulta installato su questo PC.
  echo.
  echo   Scaricalo da https://nodejs.org ^(versione LTS^), installalo
  echo   lasciando tutte le opzioni predefinite, poi riavvia questo file.
  echo.
  pause
  exit /b 1
)

rem Serve node:sqlite, disponibile dalla 22.5 in poi.
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set MAJOR=%%v
if %MAJOR% LSS 22 (
  echo.
  echo   Versione di Node.js troppo vecchia ^(serve la 22 o successiva^).
  echo   Installa la versione LTS da https://nodejs.org
  echo.
  pause
  exit /b 1
)

node --no-warnings src\server.js

echo.
echo   Il programma si e' chiuso.
pause
