/**
 * Dati di esempio di una festa della birra plausibile.
 *
 *   node --no-warnings src/seed.js           carica solo se il database è vuoto
 *   node --no-warnings src/seed.js --reset   svuota tutto e ricarica
 *
 * Serve per provare il sistema e come punto di partenza da modificare dal
 * pannello di gestione: prezzi, prodotti e reparti si cambiano da lì.
 */
import { db, adesso } from './db.js';

const reset = process.argv.includes('--reset');

if (reset) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['stampe', 'movimenti', 'righe', 'ordini', 'distinta', 'prodotti',
    'articoli', 'categorie', 'reparti', 'casse', 'serate']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  console.log('database svuotato');
}

if (db.prepare('SELECT COUNT(*) AS n FROM prodotti').get().n > 0) {
  console.log('ci sono già dei prodotti: non tocco niente. Usa --reset per ripartire da zero.');
  process.exit(0);
}

const idDi = (info) => Number(info.lastInsertRowid);

// --- Casse -----------------------------------------------------------------
// stampante_host vuoto = nessuno scontrino cliente. Da compilare in gestione
// con l'IP vero delle stampanti quando si monta l'impianto.
const insCassa = db.prepare('INSERT INTO casse (nome, stampante_host, stampante_porta) VALUES (?, ?, 9100)');
const cassa1 = idDi(insCassa.run('Cassa 1', null));
const cassa2 = idDi(insCassa.run('Cassa 2', null));

// --- Reparti ---------------------------------------------------------------
const insReparto = db.prepare(
  'INSERT INTO reparti (nome, stampante_host, stampante_porta, copie, ordine) VALUES (?, ?, 9100, ?, ?)',
);
const spina = idDi(insReparto.run('Spina', null, 1, 1));
const cucina = idDi(insReparto.run('Cucina', null, 1, 2));
const griglia = idDi(insReparto.run('Griglia', null, 1, 3));
const bar = idDi(insReparto.run('Bar', null, 1, 4));

// --- Categorie -------------------------------------------------------------
const insCategoria = db.prepare('INSERT INTO categorie (nome, colore, ordine) VALUES (?, ?, ?)');
const catBirre = idDi(insCategoria.run('Birre', '#d98324', 1));
const catGriglia = idDi(insCategoria.run('Griglia', '#a4432b', 2));
const catCucina = idDi(insCategoria.run('Cucina', '#7a8b3f', 3));
const catBibite = idDi(insCategoria.run('Bibite', '#3f6f8b', 4));
const catDolci = idDi(insCategoria.run('Dolci', '#8b3f6f', 5));

// --- Magazzino -------------------------------------------------------------
const insArticolo = db.prepare(
  'INSERT INTO articoli (nome, unita, giacenza, soglia_minima) VALUES (?, ?, ?, ?)',
);
const artBionda = idDi(insArticolo.run('Fusto Bionda', 'L', 300, 50));
const artRossa = idDi(insArticolo.run('Fusto Rossa', 'L', 150, 30));
const artWeizen = idDi(insArticolo.run('Fusto Weizen', 'L', 100, 20));
const artBicchieri = idDi(insArticolo.run('Bicchieri', 'pz', 2000, 300));
const artSalamelle = idDi(insArticolo.run('Salamelle', 'pz', 400, 60));
const artPanini = idDi(insArticolo.run('Panini', 'pz', 500, 80));
const artPatatine = idDi(insArticolo.run('Patatine (porzioni)', 'pz', 300, 50));
const artCostine = idDi(insArticolo.run('Costine', 'kg', 60, 10));
const artAcqua = idDi(insArticolo.run('Acqua 0,5L', 'pz', 400, 60));
const artLattine = idDi(insArticolo.run('Lattine bibite', 'pz', 300, 50));

