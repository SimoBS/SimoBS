/**
 * Generazione dei documenti da stampare.
 *
 * Un documento è una lista di blocchi astratti (testo, colonne, separatore...).
 * Da lì partono due resa diverse:
 *   - `versoEscPos`  -> byte grezzi per la stampante termica
 *   - `versoTesto`   -> anteprima leggibile a schermo, per provare i layout
 *                       senza sprecare carta e senza avere una stampante sotto mano
 *
 * Tenere il layout separato dai byte significa che si può ridisegnare la
 * comanda guardandola nel browser, e solo dopo mandarla in stampa.
 */

const ESC = 0x1b;
const GS = 0x1d;

// CP858 = CP850 con il simbolo dell'euro a 0xD5. È la tabella che quasi tutte
// le termiche ESC/POS supportano e copre tutti gli accenti italiani.
const CP858 = new Map(Object.entries({
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'å': 0x86,
  'ç': 0x87, 'ê': 0x88, 'ë': 0x89, 'è': 0x8a, 'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d,
  'Ä': 0x8e, 'Å': 0x8f, 'É': 0x90, 'æ': 0x91, 'Æ': 0x92, 'ô': 0x93, 'ö': 0x94,
  'ò': 0x95, 'û': 0x96, 'ù': 0x97, 'ÿ': 0x98, 'Ö': 0x99, 'Ü': 0x9a, '£': 0x9c,
  'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6,
  'º': 0xa7, '¿': 0xa8, '®': 0xa9, '½': 0xab, '¼': 0xac, '¡': 0xad, '«': 0xae,
  '»': 0xaf, 'Á': 0xb5, 'Â': 0xb6, 'À': 0xb7, '©': 0xb8, '¢': 0xbd, '¥': 0xbe,
  'ã': 0xc6, 'Ã': 0xc7, 'Ê': 0xd2, 'Ë': 0xd3, 'È': 0xd4, '€': 0xd5, 'Í': 0xd6,
  'Î': 0xd7, 'Ï': 0xd8, 'Ì': 0xde, 'Ó': 0xe0, 'ß': 0xe1, 'Ô': 0xe2, 'Ò': 0xe3,
  'õ': 0xe4, 'Õ': 0xe5, 'µ': 0xe6, 'Ú': 0xe9, 'Û': 0xea, 'Ù': 0xeb, 'ý': 0xec,
  'Ý': 0xed, '±': 0xf1, '°': 0xf8, '·': 0xfa, '²': 0xfd,
}));

/** Converte una stringa JS in byte CP858. I caratteri ignoti diventano '?'. */
export function codificaCp858(testo) {
  const out = Buffer.alloc(testo.length);
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    const punto = c.codePointAt(0);
    if (punto < 0x80) out[i] = punto;
    else out[i] = CP858.get(c) ?? 0x3f;
  }
  return out;
}

/** Spezza il testo su più righe senza tagliare le parole a metà. */
export function spezza(testo, larghezza) {
  const righe = [];
  for (const paragrafo of String(testo).split('\n')) {
    if (paragrafo === '') {
      righe.push('');
      continue;
    }
    let corrente = '';
    for (const parola of paragrafo.split(/\s+/)) {
      if (corrente === '') {
        corrente = parola;
      } else if ((corrente + ' ' + parola).length <= larghezza) {
        corrente += ' ' + parola;
      } else {
        righe.push(corrente);
        corrente = parola;
      }
      // Una parola singola più lunga della carta va spezzata a forza.
      while (corrente.length > larghezza) {
        righe.push(corrente.slice(0, larghezza));
        corrente = corrente.slice(larghezza);
      }
    }
    righe.push(corrente);
  }
  return righe;
}

function allinea(testo, larghezza, come) {
  if (testo.length >= larghezza) return testo;
  const spazio = larghezza - testo.length;
  if (come === 'center') return ' '.repeat(Math.floor(spazio / 2)) + testo;
  if (come === 'right') return ' '.repeat(spazio) + testo;
  return testo;
}

/**
 * Code 39, solo cifre più i delimitatori.
 *
 * Volutamente ridotto alle cifre: nel codice ci finisce il numero dell'ordine e
 * nient'altro, e una tabella corta è una tabella che non può sbagliare. Code 39
 * invece di Code 128 perché le pistole economiche lo leggono senza doverle
 * configurare, che sotto un tendone è quello che conta.
 *
 * Ogni carattere sono nove elementi alternati barra/spazio, tre dei quali
 * larghi; fra un carattere e l'altro uno spazio stretto.
 */
