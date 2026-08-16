import { db, adesso } from './db.js';
import { config } from './config.js';
import { serataAperta } from './anagrafica.js';

/**
 * Lavorazione di un ordine nei reparti, e allineamento fra bar e cucina.
 *
 * Come funziona nella realtà: la stampante è dentro al reparto, i ragazzi
 * staccano la comanda, montano il vassoio e lo passano al cameriere che lo
 * porta al tavolo. Bar e cucina montano due vassoi separati, portati da
 * camerieri diversi.
 *
 * Da qui i due tempi: si spara una volta quando si prende in carico la
 * comanda, e una quando il vassoio esce verso il cameriere. Il secondo è
 * quello che permette di dire alla cucina "per questo tavolo il bar è già
 * uscito"; la distanza fra i due dice quanto ci mette davvero un reparto.
 *
 * La regola "il cibo esce sempre dopo il bere" è mostrata, non imposta: il
 * sistema fa vedere a che punto è l'altro reparto e lascia decidere le persone.
 */

export class ErroreScansione extends Error {}

export const STATI = ['da_fare', 'in_lavorazione', 'uscito'];

/**
 * Due letture ravvicinate sono lo stesso gesto: le pistole raddoppiano il bip
 * e senza questa finestra un ordine appena preso in carico risulterebbe già
 * uscito. Regolabile da configurazione, perché dipende dal lettore.
 */
const antirimbalzo = () => config.secondiAntirimbalzoPistola ?? 3;

export function apriAvanzamento(ordineId, righe) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO avanzamento (ordine_id, reparto_id, stato) VALUES (?, ?, 'da_fare')`,
  );
  for (const reparto of new Set(righe.map((r) => r.reparto_id))) ins.run(ordineId, reparto);
}

const REPARTI_DI = `
  SELECT a.reparto_id, a.stato, a.preso_il, a.uscito_il, a.operatore, r.nome AS reparto
  FROM avanzamento a JOIN reparti r ON r.id = a.reparto_id
  WHERE a.ordine_id = ?
  ORDER BY r.ordine, r.nome
