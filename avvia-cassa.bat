@echo off
rem Avvio della postazione di CASSA (non del server).
rem
rem Apre Chrome a schermo intero sulla pagina della cassa, con la stampa
rem diretta attiva: lo scontrino esce dalla termica attaccata a questo PC
rem senza che compaia la finestra "Stampa" a ogni cliente.
rem
rem PRIMA DI USARLO: metti qui sotto l'indirizzo del PC che fa da server,
rem quello che compare nella sua finestra nera all'avvio.
rem
rem Se QUESTO stesso PC fa anche da server (cioe' ci hai lanciato avvia.bat),
rem allora usa:   set SERVER=http://localhost:8080

set SERVER=http://192.168.1.10:8080

chcp 65001 >nul
title Cassa

rem --kiosk-printing stampa subito sulla stampante predefinita di Windows:
rem assicurati che la predefinita sia la termica degli scontrini.
set OPZIONI=--kiosk-printing --kiosk --disable-pinch --overscroll-history-navigation=0

set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe

if not exist "%CHROME%" (
  echo.
  echo   Google Chrome non trovato.
  echo.
  echo   Serve Chrome ^(o Edge^) per la stampa diretta senza finestra di
  echo   conferma. Con Edge, sostituisci il percorso qui sotto con:
  echo     %ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
  echo.
  pause
  exit /b 1
)

rem Profilo separato: tiene le impostazioni di stampa della cassa distinte
rem da quelle del browser che usi normalmente su questo PC.
start "" "%CHROME%" %OPZIONI% --user-data-dir="%~dp0profilo-cassa" "%SERVER%/cassa.html"
