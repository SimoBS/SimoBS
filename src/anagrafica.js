import { db, adesso } from './db.js';

// ---------------------------------------------------------------------------
// Serate
// ---------------------------------------------------------------------------

/**
 * La serata è l'unità di raggruppamento di tutto il sistema, e non la data.
 * Una festa che va avanti fino alle 2 di notte resta una sola serata: i report
 * non si spaccano a mezzanotte e la numerazione delle comande non riparte.
 */
export function serataAperta() {
  return db.prepare('SELECT * FROM serate WHERE aperta = 1 ORDER BY id DESC LIMIT 1').get();
}

export function listaSerate() {
  return db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM ordini o WHERE o.serata_id = s.id AND o.annullato = 0) AS ordini,
           (SELECT COALESCE(SUM(o.totale_cent), 0) FROM ordini o WHERE o.serata_id = s.id AND o.annullato = 0) AS incasso_cent
    FROM serate s
    ORDER BY s.id DESC
  `).all();
}

export function apriSerata({ nome, data, edizione = '' }) {
  const gia = serataAperta();
  if (gia) throw new Error(`la serata "${gia.nome}" è ancora aperta: chiudila prima di aprirne un'altra`);
  const info = db.prepare(`
    INSERT INTO serate (nome, data, edizione, aperta, aperta_il) VALUES (?, ?, ?, 1, ?)
  `).run(nome, data, edizione, adesso());
  return db.prepare('SELECT * FROM serate WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function chiudiSerata(id) {
  db.prepare('UPDATE serate SET aperta = 0, chiusa_il = ? WHERE id = ?').run(adesso(), id);
  return db.prepare('SELECT * FROM serate WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// Casse, reparti, categorie, prodotti
// ---------------------------------------------------------------------------

export const listaCasse = () => db.prepare('SELECT * FROM casse ORDER BY nome').all();
export const listaReparti = () => db.prepare('SELECT * FROM reparti ORDER BY ordine, nome').all();
export const listaCategorie = () => db.prepare('SELECT * FROM categorie ORDER BY ordine, nome').all();

export const listaProdotti = () => db.prepare(`
  SELECT p.*, c.nome AS categoria, r.nome AS reparto
  FROM prodotti p
  JOIN categorie c ON c.id = p.categoria_id
  JOIN reparti r   ON r.id = p.reparto_id
  ORDER BY c.ordine, p.ordine, p.nome
`).all();

/** Catalogo per l'interfaccia cassa: solo il vendibile, già raggruppato. */
export function menuCassa() {
  const categorie = listaCategorie();
  const prodotti = db.prepare(`
    SELECT id, nome, nome_comanda, categoria_id, reparto_id, prezzo_cent
    FROM prodotti WHERE attivo = 1 ORDER BY ordine, nome
  `).all();
  return categorie
    .map((c) => ({ ...c, prodotti: prodotti.filter((p) => p.categoria_id === c.id) }))
    .filter((c) => c.prodotti.length > 0);
}

function salva(tabella, campi, dati) {
  const presenti = campi.filter((c) => dati[c] !== undefined);
  if (presenti.length === 0) throw new Error('nessun campo da salvare');
  if (dati.id) {
    db.prepare(`UPDATE ${tabella} SET ${presenti.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...presenti.map((c) => dati[c]), dati.id);
    return db.prepare(`SELECT * FROM ${tabella} WHERE id = ?`).get(dati.id);
  }
  const info = db.prepare(
    `INSERT INTO ${tabella} (${presenti.join(', ')}) VALUES (${presenti.map(() => '?').join(', ')})`,
  ).run(...presenti.map((c) => dati[c]));
  return db.prepare(`SELECT * FROM ${tabella} WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export const salvaCassa = (d) => salva('casse', ['nome', 'modo_stampa', 'stampante_host', 'stampante_porta', 'attiva'], d);
export const salvaReparto = (d) => salva('reparti', ['nome', 'stampante_host', 'stampante_porta', 'copie', 'ordine', 'attivo'], d);
export const salvaCategoria = (d) => salva('categorie', ['nome', 'colore', 'ordine'], d);
export const salvaProdotto = (d) => salva('prodotti', ['nome', 'nome_comanda', 'categoria_id', 'reparto_id', 'prezzo_cent', 'ordine', 'attivo'], d);
export const salvaArticolo = (d) => salva('articoli', ['nome', 'unita', 'soglia_minima', 'attivo'], d);

/**
 * I prodotti non si cancellano mai se hanno venduto: sparirebbero dai report
 * delle serate passate. Si disattivano, e basta.
 */
export function eliminaProdotto(id) {
  const usato = db.prepare('SELECT COUNT(*) AS n FROM righe WHERE prodotto_id = ?').get(id).n;
  if (usato > 0) {
    db.prepare('UPDATE prodotti SET attivo = 0 WHERE id = ?').run(id);
    return { eliminato: false, disattivato: true };
  }
  db.prepare('DELETE FROM distinta WHERE prodotto_id = ?').run(id);
  db.prepare('DELETE FROM prodotti WHERE id = ?').run(id);
  return { eliminato: true, disattivato: false };
}

/** Distinta base di un prodotto: cosa consuma dal magazzino ogni pezzo venduto. */
export function distintaProdotto(prodottoId) {
  return db.prepare(`
    SELECT d.articolo_id, d.quantita, a.nome AS articolo, a.unita
    FROM distinta d JOIN articoli a ON a.id = d.articolo_id
    WHERE d.prodotto_id = ?
    ORDER BY a.nome
  `).all(prodottoId);
}

export function impostaDistinta(prodottoId, voci) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM distinta WHERE prodotto_id = ?').run(prodottoId);
    const ins = db.prepare('INSERT INTO distinta (prodotto_id, articolo_id, quantita) VALUES (?, ?, ?)');
    for (const v of voci) {
      if (!(v.quantita > 0)) continue;
      ins.run(prodottoId, v.articolo_id, v.quantita);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return distintaProdotto(prodottoId);
}
