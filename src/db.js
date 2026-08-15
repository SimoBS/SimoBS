import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CARTELLA_DATI } from './config.js';

mkdirSync(CARTELLA_DATI, { recursive: true });

export const db = new DatabaseSync(join(CARTELLA_DATI, 'simobs.db'));

// WAL: le casse leggono mentre un ordine viene scritto, senza bloccarsi a vicenda.
// NORMAL invece di FULL: perdiamo al massimo l'ultima transazione in caso di
// blackout, in cambio di una cassa che non aspetta il disco a ogni scontrino.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Timestamp in ora locale, senza fuso orario: "2026-08-15T22:41:03".
 *
 * Volutamente NON è UTC. Tutto il sistema gira su un solo PC in una sola
 * piazza, e con l'ora locale scritta così `substr(ts, 12, 2)` dà direttamente
 * l'ora della serata nei report, senza conversioni. Il problema della
 * mezzanotte (una serata che continua dopo le 00:00) non si risolve con le
 * date ma raggruppando per serata: vedi la tabella `serate`.
 */
export function adesso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const MIGRAZIONI = [
  {
    id: '001-impianto',
    sql: `
    CREATE TABLE serate (
      id         INTEGER PRIMARY KEY,
      nome       TEXT    NOT NULL,
      data       TEXT    NOT NULL,
      edizione   TEXT    NOT NULL DEFAULT '',
      aperta     INTEGER NOT NULL DEFAULT 1,
      aperta_il  TEXT    NOT NULL,
      chiusa_il  TEXT
    );

    CREATE TABLE casse (
      id              INTEGER PRIMARY KEY,
      nome            TEXT    NOT NULL UNIQUE,
      -- Stampante dello scontrino di cortesia per il cliente.
      -- Vuota = questa cassa non stampa nulla al cliente.
      stampante_host  TEXT,
      stampante_porta INTEGER NOT NULL DEFAULT 9100,
      attiva          INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE reparti (
      id              INTEGER PRIMARY KEY,
      nome            TEXT    NOT NULL UNIQUE,
      stampante_host  TEXT,
      stampante_porta INTEGER NOT NULL DEFAULT 9100,
      copie           INTEGER NOT NULL DEFAULT 1,
      ordine          INTEGER NOT NULL DEFAULT 0,
      attivo          INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE categorie (
      id     INTEGER PRIMARY KEY,
      nome   TEXT    NOT NULL UNIQUE,
      colore TEXT    NOT NULL DEFAULT '#d98324',
      ordine INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE prodotti (
      id           INTEGER PRIMARY KEY,
      nome         TEXT    NOT NULL,
      nome_comanda TEXT,
      categoria_id INTEGER NOT NULL REFERENCES categorie(id),
      reparto_id   INTEGER NOT NULL REFERENCES reparti(id),
      prezzo_cent  INTEGER NOT NULL,
      ordine       INTEGER NOT NULL DEFAULT 0,
      attivo       INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_prodotti_categoria ON prodotti(categoria_id);

    CREATE TABLE articoli (
      id            INTEGER PRIMARY KEY,
      nome          TEXT    NOT NULL UNIQUE,
      unita         TEXT    NOT NULL DEFAULT 'pz',
      giacenza      REAL    NOT NULL DEFAULT 0,
      soglia_minima REAL    NOT NULL DEFAULT 0,
      attivo        INTEGER NOT NULL DEFAULT 1
    );

    -- Distinta base: quanto di un articolo di magazzino consuma
    -- la vendita di un pezzo di prodotto.
    -- Es. "Birra media 0,4L" -> 0.4 dell'articolo "Fusto Bionda" (unità L).
    CREATE TABLE distinta (
      prodotto_id INTEGER NOT NULL REFERENCES prodotti(id) ON DELETE CASCADE,
      articolo_id INTEGER NOT NULL REFERENCES articoli(id) ON DELETE CASCADE,
      quantita    REAL    NOT NULL,
      PRIMARY KEY (prodotto_id, articolo_id)
    );

    CREATE TABLE ordini (
      id           INTEGER PRIMARY KEY,
      serata_id    INTEGER NOT NULL REFERENCES serate(id),
      cassa_id     INTEGER NOT NULL REFERENCES casse(id),
      numero       INTEGER NOT NULL,
      ts           TEXT    NOT NULL,
      totale_cent  INTEGER NOT NULL,
      sconto_cent  INTEGER NOT NULL DEFAULT 0,
      pagamento    TEXT    NOT NULL DEFAULT 'contanti',
      operatore    TEXT    NOT NULL DEFAULT '',
      coperti      INTEGER NOT NULL DEFAULT 0,
      nota         TEXT    NOT NULL DEFAULT '',
      annullato    INTEGER NOT NULL DEFAULT 0,
      annullato_il TEXT,
      -- Chiave di idempotenza generata dalla cassa: se il client rinvia lo
      -- stesso ordine perché non ha ricevuto la risposta, non lo duplichiamo.
      idem_key     TEXT    NOT NULL UNIQUE,
      UNIQUE (serata_id, numero)
    );
    CREATE INDEX idx_ordini_serata ON ordini(serata_id);

    CREATE TABLE righe (
      id          INTEGER PRIMARY KEY,
      ordine_id   INTEGER NOT NULL REFERENCES ordini(id) ON DELETE CASCADE,
      prodotto_id INTEGER REFERENCES prodotti(id),
      nome        TEXT    NOT NULL,
      reparto_id  INTEGER NOT NULL REFERENCES reparti(id),
      prezzo_cent INTEGER NOT NULL,
      quantita    INTEGER NOT NULL,
      nota        TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_righe_ordine ON righe(ordine_id);

    CREATE TABLE movimenti (
      id          INTEGER PRIMARY KEY,
      articolo_id INTEGER NOT NULL REFERENCES articoli(id),
      quantita    REAL    NOT NULL,
      tipo        TEXT    NOT NULL,
      ordine_id   INTEGER REFERENCES ordini(id),
      nota        TEXT    NOT NULL DEFAULT '',
      ts          TEXT    NOT NULL
    );
    CREATE INDEX idx_movimenti_articolo ON movimenti(articolo_id);

    -- Coda di stampa persistente.
    --
    -- Sta su disco e non in memoria per un motivo preciso: se il PC server si
    -- riavvia a metà serata, le comande non ancora uscite dalla stampante sono
    -- ancora qui e ripartono da sole. La destinazione è memorizzata come
    -- riferimento logico (reparto o cassa) e non come indirizzo IP, così
    -- cambiando la stampante di un reparto anche il lavoro già accodato
    -- viene dirottato sulla nuova.
    CREATE TABLE stampe (
      id                 INTEGER PRIMARY KEY,
      ordine_id          INTEGER REFERENCES ordini(id),
      destinazione_tipo  TEXT    NOT NULL,
      destinazione_id    INTEGER NOT NULL,
      tipo               TEXT    NOT NULL DEFAULT 'comanda',
      descrizione        TEXT    NOT NULL DEFAULT '',
      payload            BLOB    NOT NULL,
      anteprima          TEXT    NOT NULL DEFAULT '',
      stato              TEXT    NOT NULL DEFAULT 'in_attesa',
      tentativi          INTEGER NOT NULL DEFAULT 0,
      ultimo_errore      TEXT    NOT NULL DEFAULT '',
      prossimo_tentativo TEXT    NOT NULL,
      creata_il          TEXT    NOT NULL,
      stampata_il        TEXT
    );
    CREATE INDEX idx_stampe_stato ON stampe(stato, prossimo_tentativo);
    CREATE INDEX idx_stampe_ordine ON stampe(ordine_id);
    `,
  },
  {
    id: '002-modo-stampa-cassa',
    sql: `
    -- Come stampa lo scontrino cliente ogni cassa:
    --   'locale'  la termica è attaccata al PC della cassa (USB/seriale) e il
    --             server non la può raggiungere: stampa il browser di quel PC
    --             attraverso il driver di Windows.
    --   'rete'    la termica ha un indirizzo IP: la raggiunge il server, come
    --             fa con i reparti.
    --   'nessuna' quella cassa non consegna scontrini al cliente.
    ALTER TABLE casse ADD COLUMN modo_stampa TEXT NOT NULL DEFAULT 'locale';

    -- Chi aveva già configurato un IP stava usando una stampante di rete.
    UPDATE casse SET modo_stampa = 'rete'
    WHERE stampante_host IS NOT NULL AND stampante_host <> '';
    `,
  },
  {
    id: '003-avanzamento-reparti',
    sql: `
    -- Stato di preparazione di un ordine, reparto per reparto.
    --
    -- Serve a sincronizzare cucina e bar: un ordine si chiama al cliente solo
    -- quando TUTTI i reparti coinvolti hanno finito, altrimenti la birra
    -- aspetta otto minuti la griglia e arriva calda. Alle postazioni di
    -- reparto c'è un PC con la pistola: si legge il codice a barre della
    -- comanda e quella riga passa a 'pronto'.
    CREATE TABLE avanzamento (
      ordine_id  INTEGER NOT NULL REFERENCES ordini(id) ON DELETE CASCADE,
      reparto_id INTEGER NOT NULL REFERENCES reparti(id),
      stato      TEXT    NOT NULL DEFAULT 'da_fare',
      pronto_il  TEXT,
      operatore  TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (ordine_id, reparto_id)
    );
    CREATE INDEX idx_avanzamento_reparto ON avanzamento(reparto_id, stato);

    -- Gli ordini già registrati prima di questa modifica ricevono le loro
    -- righe di avanzamento, ricavate da quali reparti li hanno lavorati.
    INSERT INTO avanzamento (ordine_id, reparto_id, stato)
    SELECT DISTINCT ordine_id, reparto_id, 'da_fare' FROM righe;
    `,
  },
];

