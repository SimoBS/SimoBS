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

function schedaOrdine(ordine, { azione, etichettaAzione, classeAzione }) {
  const altri = ordine.reparti.filter((r) => r.reparto_id !== stato.repartoId);
  const altriPronti = altri.length > 0 && altri.every((r) => r.stato === 'pronto');
  const attesa = attesaMinuti(ordine.ts);

  return el('article', {
    classe: `ordine ${altriPronti && azione ? 'sollecito' : ''} ${attesa >= 10 && azione ? 'in-ritardo' : ''}`,
  }, [
    el('header', {}, [
      el('span', { classe: 'numero-ordine', testo: `${ordine.numero}` }),
      el('div', { classe: 'meta' }, [
        el('div', { testo: `${ordine.ts.slice(11, 16)} · ${ordine.cassa}` }),
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
          classe: `pillola ${r.stato === 'pronto' ? 'ok' : 'basso'}`,
          testo: `${r.reparto}: ${r.stato === 'pronto' ? 'pronto' : 'in lavorazione'}`,
        })))
      : el('div', { classe: 'altri-reparti' }, [
        el('span', { classe: 'spiega', testo: 'nessun altro reparto su questo ordine' }),
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
    $('n-attesa').textContent = coda.inAttesaDiAltri.length;

    const vuoto = (testo) => el('p', { classe: 'spiega', testo });

    $('da-fare').replaceChildren(...(coda.daFare.length
      ? coda.daFare.map((o) => schedaOrdine(o, {
        etichettaAzione: 'Segna pronto',
        classeAzione: 'bottone-verde azione-ordine',
        azione: (ordine) => api(`/api/reparto/${stato.repartoId}/pronto`, {
          method: 'POST',
          corpo: { ordineId: ordine.id, operatore: $('operatore').value.trim() },
        }),
      }))
      : [vuoto('Niente da preparare.')]));

    $('in-attesa').replaceChildren(...(coda.inAttesaDiAltri.length
      ? coda.inAttesaDiAltri.map((o) => schedaOrdine(o, {
        etichettaAzione: 'Rimetti in lavorazione',
        classeAzione: 'azione-ordine',
        azione: (ordine) => api(`/api/reparto/${stato.repartoId}/riapri`, {
          method: 'POST',
          corpo: { ordineId: ordine.id },
        }),
      }))
      : [vuoto('Niente in attesa.')]));

    $('completati').replaceChildren(...(coda.completatiDiRecente.length
      ? coda.completatiDiRecente.map((o) => schedaOrdine(o, {}))
      : [vuoto('Ancora nessun ordine consegnato.')]));
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
    const mancanti = esito.reparti.filter((r) => r.stato !== 'pronto').map((r) => r.reparto);
    if (esito.giaAnnullato) mostraEsito(`Comanda n. ${esito.numero} annullata`, 'ko');
    else if (esito.completo) mostraEsito(`n. ${esito.numero} COMPLETO — si può consegnare`, 'ok');
    else mostraEsito(`n. ${esito.numero} pronto qui, manca ancora: ${mancanti.join(', ')}`, 'parziale');
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
