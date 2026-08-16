import { api, el, messaggio, conErrori, evidenziaNav } from './comune.js';

const CHIAVE_REPARTO = 'simobs.reparto';
const CHIAVE_OPERATORE = 'simobs.operatore';

const $ = (id) => document.getElementById(id);
const stato = { repartoId: null, collegato: true };

/** Da quanto è in attesa questo ordine, in minuti. */
function attesaMinuti(ts) {
  const [ora, minuti] = ts.slice(11, 16).split(':').map(Number);
  const adesso = new Date();
  let diff = (adesso.getHours() * 60 + adesso.getMinutes()) - (ora * 60 + minuti);
  if (diff < 0) diff += 24 * 60; // la serata ha passato la mezzanotte
  return diff;
}

const destinazione = (o) => (o.servizio === 'asporto' ? 'ASPORTO'
  : o.servizio === 'self' ? 'SELF' : `TAVOLO ${o.tavolo}`);

const ETICHETTE = { da_fare: 'da fare', in_lavorazione: 'in preparazione', uscito: 'uscito' };

function schedaOrdine(ordine, { azione, etichettaAzione, classeAzione }) {
  const altri = ordine.reparti.filter((r) => r.reparto_id !== stato.repartoId);
  const altriUsciti = altri.length > 0 && altri.every((r) => r.stato === 'uscito');
  const attesa = attesaMinuti(ordine.ts);

  return el('article', {
    classe: `ordine ${altriUsciti && azione ? 'sollecito' : ''} ${attesa >= 10 && azione ? 'in-ritardo' : ''}`,
  }, [
    el('header', {}, [
      // Il tavolo domina: è quello che serve a chi monta il vassoio e a chi lo
      // porta. Il numero di comanda serve solo a ritrovare il pezzo di carta.
      el('span', { classe: 'numero-ordine', testo: destinazione(ordine) }),
      el('div', { classe: 'meta' }, [
        el('div', { testo: `comanda n. ${ordine.numero} · ${ordine.ts.slice(11, 16)} · ${ordine.cassa}` }),
        ordine.coperti > 0 ? el('div', { testo: `${ordine.coperti} coperti` }) : null,
        el('div', { classe: attesa >= 10 ? 'attesa lunga' : 'attesa', testo: `${attesa} min` }),
      ]),
    ]),

    el('ul', { classe: 'righe-comanda' }, ordine.righe.map((r) =>
      el('li', {}, [
        el('b', { testo: `${r.quantita}×` }),
        ` ${r.nome_comanda || r.nome}`,
        r.nota ? el('em', { classe: 'nota-riga', testo: ` — ${r.nota}` }) : null,
      ]))),

    ordine.nota ? el('div', { classe: 'nota-ordine', testo: ordine.nota }) : null,

    // Il pezzo che sincronizza: com'è messo l'altro reparto su questo ordine.
    altri.length > 0
      ? el('div', { classe: 'altri-reparti' }, altri.map((r) =>
        el('span', {
          classe: `pillola ${r.stato === 'uscito' ? 'ok' : 'basso'}`,
          testo: `${r.reparto}: ${ETICHETTE[r.stato]}`,
        })))
      : el('div', { classe: 'altri-reparti' }, [
        el('span', { classe: 'spiega', testo: 'solo questo reparto su questo ordine' }),
      ]),

    azione
      ? el('button', {
        classe: classeAzione,
        testo: etichettaAzione,
        onclick: conErrori(async () => {
          await azione(ordine);
          await aggiorna();
        }),
      })
      : null,
  ]);
}

async function aggiorna() {
  if (!stato.repartoId) return;
  try {
    const coda = await api(`/api/reparto/${stato.repartoId}/coda`);
    stato.collegato = true;

    $('n-da-fare').textContent = coda.daFare.length;
    $('n-attesa').textContent = coda.inLavorazione.length;

    const vuoto = (testo) => el('p', { classe: 'spiega', testo });
    const avanza = (ordine) => api(`/api/reparto/${stato.repartoId}/avanza`, {
      method: 'POST',
      corpo: { ordineId: ordine.id, operatore: $('operatore').value.trim() },
    });

    $('da-fare').replaceChildren(...(coda.daFare.length
      ? coda.daFare.map((o) => schedaOrdine(o, {
        etichettaAzione: 'Prendi in carico',
        classeAzione: 'azione-ordine',
        azione: avanza,
      }))
      : [vuoto('Niente da preparare.')]));

    $('in-attesa').replaceChildren(...(coda.inLavorazione.length
      ? coda.inLavorazione.map((o) => schedaOrdine(o, {
        etichettaAzione: 'Vassoio consegnato al cameriere',
        classeAzione: 'bottone-verde azione-ordine',
        azione: avanza,
      }))
      : [vuoto('Niente in preparazione.')]));

    $('completati').replaceChildren(...(coda.usciti.length
      ? coda.usciti.map((o) => schedaOrdine(o, {
        etichettaAzione: 'Riporta indietro',
        classeAzione: 'azione-ordine',
        azione: (ordine) => api(`/api/reparto/${stato.repartoId}/indietro`, {
          method: 'POST',
          corpo: { ordineId: ordine.id },
        }),
      }))
      : [vuoto('Ancora nessun vassoio uscito.')]));
  } catch {
    stato.collegato = false;
  }
  $('pallino').classList.toggle('giu', !stato.collegato);
  $('etichetta-rete').textContent = stato.collegato ? 'collegato' : 'server non raggiungibile';
}