function applicaMigrazioni() {
  db.exec(`CREATE TABLE IF NOT EXISTS migrazioni (
    id         TEXT PRIMARY KEY,
    applicata  TEXT NOT NULL
  )`);
  const gia = new Set(db.prepare('SELECT id FROM migrazioni').all().map((r) => r.id));
  for (const m of MIGRAZIONI) {
    if (gia.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrazioni (id, applicata) VALUES (?, ?)').run(m.id, adesso());
      db.exec('COMMIT');
      console.log(`migrazione applicata: ${m.id}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migrazione ${m.id} fallita: ${err.message}`);
    }
  }
}

applicaMigrazioni();

/**
 * Copia di sicurezza del database mentre il sistema è in funzione.
 *
 * Usa VACUUM INTO e non una copia del file: con il journal WAL attivo, copiare
 * il .db a mano mentre le casse scrivono produce un backup incoerente, cioè
 * inutile proprio nel momento in cui servirebbe.
 */
export function backup() {
  const cartella = join(CARTELLA_DATI, 'backup');
  mkdirSync(cartella, { recursive: true });
  const ts = adesso(); // 2026-08-15T22:41:03
  const nome = `simobs-${ts.slice(0, 10).replace(/-/g, '')}-${ts.slice(11, 16).replace(':', '')}.db`;
  const destinazione = join(cartella, nome);
  // VACUUM INTO fallisce se il file esiste già: due backup nello stesso minuto
  // sono lo stesso backup, quindi va bene restituire quello.
  if (!existsSync(destinazione)) db.exec(`VACUUM INTO '${destinazione.replace(/'/g, "''")}'`);
  return { percorso: destinazione, dimensione: statSync(destinazione).size };
}

/** Esegue `fn` dentro una transazione, con rollback su qualunque errore. */
export function inTransazione(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const risultato = fn();
    db.exec('COMMIT');
    return risultato;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Il rollback fallisce solo se la transazione è già chiusa: ignorabile.
    }
    throw err;
  }
}