const CODE39 = {
  0: 'nnnwwnwnn', 1: 'wnnwnnnnw', 2: 'nnwwnnnnw', 3: 'wnwwnnnnn', 4: 'nnnwwnnnw',
  5: 'wnnwwnnnn', 6: 'nnwwwnnnn', 7: 'nnnwnnwnw', 8: 'wnnwnnwnn', 9: 'nnwwnnwnn',
  '*': 'nnwnwnwnn',
};

/** Disegna un Code 39 come SVG, per lo scontrino stampato dal browser. */
export function code39Svg(valore, { moduloMm = 0.33, altezzaMm = 12 } = {}) {
  const testo = `*${String(valore)}*`;
  // Zona di silenzio: senza margine bianco ai lati la pistola non aggancia.
  const silenzio = moduloMm * 10;
  const barre = [];
  let x = silenzio;

  for (const carattere of testo) {
    const schema = CODE39[carattere];
    if (!schema) throw new Error(`carattere non rappresentabile in Code 39: ${carattere}`);
    for (let i = 0; i < schema.length; i++) {
      const larghezza = (schema[i] === 'w' ? 3 : 1) * moduloMm;
      if (i % 2 === 0) barre.push({ x, larghezza }); // gli indici pari sono barre
      x += larghezza;
    }
    x += moduloMm; // spazio fra un carattere e il successivo
  }

  const totale = Number((x - moduloMm + silenzio).toFixed(3));
  const rettangoli = barre
    .map((b) => `<rect x="${b.x.toFixed(3)}" y="0" width="${b.larghezza.toFixed(3)}" height="${altezzaMm}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totale}mm" height="${altezzaMm}mm" `
    + `viewBox="0 0 ${totale} ${altezzaMm}" shape-rendering="crispEdges">`
    + `<rect width="${totale}" height="${altezzaMm}" fill="#fff"/>`
    + `<g fill="#000">${rettangoli}</g></svg>`;
}

/** Costruttore fluente di documenti di stampa. */
export class Documento {
  constructor(larghezza = 48) {
    this.larghezza = larghezza;
    this.blocchi = [];
  }

  testo(v, opzioni = {}) {
    this.blocchi.push({ t: 'testo', v: String(v ?? ''), ...opzioni });
    return this;
  }

  titolo(v) {
    return this.testo(v, { align: 'center', bold: true, size: 2 });
  }

  /** Riga a due colonne: descrizione a sinistra, importo a destra. */
  colonne(sx, dx, opzioni = {}) {
    this.blocchi.push({ t: 'colonne', sx: String(sx ?? ''), dx: String(dx ?? ''), ...opzioni });
    return this;
  }

  separatore(carattere = '-') {
    this.blocchi.push({ t: 'separatore', carattere });
    return this;
  }

  /** Codice a barre da leggere con la pistola alle postazioni di reparto. */
  codiceABarre(valore) {
    this.blocchi.push({ t: 'barcode', v: String(valore) });
    return this;
  }

  spazio(n = 1) {
    this.blocchi.push({ t: 'spazio', n });
    return this;
  }

  taglio() {
    this.blocchi.push({ t: 'taglio' });
    return this;
  }
}

/** Larghezza utile in caratteri per un blocco, tenuto conto del corpo doppio. */
function larghezzaBlocco(doc, blocco) {
  return Math.floor(doc.larghezza / (blocco.size ?? 1));
}

/**
 * Nell'anteprima a schermo il corpo ingrandito viene reso distanziando i
 * caratteri, così una riga larga il doppio occupa a video lo stesso spazio che
 * occuperà sulla carta. È un'approssimazione voluta: serve a vedere se il testo
 * ci sta, non a riprodurre il font della termica.
 */
function rendiCorpo(riga, size) {
  const n = size ?? 1;
  if (n <= 1) return riga;
  return riga.split('').join(' '.repeat(n - 1));
}

/**
 * Riduce il documento a righe già impaginate, ognuna con il proprio corpo,
 * allineamento e grassetto.
 *
 * È il passaggio comune alle tre rese (testo, HTML, ESC/POS): l'impaginazione
 * — dove va a capo una descrizione lunga, come si allinea un importo a destra —
 * esiste in un posto solo, quindi una comanda vista in anteprima è impaginata
 * esattamente come quella che esce dalla carta.
 */
function* righeLogiche(doc) {
  for (const b of doc.blocchi) {
    if (b.t === 'spazio') {
      for (let i = 0; i < (b.n ?? 1); i++) yield { tipo: 'vuoto', v: '' };
    } else if (b.t === 'separatore') {
      yield { tipo: 'separatore', v: b.carattere.repeat(doc.larghezza) };
    } else if (b.t === 'taglio') {
      yield { tipo: 'taglio', v: '' };
    } else if (b.t === 'barcode') {
      yield { tipo: 'barcode', v: b.v };
    } else if (b.t === 'testo') {
      for (const r of spezza(b.v, larghezzaBlocco(doc, b))) {
        yield { tipo: 'testo', v: r, size: b.size ?? 1, bold: !!b.bold, align: b.align ?? 'left' };
      }
    } else if (b.t === 'colonne') {
      const l = larghezzaBlocco(doc, b);
      const spazioSx = Math.max(1, l - b.dx.length - 1);
      const parti = spezza(b.sx, spazioSx);
      for (let i = 0; i < parti.length; i++) {
        // L'importo sta solo sull'ultima riga: se la descrizione va a capo,
        // le righe precedenti restano piene di sola descrizione.
        const coda = i === parti.length - 1 ? b.dx : '';
        yield {
          tipo: 'testo',
          v: parti[i].padEnd(l - coda.length, ' ') + coda,
          size: b.size ?? 1,
          bold: !!b.bold,
          align: 'left',
        };
      }
    }
  }
}

/** Rende il documento come testo semplice, per anteprima e diagnostica. */
export function versoTesto(doc) {
  const righe = [];
  for (const r of righeLogiche(doc)) {
    if (r.tipo === 'taglio') righe.push('-'.repeat(doc.larghezza - 2) + ' ✂');
    else if (r.tipo === 'barcode') righe.push(allinea(`|||| ${r.v} ||||`, doc.larghezza, 'center'));
    else if (r.tipo === 'testo') righe.push(allinea(rendiCorpo(r.v, r.size), doc.larghezza, r.align));
    else righe.push(r.v);
  }
  return righe.join('\n');
}

const fugaHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Rende il documento come pagina HTML pronta per la stampa dal browser.
 *
 * Serve per gli scontrini stampati da una termica collegata in USB al PC della
 * cassa: quella stampante il server non la può raggiungere via rete, la
 * raggiunge solo il browser di quel PC attraverso il driver di Windows.
 *
 * Il carattere è a spaziatura fissa e il corpo è calcolato perché esattamente
 * `doc.larghezza` caratteri riempiano la carta: così l'allineamento a colonne,
 * che è fatto di spazi, cade dove deve cadere come sulla termica di rete.
 */
export function versoHtml(doc, { larghezzaMm = 80, margineMm = 4, titolo = 'Scontrino' } = {}) {
  // Larghezza davvero stampabile: una termica da 80mm scrive su circa 72mm,
  // il resto è il bordo che la testina non raggiunge.
  const utileMm = Math.max(10, larghezzaMm - margineMm * 2);
  // Nei font a spaziatura fissa un carattere è largo circa 0,6 volte il corpo.
  const corpoMm = utileMm / (doc.larghezza * 0.6);

  const righe = [...righeLogiche(doc)].map((r) => {
    if (r.tipo === 'taglio') return '<div class="taglio"></div>';
    if (r.tipo === 'barcode') return `<div class="cb">${code39Svg(r.v)}</div>`;
    if (r.tipo === 'vuoto') return '<div class="r">&nbsp;</div>';
    if (r.tipo === 'separatore') return `<div class="r">${fugaHtml(r.v)}</div>`;
    const classi = ['r'];
    if (r.size > 1) classi.push(`c${r.size}`);
    if (r.bold) classi.push('g');
    if (r.align !== 'left') classi.push(r.align === 'center' ? 'centro' : 'destra');
    return `<div class="${classi.join(' ')}">${fugaHtml(r.v)}</div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>${fugaHtml(titolo)}</title><style>
  /* Il formato della carta lo decide il driver del rullo, che sa quanto è
     lungo lo scontrino e dove tagliare. Imporlo qui è sbagliato: "80mm auto"
     non è nemmeno CSS valido (non si mescola una lunghezza con auto) e una
     misura fissa farebbe avanzare carta bianca a ogni scontrino.
     Qui si fissa solo la larghezza del contenuto, centrata sul rullo. */
  @page { size: auto; margin: 0; }
  html { margin: 0; padding: 0; background: #fff; }
  body { width: ${utileMm}mm; margin: 0 auto; padding: 0; background: #fff; }
  .r {
    font-family: "Courier New", Courier, monospace;
    font-size: ${corpoMm.toFixed(3)}mm;
    line-height: 1.15;
    white-space: pre;
    color: #000;
  }
  /* Il corpo ingrandito raddoppia o triplica: le righe sono già state
     impaginate su meno caratteri, quindi la larghezza fisica resta la stessa. */
  .c2 { font-size: ${(corpoMm * 2).toFixed(3)}mm; }
  .c3 { font-size: ${(corpoMm * 3).toFixed(3)}mm; }
  .g { font-weight: 700; }
  .centro { text-align: center; }
  .destra { text-align: right; }
  /* Il codice a barre non va mai riscalato: le larghezze delle barre sono
     calcolate in millimetri perché la pistola le legga. */
  .cb { text-align: center; margin: 1.5mm 0; }
  .cb svg { display: inline-block; }
  /* Il taglio della carta lo fa il driver a fine documento: qui serve solo
     un po' di margine perché la lama non tagli sull'ultima riga. */
  .taglio { height: 6mm; }
</style></head><body>
${righe}
</body></html>`;
}

/** Rende il documento come byte ESC/POS pronti per la stampante. */
export function versoEscPos(doc) {
  const pezzi = [];
  const raw = (...b) => pezzi.push(Buffer.from(b));
  const txt = (s) => pezzi.push(codificaCp858(s));

  raw(ESC, 0x40); // reset
  raw(ESC, 0x74, 19); // tabella caratteri PC858

  let bold = false;
  let size = 1;
  let align = 'left';

  const impostaBold = (v) => {
    if (bold === v) return;
    bold = v;
    raw(ESC, 0x45, v ? 1 : 0);
  };
  const impostaSize = (v) => {
    if (size === v) return;
    size = v;
    const n = ((v - 1) << 4) | (v - 1);
    raw(GS, 0x21, n);
  };
  const impostaAlign = (v) => {
    if (align === v) return;
    align = v;
    raw(ESC, 0x61, v === 'center' ? 1 : v === 'right' ? 2 : 0);
  };

  for (const b of doc.blocchi) {
    if (b.t === 'spazio') {
      raw(ESC, 0x64, b.n ?? 1);
    } else if (b.t === 'separatore') {
      impostaSize(1);
      impostaBold(false);
      impostaAlign('left');
      txt(b.carattere.repeat(doc.larghezza) + '\n');
    } else if (b.t === 'taglio') {
      impostaSize(1);
      impostaBold(false);
      impostaAlign('left');
      raw(ESC, 0x64, 4); // avanza la carta oltre la lama
      raw(GS, 0x56, 0x42, 0x00); // taglio parziale
    } else if (b.t === 'barcode') {
      impostaSize(1);
      impostaBold(false);
      impostaAlign('center');
      raw(GS, 0x68, 60); // altezza del codice in punti
      raw(GS, 0x77, 2); // larghezza del modulo stretto
      raw(GS, 0x48, 0); // niente cifre sotto: il numero lo stampiamo noi, grande
      const dati = codificaCp858(b.v);
      // Funzione B (con lunghezza esplicita): più robusta della variante
      // terminata da NUL sulle stampanti compatibili. 69 = CODE39.
      raw(GS, 0x6b, 69, dati.length);
      pezzi.push(dati);
      txt('\n');
    } else if (b.t === 'testo') {
      impostaSize(b.size ?? 1);
      impostaBold(!!b.bold);
      impostaAlign(b.align ?? 'left');
      for (const r of spezza(b.v, larghezzaBlocco(doc, b))) txt(r + '\n');
    } else if (b.t === 'colonne') {
      impostaSize(b.size ?? 1);
      impostaBold(!!b.bold);
      impostaAlign('left');
      const l = larghezzaBlocco(doc, b);
      const spazioSx = Math.max(1, l - b.dx.length - 1);
      const parti = spezza(b.sx, spazioSx);
      parti.forEach((parte, i) => {
        const coda = i === parti.length - 1 ? b.dx : '';
        txt(parte.padEnd(l - coda.length, ' ') + coda + '\n');
      });
    }
  }

  impostaSize(1);
  impostaBold(false);
  impostaAlign('left');
  return Buffer.concat(pezzi);
}
