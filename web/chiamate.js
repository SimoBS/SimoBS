import { api, el } from './comune.js';

const $ = (id) => document.getElementById(id);

// I numeri già mostrati, per accorgersi di quelli nuovi e metterli in evidenza.
let visti = new Set();
let primoGiro = true;

function orologio() {
  const d = new Date();
  $('orologio').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function aggiorna() {
  try {
    const { festa, ordini } = await api('/api/chiamate');
    $('titolo-monitor').textContent = festa ? `${festa} — numeri pronti` : 'Numeri pronti';

    $('numeri').replaceChildren(...ordini.map((o) => el('div', {
      // Solo i numeri comparsi da poco lampeggiano: al primo caricamento
      // lampeggerebbe tutto, e non servirebbe a niente.
      classe: `numero-pronto ${!primoGiro && !visti.has(o.numero) ? 'nuovo' : ''}`,
      testo: String(o.numero),
    })));

    visti = new Set(ordini.map((o) => o.numero));
    primoGiro = false;

    $('nota').textContent = ordini.length === 0
      ? 'Nessun ordine pronto in questo momento.'
      : 'Ritira la tua ordinazione al banco mostrando lo scontrino.';
  } catch {
    $('nota').textContent = 'Collegamento al server interrotto.';
  }
}

orologio();
setInterval(orologio, 20000);
aggiorna();
setInterval(aggiorna, 3000);
