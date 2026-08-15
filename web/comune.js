// Funzioni condivise dalle tre pagine. Niente librerie esterne: tutto quello
// che serve deve funzionare su una LAN senza internet e su un browser vecchio.

export async function api(percorso, opzioni = {}) {
  const risposta = await fetch(percorso, {
    headers: { 'Content-Type': 'application/json' },
    ...opzioni,
    body: opzioni.corpo !== undefined ? JSON.stringify(opzioni.corpo) : undefined,
  });
  const tipo = risposta.headers.get('Content-Type') ?? '';
  if (!tipo.includes('application/json')) {
    if (!risposta.ok) throw new Error(`errore ${risposta.status}`);
    return risposta.text();
  }
  const dati = await risposta.json();
  if (!risposta.ok) throw new Error(dati.errore ?? `errore ${risposta.status}`);
  return dati;
}

/** Centesimi -> "12,50". Gli importi non diventano mai numeri con la virgola. */
export function euro(centesimi) {
  const segno = centesimi < 0 ? '-' : '';
  const v = Math.abs(Math.round(centesimi));
  return `${segno}${Math.floor(v / 100)},${String(v % 100).padStart(2, '0')}`;
}

/** "12,50" oppure "12.5" -> 1250 centesimi. */
export function inCentesimi(testo) {
  const n = Number(String(testo).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function el(tag, attributi = {}, figli = []) {
  const nodo = document.createElement(tag);
  for (const [k, v] of Object.entries(attributi)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'classe') nodo.className = v;
    else if (k === 'testo') nodo.textContent = v;
    else if (k === 'html') nodo.innerHTML = v;
    else if (k.startsWith('on')) nodo.addEventListener(k.slice(2), v);
    else if (k === 'stile') Object.assign(nodo.style, v);
    else nodo.setAttribute(k, v);
  }
  for (const f of [].concat(figli)) {
    if (f === null || f === undefined || f === false) continue;
    nodo.append(typeof f === 'string' || typeof f === 'number' ? String(f) : f);
  }
  return nodo;
}

export function messaggio(testo, genere = '') {
  let contenitore = document.getElementById('messaggi');
  if (!contenitore) {
    contenitore = el('div', { id: 'messaggi' });
    document.body.append(contenitore);
  }
  const nodo = el('div', { classe: `messaggio ${genere}`, testo });
  contenitore.append(nodo);
  setTimeout(() => nodo.remove(), genere === 'errore' ? 8000 : 3500);
}

/** Segnala l'errore all'utente invece di lasciarlo solo in console. */
export function conErrori(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      messaggio(err.message, 'errore');
    }
  };
}

/**
 * Stampa una pagina HTML sulla stampante collegata a QUESTO pc, passando dal
 * driver di Windows.
 *
 * La termica dello scontrino è attaccata in USB alla cassa: il server non la
 * può raggiungere, la raggiunge solo questo browser. Il documento viene messo
 * in un iframe fuori schermo e stampato da lì, così la pagina della cassa non
 * si sposta e l'operatore non vede niente.
 *
 * Perché non compaia la finestra di dialogo a ogni scontrino, Chrome va
 * avviato con l'opzione --kiosk-printing (vedi README e avvia-cassa.bat).
 */
export function stampaDalBrowser(html) {
  return new Promise((risolvi) => {
    const telaio = document.createElement('iframe');
    telaio.setAttribute('aria-hidden', 'true');
    Object.assign(telaio.style, {
      position: 'fixed', right: '0', bottom: '0',
      width: '0', height: '0', border: '0', visibility: 'hidden',
    });
    telaio.srcdoc = html;
    telaio.onload = () => {
      try {
        telaio.contentWindow.focus();
        telaio.contentWindow.print();
      } catch (err) {
        console.error('stampa non riuscita', err);
      }
      // L'iframe non si rimuove subito: con la finestra di dialogo aperta,
      // toglierlo annullerebbe la stampa.
      setTimeout(() => {
        telaio.remove();
        risolvi();
      }, 4000);
    };
    document.body.append(telaio);
  });
}

export function evidenziaNav() {
  const qui = location.pathname.split('/').pop() || 'cassa.html';
  for (const a of document.querySelectorAll('.navlink')) {
    if (a.getAttribute('href') === qui) a.classList.add('attivo');
  }
}

export const NOMI_MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

export function dataBreve(iso) {
  if (!iso) return '';
  const [a, m, g] = iso.slice(0, 10).split('-');
  return `${Number(g)} ${NOMI_MESI[Number(m) - 1]} ${a}`;
}
