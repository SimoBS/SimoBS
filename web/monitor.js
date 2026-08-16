import { api, el } from './comune.js';

const CHIAVE_REPARTO = 'simobs.monitor.reparto';
const $ = (id) => document.getElementById(id);
let repartoId = null;

function riquadro(etichetta, valore, genere = '') {
  return el('div', { classe: `riquadro-monitor ${genere}` }, [
    el('span', { classe: 'valore', testo: String(valore) }),
    el('span', { classe: 'etichetta', testo: etichetta }),
  ]);
}

async function aggiorna() {
  if (!repartoId) return;
  try {
    const d = await api(`/api/reparto/${repartoId}/monitor`);
    $('titolo-monitor').textContent = d.reparto.toUpperCase();

    const r = d.riepilogo;
    $('riepilogo').replaceChildren(
      riquadro('comande aperte', r.ordini),
      riquadro('prese in carico', r.presi),
      // Il numero che fa muovere la cucina: per questi ordini l'altro reparto
      // è già uscito, quindi il vassoio può partire.
      riquadro('pronti da far uscire', r.sbloccati, r.sbloccati > 0 ? 'buono' : ''),
      riquadro('attesa max', `${r.attesaMassimaMin}′`, r.attesaMassimaMin >= 15 ? 'allarme' : ''),
    );

    // Il carattere si adatta al numero di prodotti: con poca roba in coda i
    // numeri diventano enormi e si leggono dal fondo del capannone.
    const n = d.daProdurre.length;
    $('lavagna').style.setProperty('--corpo', n <= 4 ? '4.5rem' : n <= 8 ? '3.2rem' : '2.4rem');

    $('lavagna').replaceChildren(...d.daProdurre.map((p) =>
      el('div', { classe: 'voce-lavagna' }, [
        el('span', { classe: 'pezzi', testo: String(p.pezzi) }),
        el('span', { classe: 'prodotto', testo: p.prodotto }),
        p.in_lavorazione > 0
          ? el('span', { classe: 'in-corso', testo: `${p.in_lavorazione} in preparazione` })
          : el('span', { classe: 'in-corso vuoto', testo: 'da iniziare' }),
      ])));

    $('nota').textContent = n === 0 ? 'Niente in coda. Tutto evaso.' : '';
  } catch {
    $('nota').textContent = 'Collegamento al server interrotto.';
  }
}

async function avvia() {
  try {
    const { reparti } = await api('/api/anagrafica');
    const attivi = reparti.filter((r) => r.attivo);
    const scelta = $('scelta-reparto');
    scelta.replaceChildren(...attivi.map((r) => el('option', { value: r.id, testo: r.nome })));

    // Il reparto si può fissare nell'indirizzo, così il monitor appeso riparte
    // sempre sul suo senza che nessuno debba toccarlo dopo un riavvio.
    const daUrl = new URLSearchParams(location.search).get('reparto');
    const perNome = attivi.find((r) => r.nome.toLowerCase() === String(daUrl).toLowerCase());
    const salvato = localStorage.getItem(CHIAVE_REPARTO);

    if (perNome) scelta.value = perNome.id;
    else if (salvato && attivi.some((r) => String(r.id) === salvato)) scelta.value = salvato;
    repartoId = Number(scelta.value) || null;

    scelta.addEventListener('change', (e) => {
      repartoId = Number(e.target.value) || null;
      localStorage.setItem(CHIAVE_REPARTO, e.target.value);
      aggiorna();
    });
  } catch {
    $('nota').textContent = 'Impossibile leggere i reparti.';
  }

  await aggiorna();
  setInterval(aggiorna, 3000);
}

avvia();
