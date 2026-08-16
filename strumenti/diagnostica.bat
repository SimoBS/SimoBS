@echo off
rem Doppio click su questo file su OGNI computer che vuoi usare:
rem le quattro casse, i portatili di cucina e bar, e il PC che fara' da server.
rem
rem Non installa niente e non modifica niente: legge le caratteristiche del PC
rem e le stampanti collegate, e scrive un file di testo qui accanto.

chcp 65001 >nul
title Diagnostica SimoBS
cd /d "%~dp0"

echo.
echo   Raccolgo le informazioni di questo computer...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostica.ps1"

if errorlevel 1 (
  echo.
  echo   Qualcosa non ha funzionato. Prova ad aprire questo file
  echo   con il tasto destro ^> "Esegui come amministratore".
)

pause
