import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spezza, codificaCp858, Documento, versoTesto, versoEscPos, versoHtml, code39Svg,
} from '../src/escpos.js';

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

test('il Code 39 ha una barra ogni elemento dispari, delimitatori compresi', () => {
  // "*7*" sono 3 caratteri da 9 elementi: 5 barre per carattere, 15 in tutto.
  const svg = code39Svg('7');
  assert.equal((svg.match(/<rect x=/g) ?? []).length, 15);
});

test('il Code 39 lascia la zona di silenzio ai lati, senza la quale non si legge', () => {
  const svg = code39Svg('1', { moduloMm: 0.5 });
  const primaBarra = Number(svg.match(/<rect x="([\d.]+)"/)[1]);
  assert.equal(primaBarra, 5, 'dieci moduli di margine bianco prima della prima barra');
});

test('il Code 39 accetta solo cifre: qualunque altra cosa è un errore, non un codice sbagliato', () => {
  assert.throws(() => code39Svg('12A4'), /non rappresentabile/);
});

test('barre più larghe producono un codice più largo, in proporzione', () => {
  const stretto = Number(code39Svg('123', { moduloMm: 0.25 }).match(/width="([\d.]+)mm"/)[1]);
  const largo = Number(code39Svg('123', { moduloMm: 0.5 }).match(/width="([\d.]+)mm"/)[1]);
  assert.ok(Math.abs(largo - stretto * 2) < 0.01);
});

/**
 * Rilegge un Code 39 dall'SVG come farebbe la pistola: misura le barre e gli
 * spazi fra loro, li classifica in stretti e larghi e ricostruisce i caratteri.
 *
 * È volutamente scritto senza guardare la tabella di codifica, partendo dai
 * disegni: se la tabella in escpos.js fosse sbagliata, questo lo scoprirebbe.
 * L'alternativa sarebbe accorgersene la sera della festa, con la pistola che
 * non aggancia e nessuna idea del perché.
 */
function leggiCode39(svg) {
  const barre = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)]
    .map((m) => ({ x: Number(m[1]), larghezza: Number(m[2]) }));

  // Sequenza alternata barra/spazio, come la vede un lettore ottico.
  const elementi = [];
  barre.forEach((b, i) => {
    elementi.push(b.larghezza);
    const successiva = barre[i + 1];
    if (successiva) elementi.push(Number((successiva.x - (b.x + b.larghezza)).toFixed(3)));
  });

  const stretto = Math.min(...elementi);
  const simboli = elementi.map((e) => (e > stretto * 2 ? 'w' : 'n'));

  // Nove elementi per carattere, più lo spazio di separazione fra caratteri.
  const tabella = {
    nnnwwnwnn: '0', wnnwnnnnw: '1', nnwwnnnnw: '2', wnwwnnnnn: '3', nnnwwnnnw: '4',
    wnnwwnnnn: '5', nnwwwnnnn: '6', nnnwnnwnw: '7', wnnwnnwnn: '8', nnwwnnwnn: '9',
    nnwnwnwnn: '*',
  };
  let letto = '';
  for (let i = 0; i + 9 <= simboli.length; i += 10) {
    const schema = simboli.slice(i, i + 9).join('');
    letto += tabella[schema] ?? '?';
  }
  return letto;
}

test('il codice a barre si rilegge davvero: quello che stampiamo è quello che la pistola vedrà', () => {
  for (const valore of ['1', '42', '1234', '907', '580', '61', '999999']) {
    assert.equal(leggiCode39(code39Svg(valore)), `*${valore}*`,
      `il codice a barre di ${valore} non si rilegge correttamente`);
  }
});

test('il codice a barre esce in tutte e tre le rese del documento', () => {
  const doc = new Documento(48);
  doc.codiceABarre(1234);

  assert.match(versoTesto(doc), /1234/);
  assert.match(versoHtml(doc), /<svg /);

  const byte = [...versoEscPos(doc)];
  // GS k 69 = stampa un CODE39 con lunghezza esplicita.
  const posizione = byte.findIndex((b, i) => b === 0x1d && byte[i + 1] === 0x6b && byte[i + 2] === 69);
  assert.ok(posizione > 0, 'comando di stampa del codice a barre assente');
  assert.equal(byte[posizione + 3], 4, 'la lunghezza dichiarata non corrisponde a "1234"');
});

test('il taglio emette il comando GS V', () => {
  const doc = new Documento(48);
  doc.taglio();
  const byte = [...versoEscPos(doc)];
  const posizione = byte.findIndex((b, i) => b === 0x1d && byte[i + 1] === 0x56);
  assert.ok(posizione > 0, 'comando di taglio assente');
});
