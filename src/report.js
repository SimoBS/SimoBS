import { db } from './db.js';
import { config } from './config.js';
import { Documento } from './escpos.js';
import { euro } from './stampa.js';
import { consumoSerata } from './magazzino.js';

/**
 * Nota valida per tutti i report: gli ordini annullati sono sempre esclusi dai
 * totali, ma restano contati a parte. Sapere quanti storni ha fatto una cassa
 * è un'informazione, non sporcizia da nascondere.
 *
 * Gli importi per prodotto sono al lordo dello sconto, perché lo sconto si
 * applica all'ordine intero e non a una riga: spalmarlo sulle righe darebbe
 * numeri inventati. Il totale scontato sta nel riepilogo.
 */

export function riepilogoSerata(serataId) {
  const base = db.prepare(`
    SELECT
      COUNT(*)                          AS ordini,
      COALESCE(SUM(totale_cent), 0)     AS incasso_cent,
      COALESCE(SUM(sconto_cent), 0)     AS sconti_cent,
      COALESCE(SUM(coperti), 0)         AS coperti
    FROM ordini WHERE serata_id = ? AND annullato = 0
  `).get(serataId);

  const storni = db.prepare(`
    SELECT COUNT(*) AS ordini, COALESCE(SUM(totale_cent), 0) AS valore_cent
    FROM ordini WHERE serata_id = ? AND annullato = 1
  `).get(serataId);

  const pezzi = db.prepare(`
    SELECT COALESCE(SUM(r.quantita), 0) AS n
    FROM righe r JOIN ordini o ON o.id = r.ordine_id
    WHERE o.serata_id = ? AND o.annullato = 0
  `).get(serataId).n;

  const perPagamento = db.prepare(`
    SELECT pagamento, COUNT(*) AS ordini, COALESCE(SUM(totale_cent), 0) AS incasso_cent
    FROM ordini WHERE serata_id = ? AND annullato = 0
    GROUP BY pagamento ORDER BY incasso_cent DESC
  `).all(serataId);

  return {
    ...base,
    pezzi,
    storni,
    perPagamento,
    scontrino_medio_cent: base.ordini > 0 ? Math.round(base.incasso_cent / base.ordini) : 0,
  };
}

export const vendutoPerProdotto = (serataId) => db.prepare(`
  SELECT r.nome,
         c.nome AS categoria,
         rp.nome AS reparto,
         SUM(r.quantita)                    AS pezzi,
         SUM(r.quantita * r.prezzo_cent)    AS lordo_cent
  FROM righe r
  JOIN ordini o    ON o.id = r.ordine_id
  JOIN reparti rp  ON rp.id = r.reparto_id
  LEFT JOIN prodotti p ON p.id = r.prodotto_id
  LEFT JOIN categorie c ON c.id = p.categoria_id
  WHERE o.serata_id = ? AND o.annullato = 0
  GROUP BY r.nome, c.nome, rp.nome
  ORDER BY lordo_cent DESC
`).all(serataId);

export const vendutoPerReparto = (serataId) => db.prepare(`
  SELECT rp.nome,
         SUM(r.quantita)                 AS pezzi,
         SUM(r.quantita * r.prezzo_cent) AS lordo_cent
  FROM righe r
  JOIN ordini o   ON o.id = r.ordine_id
  JOIN reparti rp ON rp.id = r.reparto_id
  WHERE o.serata_id = ? AND o.annullato = 0
  GROUP BY rp.id ORDER BY lordo_cent DESC
`).all(serataId);

export const vendutoPerCassa = (serataId) => db.prepare(`
  SELECT c.nome,
         COUNT(DISTINCT o.id)          AS ordini,
         COALESCE(SUM(o.totale_cent), 0) AS incasso_cent
  FROM ordini o JOIN casse c ON c.id = o.cassa_id
  WHERE o.serata_id = ? AND o.annullato = 0
  GROUP BY c.id ORDER BY incasso_cent DESC
`).all(serataId);

/**
 * Andamento orario: serve a decidere quanti volontari mettere in cassa e
 * a che ora accendere la seconda griglia. L'ora si ricava dalla stringa del
 * timestamp, che è già in ora locale.
 */
export const andamentoOrario = (serataId) => db.prepare(`
  SELECT substr(ts, 12, 2) AS ora,
         COUNT(*) AS ordini,
         COALESCE(SUM(totale_cent), 0) AS incasso_cent
  FROM ordini WHERE serata_id = ? AND annullato = 0
  GROUP BY ora ORDER BY ora
`).all(serataId);

/** Confronto fra tutte le serate registrate: la vista storica della festa. */
export const confrontoSerate = () => db.prepare(`
  SELECT s.id, s.nome, s.data, s.edizione, s.aperta,
         COUNT(o.id)                         AS ordini,
         COALESCE(SUM(o.totale_cent), 0)     AS incasso_cent,
         COALESCE(SUM(o.coperti), 0)         AS coperti
  FROM serate s
  LEFT JOIN ordini o ON o.serata_id = s.id AND o.annullato = 0
  GROUP BY s.id ORDER BY s.data, s.id
`).all();

