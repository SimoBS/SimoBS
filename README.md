# SimoBS

Gestionale per stand gastronomico e festa della birra: cassa, comande stampate
per reparto, magazzino e report. Gira **completamente offline** sulla rete
locale del tendone.

Nasce come alternativa personalizzabile ai gestionali a noleggio: qui prodotti,
prezzi, layout delle comande e report si cambiano intervenendo sul codice o dal
pannello di gestione, senza chiedere il permesso a nessuno.

## Come è fatto

Un PC fa da server. Le casse sono normali browser sulla stessa rete che aprono
una pagina web.

Le stampanti seguono **due percorsi diversi**, perché non sono collegate allo
stesso modo:

```
                        ┌── comande ──→  Cucina  (stampante di rete, TCP 9100)
   PC server ───────────┤
   (SimoBS)             └── comande ──→  Bar     (stampante di rete, TCP 9100)
       │
       │  la pagina della cassa
       ▼
   PC Cassa 1 (browser) ──→ scontrino ──→ termica in USB su QUESTO PC
   PC Cassa 2 (browser) ──→ scontrino ──→ termica in USB su QUESTO PC
   PC Cassa 3 (browser) ──→ scontrino ──→ termica in USB su QUESTO PC
   PC Cassa 4 (browser) ──→ scontrino ──→ termica in USB su QUESTO PC
```

Quattro postazioni di cassa, ognuna con la sua termica attaccata, e due sole
stampanti di rete condivise da tutte: Cucina e Bar.

**Comande di reparto** (Cucina e Bar): il server manda i byte ESC/POS
direttamente alla stampante di rete. Coda persistente, ritenta da sola.

**Scontrini per il cliente**: la termica è attaccata in USB al PC della cassa,
quindi il server **non la può raggiungere**. Il documento torna al browser di
quella cassa come pagina HTML e viene stampato dal driver di Windows di quel
computer. È il motivo per cui la stampa di prova dello scontrino si fa dalla
pagina Cassa, e non dal pannello di gestione.

Il layout è scritto una volta sola: `escpos.js` rende lo stesso documento in
byte ESC/POS, in HTML per il browser o in testo per l'anteprima, e un test
verifica che le tre rese impaginino le righe allo stesso modo.

**Nessuna dipendenza esterna.** Il server usa solo moduli inclusi in Node.js
(`node:sqlite`, `node:http`, `node:net`); l'interfaccia è HTML, CSS e JavaScript
senza framework. Non c'è nessun `npm install` da fare, nessuna compilazione,
nessun modulo nativo. Questo è deliberato: alle 22:30 di sabato, con il tendone
pieno, non si installa niente e non c'è internet per farlo.

## Requisiti

