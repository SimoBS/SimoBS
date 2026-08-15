import { db, adesso } from './db.js';
import { serataAperta } from './anagrafica.js';

/**
 * Sincronizzazione fra cucina e bar.
 *
 * Un ordine misto viene lavorato da due reparti che non si vedono fra loro. Se
 * ognuno consegna quando ha finito, la birra arriva subito e il panino dieci
 * minuti dopo. Qui si tiene lo stato di ogni reparto sull'ordine, e il numero
 * si chiama solo quando hanno finito tutti.
 *
 * Il gesto è uno solo: alla postazione si legge con la pistola il codice a
 * barre della comanda, e la riga di quel reparto passa a "pronto".
 */

export class ErroreScansione extends Error {}

/** Crea le righe di avanzamento per i reparti coinvolti in un ordine. */
export function apriAvanzamento(ordineId, righe) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO avanzamento (ordine_id, reparto_id, stato) VALUES (?, ?, 'da_fare')`,
  );
  for (const reparto of new Set(righe.map((r) => r.reparto_id))) ins.run(ordineId, reparto);
}

const REPARTI_DI = `
  SELECT a.reparto_id, a.stato, a.pronto_il, a.operatore, r.nome AS reparto
  FROM avanzamento a JOIN reparti r ON r.id = a.reparto_id
  WHERE a.ordine_id = ?
  ORDER BY r.ordine, r.nome
`;

/** Fotografia di un ordine: le sue righe, e a che punto è ogni reparto. */
export function statoOrdine(ordineId) {
  const ordine = db.prepare(`
    SELECT o.*, c.nome AS cassa FROM ordini o JOIN casse c ON c.id = o.cassa_id WHERE o.id = ?
  `).get(ordineId);
  if (!ordine) return null;

  const reparti = db.prepare(REPARTI_DI).all(ordineId);
  const righe = db.prepare(`
    SELECT r.quantita, r.nome, r.nota, r.reparto_id, p.nome_comanda
    FROM righe r LEFT JOIN prodotti p ON p.id = r.prodotto_id
    WHERE r.ordine_id = ? ORDER BY r.id
  `).all(ordineId);

  return {
    id: ordine.id,
    numero: ordine.numero,
    ts: ordine.ts,
    cassa: ordine.cassa,
    nota: ordine.nota,
    annullato: !!ordine.annullato,
    righe,
    reparti,
    completo: reparti.length > 0 && reparti.every((r) => r.stato === 'pronto'),
  };
}

/**
 * Coda di lavoro di un reparto: cosa deve ancora preparare, più quello che ha
 * finito ma sta aspettando l'altro reparto.
 *
 * Ogni ordine porta con sé lo stato degli altri reparti: è l'informazione che
 * fa sincronizzare il lavoro. Chi è in cucina vede che il bar ha già spinato,
 * e sa che quel numero è l'ultimo pezzo mancante.
 */
export function codaReparto(repartoId, { serataId = null } = {}) {
  const serata = serataId ?? serataAperta()?.id;
  if (!serata) return { daFare: [], inAttesaDiAltri: [], completatiDiRecente: [] };

  const ordini = db.prepare(`
    SELECT a.ordine_id, a.stato
    FROM avanzamento a JOIN ordini o ON o.id = a.ordine_id
    WHERE a.reparto_id = ? AND o.serata_id = ? AND o.annullato = 0
    ORDER BY o.numero
  `).all(repartoId, serata);

  const daFare = [];
  const inAttesaDiAltri = [];
  const completatiDiRecente = [];

  for (const { ordine_id: id, stato } of ordini) {
    const dettaglio = statoOrdine(id);
    // Ogni reparto vede solo la roba sua: la cucina non deve leggere le birre.
    const mio = { ...dettaglio, righe: dettaglio.righe.filter((r) => r.reparto_id === repartoId) };
    if (stato === 'da_fare') daFare.push(mio);
    else if (!dettaglio.completo) inAttesaDiAltri.push(mio);
    else completatiDiRecente.push(mio);
  }

  return {
    daFare,
    inAttesaDiAltri,
    // Gli ultimi conclusi bastano come conferma visiva: non serve lo storico.
    completatiDiRecente: completatiDiRecente.slice(-12).reverse(),
  };
}

/**
 * Registra che un reparto ha finito la sua parte.
 *
 * Una seconda lettura dello stesso codice non annulla la prima: sotto il
 * tendone le pistole partono da sole e un doppio bip non deve rimettere in
 * lavorazione un ordine già pronto. Per tornare indietro c'è `riapri`.
 */
export function segnaPronto({ ordineId, repartoId, operatore = '' }) {
  const riga = db.prepare('SELECT * FROM avanzamento WHERE ordine_id = ? AND reparto_id = ?')
    .get(ordineId, repartoId);
  if (!riga) throw new ErroreScansione('questo ordine non ha niente per questo reparto');

  const giaPronto = riga.stato === 'pronto';
  if (!giaPronto) {
    db.prepare(`
      UPDATE avanzamento SET stato = 'pronto', pronto_il = ?, operatore = ?
      WHERE ordine_id = ? AND reparto_id = ?
    `).run(adesso(), String(operatore).slice(0, 60), ordineId, repartoId);
  }
  return { ...statoOrdine(ordineId), giaPronto };
}

export function riapri({ ordineId, repartoId }) {
  db.prepare(`
    UPDATE avanzamento SET stato = 'da_fare', pronto_il = NULL, operatore = ''
    WHERE ordine_id = ? AND reparto_id = ?
  `).run(ordineId, repartoId);
  return statoOrdine(ordineId);
}

/**
 * Traduce quello che ha sparato la pistola in un ordine.
 *
 * Il codice a barre contiene l'identificativo interno dell'ordine, che non si
 * ripete mai, e non il numero di comanda, che invece riparte da 1 ogni serata:
 * così una comanda rimasta in tasca da ieri sera non può far segnare pronto
 * l'ordine di stasera con lo stesso numero.
 */
export function ordineDaCodice(codice) {
  const pulito = String(codice ?? '').trim().replace(/^\*|\*$/g, '');
  if (!/^\d+$/.test(pulito)) throw new ErroreScansione(`codice non riconosciuto: "${codice}"`);

  const ordine = db.prepare('SELECT id, serata_id, annullato, numero FROM ordini WHERE id = ?')
    .get(Number(pulito));
  if (!ordine) throw new ErroreScansione('codice non corrispondente a nessun ordine');
  if (ordine.annullato) throw new ErroreScansione(`la comanda n. ${ordine.numero} è stata annullata`);

  const serata = serataAperta();
  if (!serata || ordine.serata_id !== serata.id) {
    throw new ErroreScansione(`la comanda n. ${ordine.numero} è di un'altra serata`);
  }
  return ordine;
}

