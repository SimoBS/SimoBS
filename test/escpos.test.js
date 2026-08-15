import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spezza, codificaCp858, Documento, versoTesto, versoEscPos, versoHtml } from '../src/escpos.js';

test('spezza va a capo senza tagliare le parole', () => {
  assert.deepEqual(spezza('Salamella con patatine fritte', 12), ['Salamella', 'con patatine', 'fritte']);
});

test('spezza troncando le parole più lunghe della carta', () => {
  assert.deepEqual(spezza('AAAAAAAAAA', 4), ['AAAA', 'AAAA', 'AA']);
});

test('spezza conserva le righe vuote fra paragrafi', () => {
  assert.deepEqual(spezza('uno\n\ndue', 20), ['uno', '', 'due']);
});

test('gli accenti italiani e l\'euro finiscono nella tabella CP858', () => {
  assert.deepEqual([...codificaCp858('àèéìòù€')], [0x85, 0x8a, 0x82, 0x8d, 0x95, 0x97, 0xd5]);
});

test('i caratteri non rappresentabili diventano punto interrogativo, senza rompere la stampa', () => {
  assert.equal(codificaCp858('ciao 😀').at(-1), 0x3f);
});

test('le colonne allineano l\'importo a destra sulla larghezza della carta', () => {
  const doc = new Documento(24);
  doc.colonne('Birra', '5,00');
  assert.equal(versoTesto(doc), 'Birra               5,00');
});

test('una descrizione lunga manda a capo e tiene l\'importo sull\'ultima riga', () => {
  const doc = new Documento(20);
  doc.colonne('Panino con porchetta e patatine', '12,50');
  const righe = versoTesto(doc).split('\n');
  assert.ok(righe.length > 1);
  assert.ok(righe.at(-1).endsWith('12,50'));
  for (const r of righe) assert.ok(r.length <= 20, `riga troppo larga: "${r}"`);
});

test('il corpo doppio dimezza i caratteri disponibili per riga', () => {
  const doc = new Documento(48);
  doc.testo('ABCDEFGHIJKLMNOPQRSTUVWXYZ', { size: 2 });
  // 26 caratteri non entrano in 24 colonne a corpo doppio: deve andare a capo.
  assert.equal(versoTesto(doc).split('\n').length, 2);
});

test('i byte ESC/POS iniziano con reset e selezione della tabella caratteri', () => {
  const doc = new Documento(48);
  doc.testo('x');
  const byte = versoEscPos(doc);
  assert.deepEqual([...byte.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 19]);
});

test('la resa HTML impagina le colonne come quella per la termica', () => {
  // Stesso documento, due destinazioni diverse: le righe devono coincidere,
  // altrimenti lo scontrino stampato dal PC della cassa sarebbe impaginato
  // diversamente da quello stampato dalla termica di rete.
  const doc = new Documento(32);
  doc.colonne('Salamella con patatine', '6,50');
  const daTesto = versoTesto(doc).split('\n');
  const daHtml = versoHtml(doc).match(/<div class="r">([^<]*)<\/div>/g)
    .map((r) => r.replace(/<[^>]+>/g, ''));
  assert.deepEqual(daHtml, daTesto);
});

test('la pagina HTML lascia il formato al driver del rullo e fissa solo la larghezza utile', () => {
  const doc = new Documento(32);
  doc.testo('x');
  const html = versoHtml(doc, { larghezzaMm: 58, margineMm: 4 });
  // Nessuna misura di pagina imposta: la lunghezza dello scontrino e il taglio
  // li gestisce il driver, altrimenti si fa avanzare carta bianca ogni volta.
  assert.match(html, /@page \{ size: auto; margin: 0; \}/);
  // 58mm di carta meno 4mm di bordo per lato = 50mm scrivibili.
  assert.match(html, /body \{ width: 50mm;/);
});

test('la resa HTML mette in salvo i caratteri speciali invece di produrre marcatori', () => {
  const doc = new Documento(48);
  doc.testo('Panino <con> "salsa" & senape');
  const html = versoHtml(doc);
  assert.match(html, /&lt;con&gt;/);
  assert.match(html, /&amp; senape/);
});

test('il corpo del carattere HTML cresce col corpo del blocco', () => {
  const doc = new Documento(48);
  doc.testo('grande', { size: 2 });
  const html = versoHtml(doc);
  const base = Number(html.match(/\.r \{[^}]*font-size: ([\d.]+)mm/)[1]);
  const doppio = Number(html.match(/\.c2 \{ font-size: ([\d.]+)mm/)[1]);
  assert.ok(Math.abs(doppio - base * 2) < 0.01);
});

test('il taglio emette il comando GS V', () => {
  const doc = new Documento(48);
  doc.taglio();
  const byte = [...versoEscPos(doc)];
  const posizione = byte.findIndex((b, i) => b === 0x1d && byte[i + 1] === 0x56);
  assert.ok(posizione > 0, 'comando di taglio assente');
});