`;

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
    tavolo: ordine.tavolo,
    servizio: ordine.servizio,
    coperti: ordine.coperti,
    ts: ordine.ts,
    cassa: ordine.cassa,
    nota: ordine.nota,
    annullato: !!ordine.annullato,
    righe,
    reparti,
    completo: reparti.length > 0 && reparti.every((r) => r.stato === 'uscito'),
  };
}

/** Coda di lavoro di una postazione, divisa nei tre momenti. */
export function codaReparto(repartoId, { serataId = null } = {}) {
  const serata = serataId ?? serataAperta()?.id;
  if (!serata) return { daFare: [], inLavorazione: [], usciti: [] };

  const righe = db.prepare(`
    SELECT a.ordine_id, a.stato
    FROM avanzamento a JOIN ordini o ON o.id = a.ordine_id
    WHERE a.reparto_id = ? AND o.serata_id = ? AND o.annullato = 0
    ORDER BY o.numero
  `).all(repartoId, serata);

  const gruppi = { daFare: [], inLavorazione: [], usciti: [] };
  for (const { ordine_id: id, stato } of righe) {
    const dettaglio = statoOrdine(id);
    // Ogni postazione vede solo la roba sua: la cucina non legge le birre.
    const mio = { ...dettaglio, righe: dettaglio.righe.filter((r) => r.reparto_id === repartoId) };
    if (stato === 'da_fare') gruppi.daFare.push(mio);
    else if (stato === 'in_lavorazione') gruppi.inLavorazione.push(mio);
    else gruppi.usciti.push(mio);
  }
  gruppi.usciti = gruppi.usciti.slice(-12).reverse();
  return gruppi;
}

const LEGGI_RIGA = () => db.prepare('SELECT * FROM avanzamento WHERE ordine_id = ? AND reparto_id = ?');

function ultimoCambio(riga) {
  return riga.uscito_il ?? riga.preso_il ?? null;
}

function secondiDa(ts) {
  if (!ts) return Infinity;
  const [data, ora] = ts.split('T');
  const [a, m, g] = data.split('-').map(Number);
  const [h, mi, s] = ora.split(':').map(Number);
  return (Date.now() - new Date(a, m - 1, g, h, mi, s).getTime()) / 1000;
}

/**
 * Fa avanzare la lavorazione di un passo: da fare -> in lavorazione -> uscito.
 *
 * Un solo gesto per entrambi i momenti: si spara staccando la comanda e si
 * spara di nuovo passando il vassoio al cameriere, senza cambiare modalità
 * sullo schermo. Chi è al banco non deve pensare a niente.
 */
export function avanza({ ordineId, repartoId, operatore = '' }) {
  const riga = LEGGI_RIGA().get(ordineId, repartoId);
  if (!riga) throw new ErroreScansione('questo ordine non ha niente per questo reparto');

  if (riga.stato === 'uscito') {
    return { ...statoOrdine(ordineId), passaggio: 'gia_uscito' };
  }
  if (secondiDa(ultimoCambio(riga)) < antirimbalzo()) {
    return { ...statoOrdine(ordineId), passaggio: 'rimbalzo' };
  }

  const ora = adesso();
  const nuovo = riga.stato === 'da_fare' ? 'in_lavorazione' : 'uscito';
  if (nuovo === 'in_lavorazione') {
    db.prepare(`UPDATE avanzamento SET stato = ?, preso_il = ?, operatore = ?
                WHERE ordine_id = ? AND reparto_id = ?`)
      .run(nuovo, ora, String(operatore).slice(0, 60), ordineId, repartoId);
  } else {
    db.prepare(`UPDATE avanzamento SET stato = ?, uscito_il = ?, operatore = ?
                WHERE ordine_id = ? AND reparto_id = ?`)
      .run(nuovo, ora, String(operatore).slice(0, 60), ordineId, repartoId);
  }
  return { ...statoOrdine(ordineId), passaggio: nuovo };
}

/** Riporta indietro di un passo, per rimediare a una sparata sbagliata. */
export function indietro({ ordineId, repartoId }) {
  const riga = LEGGI_RIGA().get(ordineId, repartoId);
  if (!riga) throw new ErroreScansione('questo ordine non ha niente per questo reparto');
  if (riga.stato === 'uscito') {
    db.prepare(`UPDATE avanzamento SET stato = 'in_lavorazione', uscito_il = NULL
                WHERE ordine_id = ? AND reparto_id = ?`).run(ordineId, repartoId);
  } else {
    db.prepare(`UPDATE avanzamento SET stato = 'da_fare', preso_il = NULL, operatore = ''
                WHERE ordine_id = ? AND reparto_id = ?`).run(ordineId, repartoId);
  }
  return statoOrdine(ordineId);
}

/**
 * Traduce quello che ha sparato la pistola in un ordine.
 *
 * Il codice contiene l'identificativo interno, che non si ripete mai, e non il
 * numero di comanda, che riparte da 1 ogni serata: così una comanda rimasta in
 * tasca da ieri non può toccare l'ordine di stasera con lo stesso numero.
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
  return avanza({ ordineId: ordine.id, repartoId, operatore });
}

/**
 * Lavagna di produzione: quante porzioni mancano, prodotto per prodotto.
 *
 * È quello che va sul monitor appeso al reparto. Non ripete gli ordini uno per
 * uno perché quelli sono già sulla carta in mano ai ragazzi: qui serve a chi
 * sta al fuoco sapere quanta roba deve fare, non a chi monta i vassoi.
 */
export function daProdurre(repartoId, { serataId = null } = {}) {
  const serata = serataId ?? serataAperta()?.id;
  if (!serata) return [];
  return db.prepare(`
    SELECT COALESCE(p.nome_comanda, r.nome) AS prodotto,
           SUM(r.quantita) AS pezzi,
           SUM(CASE WHEN a.stato = 'in_lavorazione' THEN r.quantita ELSE 0 END) AS in_lavorazione
    FROM righe r
    JOIN ordini o      ON o.id = r.ordine_id
    JOIN avanzamento a ON a.ordine_id = o.id AND a.reparto_id = r.reparto_id
    LEFT JOIN prodotti p ON p.id = r.prodotto_id
    WHERE r.reparto_id = ? AND o.serata_id = ? AND o.annullato = 0 AND a.stato <> 'uscito'
    GROUP BY prodotto
    ORDER BY pezzi DESC, prodotto
  `).all(repartoId, serata);
}

/**
 * Intestazione del monitor: i pochi numeri che servono a capire come si sta
 * messi senza leggere nessun elenco.
 *
 * `sbloccati` esiste solo per la cucina e vale il senso di tutto il giro: sono
 * gli ordini per cui il bar è già uscito, quindi il cibo può partire.
 */
export function riepilogoMonitor(repartoId, { serataId = null } = {}) {
  const serata = serataId ?? serataAperta()?.id;
  if (!serata) return { ordini: 0, presi: 0, sbloccati: 0, attesaMassimaMin: 0 };

  const aperti = db.prepare(`
    SELECT a.ordine_id, a.stato, o.ts
    FROM avanzamento a JOIN ordini o ON o.id = a.ordine_id
    WHERE a.reparto_id = ? AND o.serata_id = ? AND o.annullato = 0 AND a.stato <> 'uscito'
  `).all(repartoId, serata);

  const altriUsciti = db.prepare(`
    SELECT COUNT(*) AS n FROM avanzamento a
    WHERE a.ordine_id = ? AND a.reparto_id <> ? AND a.stato <> 'uscito'
  `);

  let sbloccati = 0;
  let attesaMassima = 0;
  for (const o of aperti) {
    if (altriUsciti.get(o.ordine_id, repartoId).n === 0) sbloccati++;
    attesaMassima = Math.max(attesaMassima, Math.round(secondiDa(o.ts) / 60));
  }

  return {
    ordini: aperti.length,
    presi: aperti.filter((o) => o.stato === 'in_lavorazione').length,
    sbloccati,
    attesaMassimaMin: aperti.length === 0 ? 0 : attesaMassima,
  };
}

/**
 * Numeri pronti al ritiro, per il monitor rivolto al pubblico.
 *
 * Solo self-service e asporto: gli ordini al tavolo li porta il cameriere,
 * chiamare quei numeri confonderebbe e basta.
 */
export function ordiniCompleti({ limite = 20 } = {}) {
  const serata = serataAperta();
  if (!serata) return [];
  return db.prepare(`
    SELECT o.id, o.numero, o.servizio, MAX(a.uscito_il) AS uscito_il
    FROM ordini o JOIN avanzamento a ON a.ordine_id = o.id
    WHERE o.serata_id = ? AND o.annullato = 0 AND o.servizio <> 'tavolo'
    GROUP BY o.id
    HAVING SUM(CASE WHEN a.stato <> 'uscito' THEN 1 ELSE 0 END) = 0
    ORDER BY uscito_il DESC
    LIMIT ?
  `).all(serata.id, limite);
}

/** Tempi medi di lavorazione per reparto: il guadagno vero delle due sparate. */
export function tempiReparto(serataId) {
  return db.prepare(`
    SELECT r.nome AS reparto,
           COUNT(*) AS ordini,
           ROUND(AVG((julianday(a.uscito_il) - julianday(o.ts)) * 1440), 1) AS attesa_media_min,
           ROUND(AVG((julianday(a.uscito_il) - julianday(a.preso_il)) * 1440), 1) AS lavorazione_media_min
    FROM avanzamento a
    JOIN ordini o  ON o.id = a.ordine_id
    JOIN reparti r ON r.id = a.reparto_id
    WHERE o.serata_id = ? AND o.annullato = 0 AND a.stato = 'uscito' AND a.preso_il IS NOT NULL
    GROUP BY r.id ORDER BY r.ordine, r.nome
  `).all(serataId);
}