function mostraEsito(testo, genere) {
  const nodo = $('esito-lettura');
  nodo.className = `esito ${genere}`;
  nodo.textContent = testo;
  clearTimeout(mostraEsito.timer);
  mostraEsito.timer = setTimeout(() => {
    nodo.textContent = '';
    nodo.className = 'esito';
  }, 6000);
}

async function leggiCodice(codice) {
  if (!codice) return;
  if (!stato.repartoId) return mostraEsito('Scegli prima di che reparto è questa postazione', 'ko');
  try {
    const esito = await api(`/api/reparto/${stato.repartoId}/scansione`, {
      method: 'POST',
      corpo: { codice, operatore: $('operatore').value.trim() },
    });
    const dove = destinazione(esito);
    const altriFuori = esito.reparti
      .filter((r) => r.reparto_id !== stato.repartoId && r.stato !== 'uscito')
      .map((r) => r.reparto);

    if (esito.passaggio === 'rimbalzo') {
      mostraEsito(`${dove}: letto un attimo fa, non ho fatto niente`, 'parziale');
    } else if (esito.passaggio === 'gia_uscito') {
      mostraEsito(`${dove}: questo vassoio è già uscito`, 'parziale');
    } else if (esito.passaggio === 'in_lavorazione') {
      mostraEsito(`${dove} — preso in carico. Spara di nuovo quando esce il vassoio.`, 'parziale');
    } else if (altriFuori.length > 0) {
      // Informativo, non bloccante: la regola "il cibo dopo il bere" la
      // applicano le persone, il sistema si limita a dire come sta messo l'altro.
      mostraEsito(`${dove} — vassoio uscito. ${altriFuori.join(', ')}: non ancora uscito.`, 'parziale');
    } else {
      mostraEsito(`${dove} — vassoio uscito. Ordine completo.`, 'ok');
    }
    await aggiorna();
  } catch (err) {
    mostraEsito(err.message, 'ko');
  }
}

async function avvia() {
  evidenziaNav();

  $('operatore').value = localStorage.getItem(CHIAVE_OPERATORE) ?? '';
  $('operatore').addEventListener('change', (e) =>
    localStorage.setItem(CHIAVE_OPERATORE, e.target.value.trim()));

  const campo = $('codice');
  campo.addEventListener('keydown', (e) => {
    // La pistola conclude la lettura con Invio, come farebbe una tastiera.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const codice = campo.value.trim();
    campo.value = '';
    leggiCodice(codice);
  });

  // Il campo di lettura deve avere SEMPRE il fuoco: chi sta al banco spara e
  // basta, senza cliccare da nessuna parte. Se il fuoco si perde per un clic
  // altrove, torna qui appena si smette di interagire con un altro comando.
  const riprendiFuoco = () => {
    const attivo = document.activeElement;
    if (attivo === campo || attivo === $('operatore') || attivo?.tagName === 'SELECT') return;
    campo.focus();
  };
  campo.addEventListener('blur', () => setTimeout(riprendiFuoco, 100));
  document.addEventListener('click', () => setTimeout(riprendiFuoco, 100));
  setInterval(riprendiFuoco, 2000);
  campo.focus();

  try {
    const { reparti } = await api('/api/anagrafica');
    const attivi = reparti.filter((r) => r.attivo);
    const scelta = $('scelta-reparto');
    scelta.replaceChildren(...attivi.map((r) => el('option', { value: r.id, testo: r.nome })));

    const salvato = localStorage.getItem(CHIAVE_REPARTO);
    if (salvato && attivi.some((r) => String(r.id) === salvato)) scelta.value = salvato;
    stato.repartoId = Number(scelta.value) || null;
    $('titolo-reparto').textContent = scelta.selectedOptions[0]?.textContent ?? 'Postazione';

    scelta.addEventListener('change', (e) => {
      stato.repartoId = Number(e.target.value) || null;
      localStorage.setItem(CHIAVE_REPARTO, e.target.value);
      $('titolo-reparto').textContent = e.target.selectedOptions[0]?.textContent ?? 'Postazione';
      aggiorna();
      campo.focus();
    });
  } catch (err) {
    messaggio(`Impossibile leggere i reparti: ${err.message}`, 'errore');
  }

  await aggiorna();
  // Le comande nuove arrivano dalla cassa: la coda si aggiorna da sola.
  setInterval(aggiorna, 3000);
}

avvia();
