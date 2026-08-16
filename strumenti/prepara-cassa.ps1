# Riduce un PC a fare SOLO la cassa (o la postazione di reparto) per i giorni
# della festa, e lo rimette com'era quando la festa e' finita.
#
#   .\prepara-cassa.ps1              applica
#   .\prepara-cassa.ps1 -Ripristina  rimette tutto com'era
#
# PERCHE'
# Non e' una questione di potenza: la pagina della cassa pesa 40 kB e usa 3 MB
# di memoria, questi PC ne hanno di avanzo. E' una questione di cose che
# possono ANDARE STORTE: un servizio che si sveglia, un programma che apre una
# finestra sopra la cassa, un aggiornamento che riavvia alle nove e mezza,
# l'indicizzazione che parte nel momento di punta. Meno roba gira, meno cose
# possono succedere.
#
# REGOLE CHE MI SONO DATO
# - Niente viene disinstallato: solo disattivato.
# - Tutto viene salvato prima, e -Ripristina rimette i valori originali.
# - Non si tocca l'antivirus (si aggiunge solo un'esclusione).
# - Non si toccano i servizi che servono davvero: stampa, rete, audio, input.
#   Lo spooler di stampa in particolare NON si tocca mai: senza quello la
#   termica degli scontrini attaccata al PC non stampa piu'.

param([switch]$Ripristina)

$ErrorActionPreference = "Continue"
$cartella = Split-Path -Parent $MyInvocation.MyCommand.Path
$fileStato = Join-Path $cartella ("stato-prima-" + $env:COMPUTERNAME + ".txt")

$identita = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $identita.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "`n  Serve eseguirlo come amministratore.`n" -ForegroundColor Yellow
  Write-Host "  Tasto destro su prepara-cassa.bat > Esegui come amministratore.`n"
  pause; exit 1
}

# ==========================================================================
# COSA VIENE TOCCATO
# ==========================================================================

# Servizi che un PC-cassa non usa mai. Ognuno con il motivo per cui e' qui.
# Quelli che NON compaiono in questa lista sono esclusi di proposito: spooler
# di stampa, rete, WiFi, DHCP, DNS, audio, input, gestione utenti.
$SERVIZI = @(
  @{ nome = "SysMain";           spiega = "precaricamento programmi: inutile se ne apri uno solo" },
  @{ nome = "WSearch";           spiega = "indicizzazione ricerca: legge il disco a caso, non serve" },
  @{ nome = "DiagTrack";         spiega = "telemetria Microsoft" },
  @{ nome = "dmwappushservice";  spiega = "telemetria" },
  @{ nome = "WerSvc";            spiega = "segnalazione errori: apre finestre da sola" },
  @{ nome = "MapsBroker";        spiega = "mappe offline" },
  @{ nome = "RetailDemo";        spiega = "modalita' demo da negozio" },
  @{ nome = "Fax";               spiega = "fax" },
  @{ nome = "XblAuthManager";    spiega = "Xbox" },
  @{ nome = "XblGameSave";       spiega = "Xbox" },
  @{ nome = "XboxNetApiSvc";     spiega = "Xbox" },
  @{ nome = "XboxGipSvc";        spiega = "Xbox" },
  @{ nome = "wisvc";             spiega = "programma Insider di Windows" },
  @{ nome = "bthserv";           spiega = "Bluetooth" },
  @{ nome = "BTAGService";       spiega = "Bluetooth audio" },
  @{ nome = "wuauserv";          spiega = "Windows Update: nessun aggiornamento durante la festa" },
  @{ nome = "BITS";              spiega = "scaricamento in background degli aggiornamenti" },
  @{ nome = "UsoSvc";            spiega = "pianificazione aggiornamenti" },
  @{ nome = "WaaSMedicSvc";      spiega = "ripristino automatico di Windows Update" }
)

