import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spezza, codificaCp858, Documento, versoTesto, versoEscPos } from '../src/escpos.js';

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

test('il taglio emette il comando GS V', () => {
  const doc = new Documento(48);
  doc.taglio();
  const byte = [...versoEscPos(doc)];
  const posizione = byte.findIndex((b, i) => b === 0x1d && byte[i + 1] === 0x56);
  assert.ok(posizione > 0, 'comando di taglio assente');
});
