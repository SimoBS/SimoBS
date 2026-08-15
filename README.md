# SimoBS

Gestionale per stand gastronomico e festa della birra: cassa, comande stampate
per reparto, magazzino e report. Gira **completamente offline** sulla rete
locale del tendone.

Nasce come alternativa personalizzabile ai gestionali a noleggio: qui prodotti,
prezzi, layout delle comande e report si cambiano intervenendo sul codice o dal
pannello di gestione, senza chiedere il permesso a nessuno.

## Come è fatto

Un PC fa da server. Le casse sono normali browser sulla stessa rete che aprono
una pagina web. Le stampanti termiche ricevono i byte ESC/POS direttamente via
rete.

```
   Cassa 1 (browser) ─┐
   Cassa 2 (browser) ─┼─→  PC server  ──→  stampanti termiche di rete
   Tablet             ─┘   (SimoBS)         Spina / Cucina / Griglia / Bar
                              │
                          simobs.db
```

**Nessuna dipendenza esterna.** Il server usa solo moduli inclusi in Node.js
(`node:sqlite`, `node:http`, `node:net`); l'interfaccia è HTML, CSS e JavaScript
senza framework. Non c'è nessun `npm install` da fare, nessuna compilazione,
nessun modulo nativo. Questo è deliberato: alle 22:30 di sabato, con il tendone
pieno, non si installa niente e non c'è internet per farlo.

## Requisiti

- **Node.js 22.5 o successivo** ([nodejs.org](https://nodejs.org), versione LTS).
- Un PC che faccia da server (basta un portatile qualunque).
- Un router o access point per la rete locale. **Non serve internet.**
- Stampanti termiche ESC/POS **di rete** (con presa Ethernet o Wi-Fi), che
  accettano byte grezzi sulla porta 9100. Sono la stragrande maggioranza delle
  Epson TM-T20/T88 e delle compatibili.

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

1. **Rete.** Dai al PC server un indirizzo IP fisso e assegnane uno fisso anche
   a ogni stampante. Se cambiano indirizzo a metà serata smettono di stampare.
2. **Stampanti.** In *Gestione → Stampanti* inserisci l'IP di ogni reparto e
   premi **Prova**. La stampa di prova contiene accenti e simbolo dell'euro:
   se escono caratteri strani, la stampante non è impostata su CP858.
3. **Larghezza carta.** In *Impostazioni*: 48 caratteri per la carta da 80mm,
   32 per quella da 58mm. È la causa numero uno delle comande impaginate male.
4. **Menu e prezzi.** In *Gestione → Prodotti*.
5. **Magazzino.** Carica le giacenze iniziali e imposta le soglie di allarme.
6. **Serata.** Aprine una: senza serata aperta le casse non incassano.

Un reparto **senza indirizzo IP non stampa nulla**, ed è una scelta legittima:
il bar che serve direttamente al banco non ha bisogno di comande.

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
| Una stampante non stampa | *Gestione → Coda di stampa*: c'è l'errore vero. Poi ping all'IP. |
| Comande impaginate male | Larghezza carta in *Impostazioni* (48 o 32). |
| Accenti sbagliati sulla carta | La stampante non usa CP858: vedi il suo manuale. |
| La cassa dice "non raggiungibile" | Il PC server è spento, oppure il Wi-Fi è caduto. Gli ordini restano nel browser e partono da soli al ritorno. |
| "Nessuna serata aperta" | *Gestione → Serata → Apri serata*. |

## Nota fiscale

Gli scontrini prodotti sono **documenti non fiscali**, come le comande dei
gestionali per sagre. Gli obblighi fiscali e amministrativi della
manifestazione (regime dell'associazione, corrispettivi, SIAE) restano una cosa
a parte: questo programma gestisce il servizio, non tiene la contabilità
ufficiale.

## Sviluppo

```bash
npm test                          # 41 test: stampa, ordini, magazzino, report
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
  escpos.js     documenti astratti -> byte ESC/POS o anteprima testuale
web/            le tre pagine, senza framework
test/           test automatici
```

Il layout delle stampe si progetta guardandolo: `escpos.js` rende lo stesso
documento sia in byte per la termica sia in testo per il browser, così si
ridisegna una comanda senza sprecare carta e senza avere una stampante sotto
mano (*Report → Anteprima chiusura*).