export function scansiona({ codice, repartoId, operatore = '' }) {
  const ordine = ordineDaCodice(codice);
  return segnaPronto({ ordineId: ordine.id, repartoId, operatore });
}

/**
 * Numeri pronti da consegnare, per il monitor rivolto al pubblico: solo
 * ordini in cui ogni reparto ha finito.
 */
export function ordiniCompleti({ limite = 16 } = {}) {
  const serata = serataAperta();
  if (!serata) return [];
  return db.prepare(`
    SELECT o.id, o.numero, MAX(a.pronto_il) AS pronto_il
    FROM ordini o JOIN avanzamento a ON a.ordine_id = o.id
    WHERE o.serata_id = ? AND o.annullato = 0
    GROUP BY o.id
    HAVING SUM(CASE WHEN a.stato <> 'pronto' THEN 1 ELSE 0 END) = 0
    ORDER BY pronto_il DESC
    LIMIT ?
  `).all(serata.id, limite);
}

/** Quanto sta aspettando la gente: utile a capire se serve un'altra griglia. */
export function riepilogoAvanzamento(serataId) {
  return db.prepare(`
    SELECT r.nome AS reparto,
           SUM(CASE WHEN a.stato = 'da_fare' THEN 1 ELSE 0 END) AS da_fare,
           SUM(CASE WHEN a.stato = 'pronto'  THEN 1 ELSE 0 END) AS pronti
    FROM avanzamento a
    JOIN ordini o  ON o.id = a.ordine_id
    JOIN reparti r ON r.id = a.reparto_id
    WHERE o.serata_id = ? AND o.annullato = 0
    GROUP BY r.id ORDER BY r.ordine, r.nome
  `).all(serataId);
}