// --- Prodotti + distinta base ---------------------------------------------
const insProdotto = db.prepare(`
  INSERT INTO prodotti (nome, nome_comanda, categoria_id, reparto_id, prezzo_cent, ordine)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insDistinta = db.prepare('INSERT INTO distinta (prodotto_id, articolo_id, quantita) VALUES (?, ?, ?)');

function prodotto({ nome, comanda, categoria, reparto, prezzo, ordine, consuma = [] }) {
  const id = idDi(insProdotto.run(nome, comanda, categoria, reparto, prezzo, ordine));
  for (const [articolo, quantita] of consuma) insDistinta.run(id, articolo, quantita);
  return id;
}

prodotto({ nome: 'Bionda 0,2L', comanda: 'BIONDA piccola', categoria: catBirre, reparto: spina, prezzo: 300, ordine: 1,
  consuma: [[artBionda, 0.2], [artBicchieri, 1]] });
prodotto({ nome: 'Bionda 0,4L', comanda: 'BIONDA media', categoria: catBirre, reparto: spina, prezzo: 500, ordine: 2,
  consuma: [[artBionda, 0.4], [artBicchieri, 1]] });
prodotto({ nome: 'Bionda 1L', comanda: 'BIONDA LITRO', categoria: catBirre, reparto: spina, prezzo: 1100, ordine: 3,
  consuma: [[artBionda, 1], [artBicchieri, 1]] });
prodotto({ nome: 'Rossa 0,4L', comanda: 'ROSSA media', categoria: catBirre, reparto: spina, prezzo: 550, ordine: 4,
  consuma: [[artRossa, 0.4], [artBicchieri, 1]] });
prodotto({ nome: 'Rossa 1L', comanda: 'ROSSA LITRO', categoria: catBirre, reparto: spina, prezzo: 1200, ordine: 5,
  consuma: [[artRossa, 1], [artBicchieri, 1]] });
prodotto({ nome: 'Weizen 0,4L', comanda: 'WEIZEN media', categoria: catBirre, reparto: spina, prezzo: 600, ordine: 6,
  consuma: [[artWeizen, 0.4], [artBicchieri, 1]] });

prodotto({ nome: 'Salamella', comanda: 'SALAMELLA', categoria: catGriglia, reparto: griglia, prezzo: 400, ordine: 1,
  consuma: [[artSalamelle, 1], [artPanini, 1]] });
prodotto({ nome: 'Salamella + patatine', comanda: 'SALAM.+PAT', categoria: catGriglia, reparto: griglia, prezzo: 650, ordine: 2,
  consuma: [[artSalamelle, 1], [artPanini, 1], [artPatatine, 1]] });
prodotto({ nome: 'Costine (etto)', comanda: 'COSTINE', categoria: catGriglia, reparto: griglia, prezzo: 350, ordine: 3,
  consuma: [[artCostine, 0.1]] });
prodotto({ nome: 'Grigliata mista', comanda: 'GRIGLIATA', categoria: catGriglia, reparto: griglia, prezzo: 1400, ordine: 4,
  consuma: [[artCostine, 0.3], [artSalamelle, 1]] });

prodotto({ nome: 'Patatine fritte', comanda: 'PATATINE', categoria: catCucina, reparto: cucina, prezzo: 350, ordine: 1,
  consuma: [[artPatatine, 1]] });
prodotto({ nome: 'Panino con porchetta', comanda: 'PORCHETTA', categoria: catCucina, reparto: cucina, prezzo: 550, ordine: 2,
  consuma: [[artPanini, 1]] });
prodotto({ nome: 'Tagliere di salumi', comanda: 'TAGLIERE', categoria: catCucina, reparto: cucina, prezzo: 900, ordine: 3 });

prodotto({ nome: 'Acqua 0,5L', comanda: 'ACQUA', categoria: catBibite, reparto: bar, prezzo: 100, ordine: 1,
  consuma: [[artAcqua, 1]] });
prodotto({ nome: 'Bibita in lattina', comanda: 'BIBITA', categoria: catBibite, reparto: bar, prezzo: 250, ordine: 2,
  consuma: [[artLattine, 1]] });
prodotto({ nome: 'Caffè', comanda: 'CAFFE', categoria: catBibite, reparto: bar, prezzo: 120, ordine: 3 });
prodotto({ nome: 'Amaro', comanda: 'AMARO', categoria: catBibite, reparto: bar, prezzo: 300, ordine: 4 });

prodotto({ nome: 'Torta della casa', comanda: 'TORTA', categoria: catDolci, reparto: cucina, prezzo: 300, ordine: 1 });
prodotto({ nome: 'Gelato', comanda: 'GELATO', categoria: catDolci, reparto: bar, prezzo: 250, ordine: 2 });

// --- Serata aperta ---------------------------------------------------------
const oggi = adesso().slice(0, 10);
db.prepare('INSERT INTO serate (nome, data, edizione, aperta, aperta_il) VALUES (?, ?, ?, 1, ?)')
  .run('Serata di prova', oggi, String(new Date().getFullYear()), adesso());

console.log('dati di esempio caricati:');
console.log(`  ${db.prepare('SELECT COUNT(*) AS n FROM prodotti').get().n} prodotti`);
console.log(`  ${db.prepare('SELECT COUNT(*) AS n FROM articoli').get().n} articoli di magazzino`);
console.log(`  2 casse, 4 reparti, 1 serata aperta`);
console.log('');
console.log('Le stampanti NON sono configurate: aprile in /gestione.html e metti gli IP veri.');
