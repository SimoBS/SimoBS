# Raccoglie le informazioni di questo PC utili a capire se puo' fare da cassa,
# da postazione di reparto o da server, e che stampanti ha collegate.
#
# Non installa niente, non modifica niente, non serve l'amministratore:
# legge e basta, e scrive un file di testo accanto a se stesso.
#
# Scritto per funzionare anche su Windows 7 con PowerShell 2.0, quindi usa
# Get-WmiObject invece di Get-CimInstance e niente sintassi recente.

$ErrorActionPreference = "SilentlyContinue"

$righe = @()
function Aggiungi($testo) { $script:righe += $testo }
function Titolo($testo) {
  Aggiungi ""
  Aggiungi ("=" * 60)
  Aggiungi $testo
  Aggiungi ("=" * 60)
}

Aggiungi "DIAGNOSTICA SimoBS"
Aggiungi ("PC: " + $env:COMPUTERNAME + "   utente: " + $env:USERNAME)
Aggiungi ("Data: " + (Get-Date).ToString("yyyy-MM-dd HH:mm"))

# --------------------------------------------------------------- sistema
Titolo "SISTEMA"
$os = Get-WmiObject Win32_OperatingSystem
Aggiungi ("Windows      : " + $os.Caption)
Aggiungi ("Versione     : " + $os.Version + "  build " + $os.BuildNumber)
Aggiungi ("Architettura : " + $os.OSArchitecture)
Aggiungi ("PowerShell   : " + $PSVersionTable.PSVersion.ToString())

$cs = Get-WmiObject Win32_ComputerSystem
Aggiungi ("Modello PC   : " + $cs.Manufacturer + " " + $cs.Model)
Aggiungi ("RAM totale   : " + [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) + " GB")
Aggiungi ("RAM libera   : " + [math]::Round($os.FreePhysicalMemory / 1MB, 1) + " GB")

$cpu = Get-WmiObject Win32_Processor | Select-Object -First 1
Aggiungi ("Processore   : " + $cpu.Name.Trim())
Aggiungi ("Core         : " + $cpu.NumberOfCores + " fisici, " + $cpu.NumberOfLogicalProcessors + " logici")

$disco = Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='C:'"
if ($disco) {
  Aggiungi ("Disco C:     : " + [math]::Round($disco.FreeSpace / 1GB, 1) + " GB liberi su " + [math]::Round($disco.Size / 1GB, 1) + " GB")
}

$schermo = Get-WmiObject Win32_VideoController | Select-Object -First 1
if ($schermo -and $schermo.CurrentHorizontalResolution) {
  Aggiungi ("Schermo      : " + $schermo.CurrentHorizontalResolution + " x " + $schermo.CurrentVerticalResolution)
}

# -------------------------------------------------------------- browser
# E' il vincolo vero per le casse: l'interfaccia gira nel browser.
Titolo "BROWSER INSTALLATI"
$percorsi = @(
  @("Chrome", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"),
  @("Chrome", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"),
  @("Chrome", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"),
  @("Edge",   "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"),
  @("Edge",   "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"),
  @("Firefox","$env:ProgramFiles\Mozilla Firefox\firefox.exe"),
  @("Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe")
)
$trovati = 0
foreach ($p in $percorsi) {
  if (Test-Path $p[1]) {
    $v = (Get-Item $p[1]).VersionInfo.ProductVersion
    Aggiungi ($p[0] + " " + $v)
    Aggiungi ("    " + $p[1])
    $trovati = $trovati + 1
  }
}
if ($trovati -eq 0) { Aggiungi "NESSUN browser moderno trovato (solo Internet Explorer?)" }

# ----------------------------------------------------------------- node
Titolo "NODE.JS (serve solo sul PC che fa da server)"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Aggiungi ("Installato: " + (& node --version 2>&1))
  Aggiungi ("Percorso  : " + $node.Source)
} else {
  Aggiungi "Non installato su questo PC."
}

# ------------------------------------------------------------ stampanti
Titolo "STAMPANTI"
$stampanti = Get-WmiObject Win32_Printer
if (-not $stampanti) {
  Aggiungi "Nessuna stampante installata."
} else {
  foreach ($s in $stampanti) {
    Aggiungi ""
    Aggiungi ("Nome        : " + $s.Name)
    Aggiungi ("Driver      : " + $s.DriverName)
    Aggiungi ("Porta       : " + $s.PortName)
    Aggiungi ("Predefinita : " + $(if ($s.Default) { "SI" } else { "no" }))
    Aggiungi ("Condivisa   : " + $(if ($s.Shared) { "si, come " + $s.ShareName } else { "no" }))
    Aggiungi ("Stato       : " + $s.PrinterStatus + "  (3 = pronta)")
    if ($s.PortName -match "^(IP_|TCP)") { Aggiungi "  --> sembra una stampante di RETE" }
    elseif ($s.PortName -match "^USB")   { Aggiungi "  --> collegata in USB a questo PC" }
  }
}

# Le porte TCP dicono l'indirizzo IP vero delle stampanti di rete.
Titolo "PORTE DI STAMPA DI RETE"
$porte = Get-WmiObject Win32_TCPIPPrinterPort
if ($porte) {
  foreach ($p in $porte) {
    Aggiungi ($p.Name + "  ->  " + $p.HostAddress + " porta " + $p.PortNumber)
  }
} else {
  Aggiungi "Nessuna porta di stampa TCP/IP configurata."
}

# ------------------------------------------------------------------ rete
Titolo "RETE"
$schede = Get-WmiObject Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True"
foreach ($n in $schede) {
  Aggiungi ""
  Aggiungi ("Scheda   : " + $n.Description)
  Aggiungi ("IP       : " + ($n.IPAddress -join ", "))
  Aggiungi ("Maschera : " + ($n.IPSubnet -join ", "))
  Aggiungi ("Gateway  : " + ($n.DefaultIPGateway -join ", "))
  Aggiungi ("DHCP     : " + $(if ($n.DHCPEnabled) { "si (indirizzo NON fisso)" } else { "no (indirizzo fisso)" }))
}

# ----------------------------------------------------------------- fine
$nomeFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) ("diagnostica-" + $env:COMPUTERNAME + ".txt")
$righe -join "`r`n" | Out-File -FilePath $nomeFile -Encoding UTF8

Write-Host ""
Write-Host "Fatto. Ho scritto:"
Write-Host "  $nomeFile"
Write-Host ""
Write-Host "Aprilo, copia tutto e incollamelo."
Write-Host ""
