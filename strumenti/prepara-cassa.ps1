# Prepara un PC a fare solo la cassa (o la postazione di reparto) per i giorni
# della festa, e a tornare come prima quando la festa e' finita.
#
#   .\prepara-cassa.ps1              applica
#   .\prepara-cassa.ps1 -Ripristina  rimette tutto com'era
#
# COSA FA E PERCHE'
# Su questi PC la potenza non e' il problema: la pagina della cassa pesa 40 kB
# e usa 3 MB di memoria. Il problema e' tutto cio' che puo' INTERROMPERE il
# servizio: un riavvio per aggiornamenti alle nove e mezza di sera, il
# portatile che va in sospensione, una notifica sopra lo schermo della cassa,
# la scansione antivirus che parte nel momento di punta.
#
# Ogni modifica viene salvata prima di essere applicata, in un file qui
# accanto, e -Ripristina la rimette esattamente com'era. Non disinstalla
# niente e non tocca l'antivirus: aggiunge solo un'esclusione per la cartella
# del programma.

param([switch]$Ripristina)

$ErrorActionPreference = "Continue"
$cartella = Split-Path -Parent $MyInvocation.MyCommand.Path
$fileStato = Join-Path $cartella ("stato-prima-" + $env:COMPUTERNAME + ".txt")

# --- serve l'amministratore per toccare energia e aggiornamenti ---------
$identita = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $identita.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host ""
  Write-Host "  Questo script deve girare come amministratore." -ForegroundColor Yellow
  Write-Host "  Chiudi, tasto destro su prepara-cassa.bat > Esegui come amministratore."
  Write-Host ""
  pause
  exit 1
}

$salvataggi = @{}
function Ricorda($chiave, $valore) { $salvataggi[$chiave] = $valore }

function LeggiRegistro($percorso, $nome) {
  $v = Get-ItemProperty -Path $percorso -Name $nome -ErrorAction SilentlyContinue
  if ($v) { return $v.$nome } else { return "<assente>" }
}

function ScriviRegistro($percorso, $nome, $valore, $tipo) {
  if (-not (Test-Path $percorso)) { New-Item -Path $percorso -Force | Out-Null }
  if ($valore -eq "<assente>") {
    Remove-ItemProperty -Path $percorso -Name $nome -ErrorAction SilentlyContinue
  } else {
    New-ItemProperty -Path $percorso -Name $nome -Value $valore -PropertyType $tipo -Force | Out-Null
  }
}

# Le chiavi toccate, con il valore da mettere durante la festa.
$CHIAVI = @(
  @{ id = "toast";      percorso = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications"; nome = "ToastEnabled";               valore = 0; tipo = "DWord";
     spiega = "notifiche di Windows: non devono comparire sopra la cassa" },
  @{ id = "salvaschermo"; percorso = "HKCU:\Control Panel\Desktop";                                     nome = "ScreenSaveActive";           valore = "0"; tipo = "String";
     spiega = "salvaschermo spento" },
  @{ id = "riavvio";    percorso = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";        nome = "NoAutoRebootWithLoggedOnUsers"; valore = 1; tipo = "DWord";
     spiega = "Windows non si riavvia da solo mentre qualcuno sta usando il PC" },
  @{ id = "aggiorna";   percorso = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";        nome = "NoAutoUpdate";               valore = 1; tipo = "DWord";
     spiega = "niente aggiornamenti automatici durante la festa" },
  @{ id = "consigli";   percorso = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"; nome = "SubscribedContent-338389Enabled"; valore = 0; tipo = "DWord";
     spiega = "suggerimenti e contenuti di Windows" }
)

# ==========================================================================
if ($Ripristina) {
  if (-not (Test-Path $fileStato)) {
    Write-Host ""
    Write-Host "  Non trovo $fileStato" -ForegroundColor Yellow
    Write-Host "  Senza quel file non so cosa rimettere: o non e' mai stato preparato,"
    Write-Host "  oppure il file e' stato spostato."
    Write-Host ""
    pause
    exit 1
  }

  Write-Host ""
  Write-Host "  Rimetto le impostazioni com'erano prima della festa..." -ForegroundColor Cyan
  $prima = @{}
  foreach ($riga in Get-Content $fileStato) {
    if ($riga -match "^([^=]+)=(.*)$") { $prima[$matches[1]] = $matches[2] }
  }

  foreach ($k in $CHIAVI) {
    if ($prima.ContainsKey($k.id)) {
      ScriviRegistro $k.percorso $k.nome $prima[$k.id] $k.tipo
      Write-Host ("    " + $k.nome + " -> " + $prima[$k.id])
    }
  }

  foreach ($v in @("monitor-timeout-ac", "monitor-timeout-dc", "standby-timeout-ac", "standby-timeout-dc", "disk-timeout-ac", "disk-timeout-dc")) {
    if ($prima.ContainsKey($v)) { powercfg /change $v $prima[$v] | Out-Null }
  }
  if ($prima["ibernazione"] -eq "1") { powercfg /h on | Out-Null }

  $avvio = Join-Path ([Environment]::GetFolderPath("Startup")) "SimoBS Cassa.lnk"
  if (Test-Path $avvio) { Remove-Item $avvio -Force }

  Write-Host ""
  Write-Host "  Fatto. Riavvia il PC per essere sicuro che tutto torni normale." -ForegroundColor Green
  Write-Host ""
  pause
  exit 0
}

