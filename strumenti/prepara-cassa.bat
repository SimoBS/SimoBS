@echo off
rem Prepara questo PC a fare solo la cassa per i giorni della festa.
rem Va lanciato COME AMMINISTRATORE: tasto destro > Esegui come amministratore.
rem
rem   prepara-cassa.bat              applica
rem   prepara-cassa.bat -Ripristina  rimette tutto com'era a festa finita
rem
rem Tutte le modifiche sono reversibili e vengono salvate in un file qui
rem accanto. Non disinstalla niente e non spegne l'antivirus.

chcp 65001 >nul
title Prepara PC per la festa
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Serve eseguirlo come amministratore.
  echo   Chiudi questa finestra, poi tasto destro su prepara-cassa.bat
  echo   e scegli "Esegui come amministratore".
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepara-cassa.ps1" %*