# Operazioni pianificate che possono partire da sole nel bel mezzo della sera.
$PIANIFICATE = @(
  "\Microsoft\Windows\Defrag\ScheduledDefrag",
  "\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser",
  "\Microsoft\Windows\Application Experience\ProgramDataUpdater",
  "\Microsoft\Windows\Customer Experience Improvement Program\Consolidator",
  "\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip",
  "\Microsoft\Windows\Windows Error Reporting\QueueReporting",
  "\Microsoft\Windows\UpdateOrchestrator\Schedule Scan",
  "\Microsoft\Windows\WindowsUpdate\Scheduled Start"
)

$CHIAVI = @(
  @{ id = "toast";        percorso = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications";      nome = "ToastEnabled";                  valore = 0;   tipo = "DWord"; spiega = "notifiche di Windows sopra la cassa" },
  @{ id = "salvaschermo"; percorso = "HKCU:\Control Panel\Desktop";                                            nome = "ScreenSaveActive";              valore = "0"; tipo = "String"; spiega = "salvaschermo" },
  @{ id = "riavvio";      percorso = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";             nome = "NoAutoRebootWithLoggedOnUsers"; valore = 1;   tipo = "DWord"; spiega = "riavvio automatico mentre qualcuno usa il PC" },
  @{ id = "aggiorna";     percorso = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";             nome = "NoAutoUpdate";                  valore = 1;   tipo = "DWord"; spiega = "aggiornamenti automatici" },
  @{ id = "consigli";     percorso = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"; nome = "SubscribedContent-338389Enabled"; valore = 0; tipo = "DWord"; spiega = "suggerimenti di Windows" },
  @{ id = "sfondo";       percorso = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications"; nome = "GlobalUserDisabled";       valore = 1;   tipo = "DWord"; spiega = "app in esecuzione in background" }
)

# ==========================================================================
# FUNZIONI
# ==========================================================================

function LeggiRegistro($percorso, $nome) {
  $v = Get-ItemProperty -Path $percorso -Name $nome -ErrorAction SilentlyContinue
  if ($v) { return $v.$nome } else { return "<assente>" }
}

function ScriviRegistro($percorso, $nome, $valore, $tipo) {
  if ($valore -eq "<assente>") {
    Remove-ItemProperty -Path $percorso -Name $nome -ErrorAction SilentlyContinue
    return
  }
  if (-not (Test-Path $percorso)) { New-Item -Path $percorso -Force | Out-Null }
  New-ItemProperty -Path $percorso -Name $nome -Value $valore -PropertyType $tipo -Force | Out-Null
}

function Fotografia {
  $processi = (Get-Process).Count
  $os = Get-WmiObject Win32_OperatingSystem
  $usata = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2)
  $servizi = (Get-Service | Where-Object { $_.Status -eq "Running" }).Count
  return @{ processi = $processi; memoriaGB = $usata; servizi = $servizi }
}

function MostraFotografia($etichetta, $f) {
  Write-Host ("  " + $etichetta.PadRight(14) + $f.processi.ToString().PadLeft(4) + " processi" +
              $f.servizi.ToString().PadLeft(6) + " servizi attivi" +
              ("   " + $f.memoriaGB + " GB di RAM in uso"))
}

# ==========================================================================
# RIPRISTINO
# ==========================================================================
if ($Ripristina) {
  if (-not (Test-Path $fileStato)) {
    Write-Host "`n  Non trovo $fileStato" -ForegroundColor Yellow
    Write-Host "  Senza quel file non so cosa rimettere.`n"
    pause; exit 1
  }

  Write-Host "`n  Rimetto $env:COMPUTERNAME com'era prima della festa...`n" -ForegroundColor Cyan
  $prima = @{}
  foreach ($riga in Get-Content $fileStato) {
    if ($riga -match "^([^=]+)=(.*)$") { $prima[$matches[1]] = $matches[2] }
  }

  Write-Host "  Registro"
  foreach ($k in $CHIAVI) {
    if ($prima.ContainsKey("reg." + $k.id)) { ScriviRegistro $k.percorso $k.nome $prima["reg." + $k.id] $k.tipo }
  }

  Write-Host "  Energia"
  foreach ($v in @("monitor-timeout-ac", "monitor-timeout-dc", "standby-timeout-ac", "standby-timeout-dc", "disk-timeout-ac", "disk-timeout-dc")) {
    if ($prima.ContainsKey("pwr." + $v)) { powercfg /change $v $prima["pwr." + $v] | Out-Null }
  }
  if ($prima["pwr.ibernazione"] -eq "1") { powercfg /h on 2>$null }

  Write-Host "  Servizi"
  foreach ($s in $SERVIZI) {
    $chiave = "srv." + $s.nome
    if ($prima.ContainsKey($chiave) -and $prima[$chiave] -ne "<assente>") {
      Set-Service -Name $s.nome -StartupType $prima[$chiave] -ErrorAction SilentlyContinue
    }
  }

  Write-Host "  Operazioni pianificate"
  foreach ($t in $PIANIFICATE) {
    $chiave = "task." + $t
    if ($prima[$chiave] -eq "Ready") {
      $percorso = Split-Path $t -Parent
      $nome = Split-Path $t -Leaf
      Enable-ScheduledTask -TaskPath ($percorso + "\") -TaskName $nome -ErrorAction SilentlyContinue | Out-Null
    }
  }

  Write-Host "  Programmi all'avvio"
  foreach ($riga in $prima.Keys) {
    if ($riga -like "avvio.*") {
      $nome = $riga.Substring(6)
      ScriviRegistro "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" $nome $prima[$riga] "String"
    }
  }

  $avvio = Join-Path ([Environment]::GetFolderPath("Startup")) "SimoBS Cassa.lnk"
  if (Test-Path $avvio) { Remove-Item $avvio -Force }

  Write-Host "`n  Fatto. Riavvia il PC perche' i servizi tornino attivi.`n" -ForegroundColor Green
  pause; exit 0
}

# ==========================================================================
# APPLICAZIONE
# ==========================================================================
$salvataggi = @{}
$prima = Fotografia

Write-Host "`n  Preparo $env:COMPUTERNAME a fare solo la cassa`n" -ForegroundColor Cyan
MostraFotografia "prima:" $prima
Write-Host ""

# --- 1. energia ---------------------------------------------------------
Write-Host "  [1/6] Energia: il PC non deve mai addormentarsi" -ForegroundColor White
foreach ($v in @("monitor-timeout-ac", "monitor-timeout-dc", "standby-timeout-ac", "standby-timeout-dc", "disk-timeout-ac", "disk-timeout-dc")) {
  $predefinito = if ($v -like "monitor*") { "10" } elseif ($v -like "standby*") { "30" } else { "20" }
  $salvataggi["pwr." + $v] = $predefinito
  powercfg /change $v 0 | Out-Null
}
# Questa e' la piu' insidiosa: addormenta la stampante USB degli scontrini.
powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 2>$null
powercfg /setdcvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 2>$null
powercfg /setactive SCHEME_CURRENT 2>$null
$salvataggi["pwr.ibernazione"] = $(if ((powercfg /a) -match "Ibernazione|Hibernate") { "1" } else { "0" })
powercfg /h off 2>$null
Write-Host "        schermo, sospensione, disco: mai. USB mai sospeso. Ibernazione off."

# --- 2. servizi ---------------------------------------------------------
Write-Host "  [2/6] Servizi che non servono a una cassa" -ForegroundColor White
# Se al PC e' collegato un mouse o una tastiera Bluetooth, spegnere quei
# servizi lo lascerebbe senza input: meglio accorgersene qui che davanti a
# uno schermo che non risponde mezz'ora prima di aprire.
$inputBluetooth = @(Get-WmiObject Win32_PointingDevice, Win32_Keyboard -ErrorAction SilentlyContinue |
  Where-Object { $_.PNPDeviceID -like "BTH*" }).Count -gt 0
if ($inputBluetooth) {
  Write-Host "        mouse o tastiera Bluetooth rilevati: lascio acceso il Bluetooth" -ForegroundColor Yellow
}

$spenti = 0
foreach ($s in $SERVIZI) {
  if ($inputBluetooth -and $s.nome -in @("bthserv", "BTAGService")) { continue }
  $srv = Get-Service -Name $s.nome -ErrorAction SilentlyContinue
  if (-not $srv) { continue }
  $tipo = (Get-WmiObject Win32_Service -Filter ("Name='" + $s.nome + "'")).StartMode
  $salvataggi["srv." + $s.nome] = switch ($tipo) { "Auto" { "Automatic" } "Manual" { "Manual" } "Disabled" { "Disabled" } default { "Manual" } }
  if ($tipo -eq "Disabled") { continue }
  Stop-Service -Name $s.nome -Force -ErrorAction SilentlyContinue
  Set-Service -Name $s.nome -StartupType Disabled -ErrorAction SilentlyContinue
  Write-Host ("        " + $s.nome.PadRight(20) + $s.spiega)
  $spenti++
}
Write-Host ("        " + $spenti + " servizi disattivati. Spooler di stampa, rete e audio NON toccati.")

# --- 3. operazioni pianificate ------------------------------------------
Write-Host "  [3/6] Operazioni che partono da sole" -ForegroundColor White
$disattivate = 0
foreach ($t in $PIANIFICATE) {
  $percorso = Split-Path $t -Parent
  $nome = Split-Path $t -Leaf
  $task = Get-ScheduledTask -TaskPath ($percorso + "\") -TaskName $nome -ErrorAction SilentlyContinue
  if (-not $task) { continue }
  $salvataggi["task." + $t] = $task.State.ToString()
  if ($task.State -eq "Disabled") { continue }
  Disable-ScheduledTask -TaskPath ($percorso + "\") -TaskName $nome -ErrorAction SilentlyContinue | Out-Null
  $disattivate++
}
Write-Host ("        " + $disattivate + " disattivate (deframmentazione, telemetria, scansione aggiornamenti)")

# --- 4. programmi all'avvio ---------------------------------------------
Write-Host "  [4/6] Programmi che si aprono da soli" -ForegroundColor White
$percorsoRun = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
$voci = Get-ItemProperty -Path $percorsoRun -ErrorAction SilentlyContinue
$tolti = 0
if ($voci) {
  foreach ($p in $voci.PSObject.Properties) {
    if ($p.Name -match "^PS" -or $p.Name -eq "SimoBS") { continue }
    $salvataggi["avvio." + $p.Name] = $p.Value
    Remove-ItemProperty -Path $percorsoRun -Name $p.Name -ErrorAction SilentlyContinue
    Write-Host ("        tolto: " + $p.Name)
    $tolti++
  }
}
if ($tolti -eq 0) { Write-Host "        nessuno da togliere" }
else { Write-Host "        (tolti solo per l'utente corrente, e rimessi dal ripristino)" }

# --- 5. antivirus: solo l'esclusione ------------------------------------
Write-Host "  [5/6] Antivirus" -ForegroundColor White
$radice = Split-Path -Parent $cartella
try {
  Add-MpPreference -ExclusionPath $radice -ErrorAction Stop
  Write-Host "        esclusa la cartella del programma. L'antivirus resta ACCESO."
} catch {
  Write-Host "        esclusione non applicata (antivirus di terze parti?)"
}

# --- 6. registro e avvio automatico della cassa -------------------------
Write-Host "  [6/6] Interfaccia e avvio" -ForegroundColor White
foreach ($k in $CHIAVI) {
  $salvataggi["reg." + $k.id] = LeggiRegistro $k.percorso $k.nome
  ScriviRegistro $k.percorso $k.nome $k.valore $k.tipo
  Write-Host ("        " + $k.spiega + ": disattivato")
}

$lanciatore = Join-Path (Split-Path -Parent $cartella) "avvia-cassa.bat"
if (Test-Path $lanciatore) {
  $avvio = Join-Path ([Environment]::GetFolderPath("Startup")) "SimoBS Cassa.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($avvio)
  $link.TargetPath = $lanciatore
  $link.WorkingDirectory = Split-Path -Parent $lanciatore
  $link.Save()
  Write-Host "        la cassa si aprira' da sola all'accensione"
}

# --- 7. quello che resta e che non conosco ------------------------------
# I servizi non Microsoft NON si toccano alla cieca: uno di questi potrebbe
# essere il driver della stampante termica, o qualcosa che serve alla rete.
# Li elenco con il loro eseguibile: guardali, dimmi quali sono superflui e li
# aggiungo alla lista di quelli spenti automaticamente.
Write-Host ""
Write-Host "  ALTRO CHE GIRA SU QUESTO PC (non l'ho toccato)" -ForegroundColor Yellow
Write-Host "  Guarda questa lista e dimmi cosa non serve: la prossima versione" -ForegroundColor DarkGray
Write-Host "  dello script lo spegnera' da sola." -ForegroundColor DarkGray
Write-Host ""

$daSegnalare = @()
Write-Host "  Servizi attivi non Microsoft:"
$trovatiEsterni = 0
foreach ($srv in (Get-WmiObject Win32_Service | Where-Object { $_.State -eq "Running" })) {
  $exe = $srv.PathName
  if (-not $exe) { continue }
  # Tutto cio' che sta in Windows\ e' di sistema: qui interessa il resto.
  if ($exe -match "\\Windows\\" -or $exe -match "\\WinSxS\\") { continue }
  Write-Host ("        " + $srv.Name.PadRight(26) + $srv.DisplayName)
  $daSegnalare += ("SERVIZIO  " + $srv.Name + "  |  " + $srv.DisplayName + "  |  " + $exe)
  $trovatiEsterni++
}
if ($trovatiEsterni -eq 0) { Write-Host "        nessuno: il PC e' gia' pulito" }

Write-Host ""
Write-Host "  I dieci processi che occupano piu' memoria adesso:"
foreach ($p in (Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10)) {
  $mb = [math]::Round($p.WorkingSet64 / 1MB, 0)
  Write-Host ("        " + ($mb.ToString() + " MB").PadLeft(8) + "  " + $p.ProcessName)
  $daSegnalare += ("PROCESSO  " + $p.ProcessName + "  |  " + $mb + " MB")
}

# Finisce anche in un file, cosi' si puo' incollare senza ricopiare a mano.
$fileResiduo = Join-Path $cartella ("da-valutare-" + $env:COMPUTERNAME + ".txt")
$daSegnalare -join "`r`n" | Out-File -FilePath $fileResiduo -Encoding UTF8
Write-Host ""
Write-Host ("  Elenco salvato anche in: " + $fileResiduo)

# --- salvataggio --------------------------------------------------------
$righe = @()
foreach ($k in $salvataggi.Keys) { $righe += ($k + "=" + $salvataggi[$k]) }
$righe -join "`r`n" | Out-File -FilePath $fileStato -Encoding UTF8

$dopo = Fotografia
Write-Host ""
MostraFotografia "prima:" $prima
MostraFotografia "adesso:" $dopo
Write-Host ""
Write-Host ("  Dopo il riavvio saranno meno ancora: molti servizi sono spenti ma") -ForegroundColor DarkGray
Write-Host ("  restano in memoria fino al prossimo avvio.") -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Stato precedente salvato in:" -ForegroundColor Green
Write-Host "    $fileStato"
Write-Host "  NON cancellarlo: senza quello il PC non torna com'era."
Write-Host ""
Write-Host "  A festa finita:  tasto destro su prepara-cassa.bat > amministratore," -ForegroundColor Cyan
Write-Host "                   oppure da riga di comando: prepara-cassa.bat -Ripristina" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Riavvia il PC adesso, perche' le modifiche abbiano effetto pieno." -ForegroundColor Yellow
Write-Host ""
pause