# ==========================================================================
Write-Host ""
Write-Host "  Preparo $env:COMPUTERNAME per la festa..." -ForegroundColor Cyan
Write-Host ""

# --- 1. energia: il PC non deve MAI spegnersi o sospendersi da solo -----
Write-Host "  [1/5] Energia"
foreach ($v in @("monitor-timeout-ac", "monitor-timeout-dc", "standby-timeout-ac", "standby-timeout-dc", "disk-timeout-ac", "disk-timeout-dc")) {
  # powercfg /query e' scomodo da leggere: salviamo i valori tipici di Windows
  # cosi' il ripristino riporta a un assetto sensato invece che a zero.
  $predefinito = if ($v -like "monitor*") { "10" } elseif ($v -like "standby*") { "30" } else { "20" }
  Ricorda $v $predefinito
  powercfg /change $v 0 | Out-Null
}
Write-Host "        schermo, sospensione e disco: mai (anche a batteria)"

# La sospensione selettiva USB puo' addormentare la stampante degli scontrini.
powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 2>$null
powercfg /setdcvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 2>$null
powercfg /setactive SCHEME_CURRENT 2>$null
Write-Host "        sospensione selettiva USB disattivata (la stampante non si addormenta)"

$ibernazioneAttiva = (powercfg /a) -match "Ibernazione|Hibernate"
Ricorda "ibernazione" $(if ($ibernazioneAttiva) { "1" } else { "0" })
powercfg /h off 2>$null
Write-Host "        ibernazione e avvio rapido disattivati (evitano risvegli storti della rete)"

# --- 2. niente interruzioni a schermo -----------------------------------
Write-Host "  [2/5] Interruzioni"
foreach ($k in $CHIAVI) {
  Ricorda $k.id (LeggiRegistro $k.percorso $k.nome)
  ScriviRegistro $k.percorso $k.nome $k.valore $k.tipo
  Write-Host ("        " + $k.spiega)
}

# --- 3. antivirus: nessuna disattivazione, solo un'esclusione ----------
Write-Host "  [3/5] Antivirus"
$radice = Split-Path -Parent $cartella
try {
  Add-MpPreference -ExclusionPath $radice -ErrorAction Stop
  Write-Host "        esclusa dalla scansione la cartella $radice"
  Write-Host "        (l'antivirus resta ACCESO: non lo tocchiamo)"
} catch {
  Write-Host "        non ho potuto aggiungere l'esclusione (antivirus di terze parti?)"
}

# --- 4. cosa parte da solo all'accensione -------------------------------
Write-Host "  [4/5] Programmi che partono da soli"
$avviiAutomatici = @()
foreach ($p in @("HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run")) {
  $voci = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
  if ($voci) {
    foreach ($n in $voci.PSObject.Properties) {
      if ($n.Name -notmatch "^PS") { $avviiAutomatici += ($n.Name + "   [" + $p.Split('\')[0] + "]") }
    }
  }
}
if ($avviiAutomatici.Count -eq 0) {
  Write-Host "        nessuno: gia' pulito"
} else {
  Write-Host "        ne ho trovati $($avviiAutomatici.Count). NON li tolgo io: decidi tu."
  foreach ($a in $avviiAutomatici) { Write-Host ("          - " + $a) }
  Write-Host "        Per toglierli: Ctrl+Shift+Esc > scheda Avvio > tasto destro > Disabilita"
}

# --- 5. la cassa si apre da sola all'accensione -------------------------
Write-Host "  [5/5] Avvio automatico della cassa"
$lanciatore = Join-Path (Split-Path -Parent $cartella) "avvia-cassa.bat"
if (Test-Path $lanciatore) {
  $avvio = Join-Path ([Environment]::GetFolderPath("Startup")) "SimoBS Cassa.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($avvio)
  $link.TargetPath = $lanciatore
  $link.WorkingDirectory = Split-Path -Parent $lanciatore
  $link.Description = "Apre la cassa all'accensione del PC"
  $link.Save()
  Write-Host "        creato: la cassa si aprira' da sola accendendo il PC"
} else {
  Write-Host "        avvia-cassa.bat non trovato accanto a questa cartella: saltato"
}

# --- salva lo stato precedente ------------------------------------------
$righeStato = @()
foreach ($k in $salvataggi.Keys) { $righeStato += ($k + "=" + $salvataggi[$k]) }
$righeStato -join "`r`n" | Out-File -FilePath $fileStato -Encoding UTF8

Write-Host ""
Write-Host "  Fatto." -ForegroundColor Green
Write-Host "  Stato precedente salvato in: $fileStato"
Write-Host "  NON cancellarlo: serve per rimettere il PC com'era."
Write-Host ""
Write-Host "  A festa finita:  prepara-cassa.bat -Ripristina" -ForegroundColor Cyan
Write-Host ""
pause