export const confrontoEdizioni = () => db.prepare(`
  SELECT s.edizione,
         COUNT(DISTINCT s.id)                AS serate,
         COUNT(o.id)                         AS ordini,
         COALESCE(SUM(o.totale_cent), 0)     AS incasso_cent
  FROM serate s
  LEFT JOIN ordini o ON o.serata_id = s.id AND o.annullato = 0
  WHERE s.edizione <> ''
  GROUP BY s.edizione ORDER BY s.edizione
`).all();

/** Confronto di un prodotto fra edizioni: "l'anno scorso la weizen tirava?" */
export const prodottoFraEdizioni = (nome) => db.prepare(`
  SELECT s.edizione,
         SUM(r.quantita)                 AS pezzi,
         SUM(r.quantita * r.prezzo_cent) AS lordo_cent
  FROM righe r
  JOIN ordini o ON o.id = r.ordine_id AND o.annullato = 0
  JOIN serate s ON s.id = o.serata_id
  WHERE r.nome = ? AND s.edizione <> ''
  GROUP BY s.edizione ORDER BY s.edizione
`).all(nome);

/** Chiusura di una singola cassa: quanto deve esserci nel cassetto. */
export function chiusuraCassa(serataId, cassaId) {
  const cassa = db.prepare('SELECT * FROM casse WHERE id = ?').get(cassaId);
  const totali = db.prepare(`
    SELECT pagamento, COUNT(*) AS ordini, COALESCE(SUM(totale_cent), 0) AS incasso_cent
    FROM ordini WHERE serata_id = ? AND cassa_id = ? AND annullato = 0
    GROUP BY pagamento ORDER BY pagamento
  `).all(serataId, cassaId);
  const complessivo = totali.reduce(
    (acc, t) => ({ ordini: acc.ordini + t.ordini, incasso_cent: acc.incasso_cent + t.incasso_cent }),
    { ordini: 0, incasso_cent: 0 },
  );
  const storni = db.prepare(`
    SELECT COUNT(*) AS n FROM ordini WHERE serata_id = ? AND cassa_id = ? AND annullato = 1
  `).get(serataId, cassaId).n;
  return { cassa, totali, ...complessivo, storni };
}

export function reportCompleto(serataId) {
  const serata = db.prepare('SELECT * FROM serate WHERE id = ?').get(serataId);
  if (!serata) return null;
  return {
    serata,
    riepilogo: riepilogoSerata(serataId),
    perProdotto: vendutoPerProdotto(serataId),
    perReparto: vendutoPerReparto(serataId),
    perCassa: vendutoPerCassa(serataId),
    perOra: andamentoOrario(serataId),
    consumo: consumoSerata(serataId),
  };
}

/** Documento di chiusura serata, da stampare e allegare al cassetto. */
export function documentoChiusura(serataId) {
  const dati = reportCompleto(serataId);
  if (!dati) throw new Error('serata inesistente');
  const doc = new Documento(config.colonneStampante);

  doc.titolo('CHIUSURA');
  doc.testo(config.nomeFesta, { align: 'center' });
  doc.testo(`${dati.serata.nome} - ${dati.serata.data}`, { align: 'center' });
  doc.separatore('=');

  doc.colonne('Ordini', String(dati.riepilogo.ordini));
  doc.colonne('Pezzi venduti', String(dati.riepilogo.pezzi));
  doc.colonne('Scontrino medio', euro(dati.riepilogo.scontrino_medio_cent));
  if (dati.riepilogo.sconti_cent > 0) doc.colonne('Sconti', euro(dati.riepilogo.sconti_cent));
  if (dati.riepilogo.storni.ordini > 0) {
    doc.colonne(`Storni (${dati.riepilogo.storni.ordini})`, euro(dati.riepilogo.storni.valore_cent));
  }
  doc.separatore();
  doc.colonne('INCASSO', euro(dati.riepilogo.incasso_cent), { size: 2, bold: true });
  doc.separatore('=');

  doc.testo('PER PAGAMENTO', { bold: true });
  for (const p of dati.riepilogo.perPagamento) {
    doc.colonne(`${p.pagamento} (${p.ordini})`, euro(p.incasso_cent));
  }
  doc.separatore();

  doc.testo('PER CASSA', { bold: true });
  for (const c of dati.perCassa) doc.colonne(`${c.nome} (${c.ordini})`, euro(c.incasso_cent));
  doc.separatore();

  doc.testo('PER REPARTO', { bold: true });
  for (const r of dati.perReparto) doc.colonne(`${r.nome} (${r.pezzi} pz)`, euro(r.lordo_cent));
  doc.separatore();

  doc.testo('VENDUTO PER PRODOTTO', { bold: true });
  for (const p of dati.perProdotto) doc.colonne(`${p.pezzi} ${p.nome}`, euro(p.lordo_cent));

  if (dati.consumo.length > 0) {
    doc.separatore();
    doc.testo('CONSUMO MAGAZZINO', { bold: true });
    for (const c of dati.consumo) doc.colonne(c.articolo, `${c.consumato} ${c.unita}`);
  }

  doc.separatore('=');
  doc.testo('Documento non fiscale', { align: 'center' });
  doc.spazio(1);
  doc.taglio();
  return doc;
}
