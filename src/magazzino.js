import { db, adesso } from './db.js';

/**
 * Regola non negoziabile del magazzino: non blocca MAI una vendita.
 *
 * Se la giacenza va sotto zero è perché qualcuno ha caricato male i fusti, non
 * perché il cliente non deve bere. Le scorte qui servono a dire "stanno finendo
 * le salamelle" mezz'ora prima che finiscano davvero, non a fare da guardiano.
 */

export function listaArticoli() {
  const righe = db.prepare(`
    SELECT id, nome, unita, giacenza, soglia_minima, attivo
    FROM articoli
    ORDER BY nome
  `).all();
  return righe.map((a) => ({ ...a, stato: statoArticolo(a) }));
}

function statoArticolo(a) {
  if (a.giacenza <= 0) return 'esaurito';
  if (a.soglia_minima > 0 && a.giacenza <= a.soglia_minima) return 'basso';
  return 'ok';
}

export function allarmiScorte() {
  return listaArticoli().filter((a) => a.attivo && a.stato !== 'ok');
}

/** Registra un movimento e aggiorna la giacenza. Da usare dentro transazione. */
export function registraMovimento({ articoloId, quantita, tipo, ordineId = null, nota = '' }) {
  db.prepare('UPDATE articoli SET giacenza = giacenza + ? WHERE id = ?').run(quantita, articoloId);
  db.prepare(`
    INSERT INTO movimenti (articolo_id, quantita, tipo, ordine_id, nota, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(articoloId, quantita, tipo, ordineId, nota, adesso());
}

/** Carico da bolla: arrivano i fusti. */
export function carica({ articoloId, quantita, nota = '' }) {
  if (!(quantita > 0)) throw new Error('la quantità di carico deve essere positiva');
  registraMovimento({ articoloId, quantita, tipo: 'carico', nota });
  return db.prepare('SELECT * FROM articoli WHERE id = ?').get(articoloId);
}

/** Inventario fisico: la giacenza vera è quella che hai contato tu. */
export function rettifica({ articoloId, giacenzaReale, nota = '' }) {
  const a = db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(articoloId);
  if (!a) throw new Error('articolo inesistente');
  const delta = giacenzaReale - a.giacenza;
  if (delta !== 0) {
    registraMovimento({ articoloId, quantita: delta, tipo: 'rettifica', nota: nota || 'inventario' });
  }
  return db.prepare('SELECT * FROM articoli WHERE id = ?').get(articoloId);
}

const distintaDi = () => db.prepare('SELECT articolo_id, quantita FROM distinta WHERE prodotto_id = ?');

/**
 * Scarica le scorte consumate da un ordine, seguendo la distinta base.
 * Somma per articolo prima di scrivere: un ordine = un movimento per articolo,
 * altrimenti la lista movimenti diventa illeggibile dopo tre serate.
 */
export function scaricaPerOrdine(ordineId, righe, segno = -1) {
  const perArticolo = new Map();
  for (const r of righe) {
    if (!r.prodotto_id) continue;
    for (const d of distintaDi().all(r.prodotto_id)) {
      const attuale = perArticolo.get(d.articolo_id) ?? 0;
      perArticolo.set(d.articolo_id, attuale + d.quantita * r.quantita);
    }
  }
  for (const [articoloId, quantita] of perArticolo) {
    registraMovimento({
      articoloId,
      quantita: segno * quantita,
      tipo: segno < 0 ? 'vendita' : 'storno',
      ordineId,
    });
  }
}

export function movimenti({ articoloId = null, limite = 200 } = {}) {
  const dove = articoloId ? 'WHERE m.articolo_id = ?' : '';
  const parametri = articoloId ? [articoloId, limite] : [limite];
  return db.prepare(`
    SELECT m.id, m.quantita, m.tipo, m.nota, m.ts,
           a.nome AS articolo, a.unita,
           o.numero AS numero_ordine
    FROM movimenti m
    JOIN articoli a ON a.id = m.articolo_id
    LEFT JOIN ordini o ON o.id = m.ordine_id
    ${dove}
    ORDER BY m.id DESC
    LIMIT ?
  `).all(...parametri);
}

/**
 * Consumo per articolo in una serata: quanto è uscito davvero dal magazzino,
 * ricavato dai movimenti e non ricalcolato dalle vendite.
 */
export function consumoSerata(serataId) {
  return db.prepare(`
    SELECT a.nome AS articolo, a.unita,
           ROUND(SUM(-m.quantita), 3) AS consumato
    FROM movimenti m
    JOIN articoli a ON a.id = m.articolo_id
    JOIN ordini o   ON o.id = m.ordine_id
    WHERE o.serata_id = ? AND m.tipo IN ('vendita', 'storno')
    GROUP BY a.id
    HAVING consumato <> 0
    ORDER BY consumato DESC
  `).all(serataId);
}