- **Node.js 22.5 o successivo** ([nodejs.org](https://nodejs.org), versione LTS)
  **solo sul PC che fa da server**. Sulle casse non va installato niente.
- Un router o access point per la rete locale. **Non serve internet.**
- Le due stampanti di reparto (Cucina e Bar) **di rete**, che accettano byte
  ESC/POS sulla porta 9100: praticamente tutte le Epson TM e compatibili.
- Le termiche degli scontrini attaccate ai PC delle casse, installate in Windows
  con il loro driver e impostate come **stampante predefinita** di quel PC.
- Sulle casse **Chrome** (o Edge), avviato con la stampa diretta attiva:
  ci pensa `avvia-cassa.bat`.

## Avvio rapido

```bash
node --no-warnings src/seed.js    # carica un menu di esempio (una volta sola)
npm start                          # avvia il server
```

Su Windows: doppio click su **`avvia.bat`**.

All'avvio la finestra stampa gli indirizzi da aprire sulle casse, tipo
`http://192.168.1.10:8080`. Le tre pagine sono:

| Pagina | A cosa serve |
|---|---|
| `/cassa.html` | La cassa. È la pagina iniziale. |
| `/gestione.html` | Serate, prodotti, prezzi, stampanti, magazzino, storni. |
| `/report.html` | Incassi, andamento orario, venduto, confronto fra edizioni. |

## Prima della festa

1. **Rete.** Dai al PC server un indirizzo IP fisso, e uno fisso anche alle due
   stampanti di rete. Se cambiano indirizzo a metà serata smettono di stampare.
2. **Comande di reparto.** In *Gestione → Reparti* metti l'IP di Cucina e Bar e
   premi **Prova**. La stampa di prova contiene accenti e simbolo dell'euro: se
   escono caratteri strani, la stampante non è impostata su CP858.
3. **Scontrini cliente.** Su **ciascuno dei quattro** PC cassa:
   - la termica dev'essere la **stampante predefinita** di Windows;
   - apri `avvia-cassa.bat` (dopo averci messo dentro l'indirizzo del server);
   - scegli in alto la postazione — Cassa 1, 2, 3 o 4 — **una diversa per ogni
     PC**. La scelta resta memorizzata su quel computer;
   - nella pagina Cassa premi **Prova stampa**. Deve uscire lo scontrino di
     prova **senza** che compaia la finestra "Stampa": se compare, Chrome non è
     partito con `--kiosk-printing` e a ogni cliente qualcuno dovrà cliccare.

   Se due PC scelgono la stessa postazione compare un avviso rosso su
   entrambi: gli scontrini escono comunque dalla stampante giusta, ma gli
   incassi di quelle due casse finirebbero mescolati e il conto dei cassetti a
   fine serata non tornerebbe.
4. **Larghezza carta.** In *Impostazioni*: 48 caratteri e 80 mm per la carta
   grande, 32 caratteri e 58 mm per quella stretta. È la causa numero uno delle
   comande impaginate male.
5. **Menu e prezzi.** In *Gestione → Prodotti*.
6. **Magazzino.** Carica le giacenze iniziali e imposta le soglie di allarme.
7. **Serata.** Aprine una: senza serata aperta le casse non incassano.

Un reparto **senza indirizzo IP non stampa nulla**, ed è una scelta legittima.
Allo stesso modo una cassa può essere impostata su *nessuno scontrino* se in
quella postazione non si consegna niente al cliente.

### La lunghezza dello scontrino la decide il driver

La pagina dello scontrino non impone un formato: fissa solo la larghezza del
contenuto e lascia decidere al driver del rullo dove finisce e dove tagliare.
Se il tuo driver è configurato con un foglio di lunghezza fissa, dopo ogni
scontrino uscirà carta bianca: nelle proprietà della stampante scegli il tipo
carta "ricevuta"/"roll paper" a lunghezza variabile, con taglio a fine
documento.

## Le scelte che contano

**Tutto è raggruppato per serata, non per data.** Una festa che finisce alle due
di notte resta una serata sola: i report non si spaccano a mezzanotte e la
numerazione delle comande non riparte nel mezzo del servizio.

**La coda di stampa sta su disco.** Se il PC si riavvia a metà serata, le
comande non ancora uscite ripartono da sole. Se una stampante si stacca, il suo
lavoro resta in coda e ritenta con attesa crescente invece di essere perso; la
destinazione è memorizzata come *reparto*, non come indirizzo IP, quindi
sostituendo una stampante rotta anche le comande già in coda vanno su quella
nuova.

**Il magazzino non blocca mai una vendita.** Se la giacenza va sotto zero è
perché qualcuno ha caricato male i fusti, non perché il cliente non deve bere.
Le scorte servono ad avvisare che le salamelle stanno finendo, non a fare da
guardiano alla cassa.

**I prezzi arrivano sempre dal database.** La cassa manda solo quali prodotti e
quante unità: nessun client può imporre un prezzo.

**Ogni ordine ha una chiave di idempotenza generata dalla cassa.** Se la rete
cade dopo l'invio ma prima della risposta, il rinvio non incassa due volte. È
anche il motivo per cui la cassa può tenere in memoria gli ordini durante un
buco di rete e mandarli quando torna il collegamento.

**Gli importi sono numeri interi di centesimi**, mai decimali: niente
arrotondamenti misteriosi a fine serata.

**Lo storno stampa.** Annullare un ordine ricarica il magazzino e manda ai
reparti una comanda di ANNULLAMENTO: se la salamella è già sulla griglia, il
cuoco deve saperlo subito.

## Durante la festa

- Tieni aperta *Gestione* su un monitor: mostra la coda di stampa e gli allarmi
  di scorte in tempo reale.
- Il pallino in alto a destra nella cassa diventa rosso se il server non
  risponde o se ci sono ordini ancora da inviare.
- Fai una **copia di sicurezza** a metà e a fine serata (*Impostazioni → Copia
  il database adesso*) e portala via su una chiavetta. Si può fare a casse
  aperte.

## Se qualcosa va storto

| Sintomo | Da guardare |
|---|---|
| Cucina o Bar non stampano | *Gestione → Coda di stampa*: c'è l'errore vero. Poi ping all'IP. |
| Lo scontrino cliente non esce | È un problema di quel PC, non del server: stampante predefinita giusta? Prova con **Prova stampa** nella pagina Cassa. |
| A ogni scontrino compare la finestra "Stampa" | Chrome non è partito con `--kiosk-printing`: usa `avvia-cassa.bat`. |
| Dopo ogni scontrino esce carta bianca | Il driver ha un foglio di lunghezza fissa: impostalo su carta "ricevuta" a lunghezza variabile. |
| Comande impaginate male | Larghezza carta in *Impostazioni* (48 o 32 caratteri). |
| Accenti sbagliati sulla carta | La stampante non usa CP858: vedi il suo manuale. |
| La cassa dice "non raggiungibile" | Il PC server è spento, oppure il Wi-Fi è caduto. Gli ordini restano nel browser e partono da soli al ritorno. |
| Avviso "un altro computer sta incassando su..." | Due PC hanno scelto la stessa postazione: cambiala su uno dei due. L'avviso sparisce da solo entro mezzo minuto. |
| "Nessuna serata aperta" | *Gestione → Serata → Apri serata*. |

## Nota fiscale

Gli scontrini prodotti sono **documenti non fiscali**, come le comande dei
gestionali per sagre. Gli obblighi fiscali e amministrativi della
manifestazione (regime dell'associazione, corrispettivi, SIAE) restano una cosa
a parte: questo programma gestisce il servizio, non tiene la contabilità
ufficiale.

## Sviluppo

```bash
npm test                          # 58 test: stampa, ordini, magazzino, report
node --no-warnings src/seed.js --reset   # riparte da un menu di esempio pulito
```

I dati stanno in `dati/` (database, configurazione, backup) e non finiscono su
git: contengono gli incassi reali.

```
src/
  server.js     server HTTP e file statici
  api.js        rotte JSON
  db.js         schema, migrazioni, backup a caldo
  ordini.js     creazione e storno degli ordini
  magazzino.js  giacenze, distinta base, movimenti
  report.js     tutte le query dei report
  stampa.js     modelli di comanda e coda di stampa persistente
  escpos.js     documenti astratti -> byte ESC/POS, HTML da stampare, anteprima
web/            le tre pagine, senza framework
test/           test automatici
avvia.bat       avvia il server (sul PC server)
avvia-cassa.bat apre Chrome in modalità cassa (su ogni PC cassa)
```

Il layout delle stampe si progetta guardandolo: `escpos.js` rende lo stesso
documento in tre modi — byte per la termica di rete, HTML per la termica
attaccata al PC, testo per l'anteprima a schermo — così si ridisegna una
comanda senza sprecare carta e senza avere una stampante sotto mano
(*Report → Anteprima chiusura*).
