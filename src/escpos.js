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

/** Rende il documento come testo semplice, per anteprima e diagnostica. */
export function versoTesto(doc) {
  const righe = [];
  for (const b of doc.blocchi) {
    if (b.t === 'spazio') {
      for (let i = 0; i < (b.n ?? 1); i++) righe.push('');
    } else if (b.t === 'separatore') {
      righe.push(b.carattere.repeat(doc.larghezza));
    } else if (b.t === 'taglio') {
      righe.push('-'.repeat(doc.larghezza - 2) + ' ✂');
    } else if (b.t === 'testo') {
      for (const r of spezza(b.v, larghezzaBlocco(doc, b))) {
        righe.push(allinea(rendiCorpo(r, b.size), doc.larghezza, b.align ?? 'left'));
      }
    } else if (b.t === 'colonne') {
      const l = larghezzaBlocco(doc, b);
      const spazioSx = Math.max(1, l - b.dx.length - 1);
      const parti = spezza(b.sx, spazioSx);
      parti.forEach((parte, i) => {
        const coda = i === parti.length - 1 ? b.dx : '';
        righe.push(rendiCorpo(parte.padEnd(l - coda.length, ' ') + coda, b.size));
      });
    }
  }
  return righe.join('\n');
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
