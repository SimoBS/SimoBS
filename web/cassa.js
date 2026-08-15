import { api, euro, inCentesimi, el, messaggio, evidenziaNav } from './comune.js';

const PAGAMENTI = ['contanti', 'pos', 'gettoni'];
const CHIAVE_CODA = 'simobs.coda';
const CHIAVE_CASSA = 'simobs.cassa';
const CHIAVE_OPERATORE = 'simobs.operatore';

const stato = {
  menu: [],
  categoriaAttiva: null,
  carrello: [],
  pagamento: 'contanti',
  cassaId: null,
  collegato: true,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Coda di invio locale
//
// Serve per i buchi di rete: il Wi-Fi del tendone cade per qualche secondo e la
// cassa non deve né bloccarsi né perdere l'ordine. L'ordine resta nel browser
// con la sua chiave di idempotenza e riparte da solo appena il server risponde.
// Se invece il server è spento davvero, questa coda non fa miracoli: le comande
// non escono finché non torna su, e l'avviso rosso in alto lo dice chiaramente.
// ---------------------------------------------------------------------------

const leggiCoda = () => {
  try {
    return JSON.parse(localStorage.getItem(CHIAVE_CODA) ?? '[]');
  } catch {
    return [];
  }
};
const scriviCoda = (coda) => localStorage.setItem(CHIAVE_CODA, JSON.stringify(coda));

function accodaLocale(ordine) {
  const coda = leggiCoda();
  coda.push(ordine);
  scriviCoda(coda);
  aggiornaStatoRete();
}

async function svuotaCodaLocale() {
  let coda = leggiCoda();
  if (coda.length === 0) return;
  while (coda.length > 0) {
    const primo = coda[0];
    try {
      const esito = await api('/api/ordini', { method: 'POST', corpo: primo });
      coda = leggiCoda().filter((o) => o.idemKey !== primo.idemKey);
      scriviCoda(coda);
      messaggio(`Ordine in attesa inviato: comanda n. ${esito.numero}`, 'ok');
    } catch {
      // Ancora irraggiungibile: si riprova al prossimo giro.
      return;
    }
  }
  aggiornaStatoRete();
}

// ---------------------------------------------------------------------------
// Carrello
// ---------------------------------------------------------------------------

function aggiungi(prodotto, colore) {
  const esistente = stato.carrello.find((r) => r.prodottoId === prodotto.id && !r.nota);
  if (esistente) esistente.quantita += 1;
  else {
    stato.carrello.push({
      prodottoId: prodotto.id,
      nome: prodotto.nome,
      prezzoCent: prodotto.prezzo_cent,
      quantita: 1,
      nota: '',
      colore,
    });
  }
  disegnaScontrino();
}

function cambiaQuantita(indice, delta) {
  const riga = stato.carrello[indice];
  riga.quantita += delta;
  if (riga.quantita <= 0) stato.carrello.splice(indice, 1);
  disegnaScontrino();
}

const lordoCent = () => stato.carrello.reduce((t, r) => t + r.prezzoCent * r.quantita, 0);

function scontoCent() {
  const richiesto = Math.max(0, inCentesimi($('sconto').value));
  return Math.min(richiesto, lordoCent());
}

const totaleCent = () => lordoCent() - scontoCent();

// ---------------------------------------------------------------------------
// Disegno
// ---------------------------------------------------------------------------

function disegnaCategorie() {
  const nodo = $('categorie');
  nodo.replaceChildren(...stato.menu.map((c) =>
    el('button', {
      classe: c.id === stato.categoriaAttiva ? 'attiva' : '',
      stile: { '--colore': c.colore },
      testo: c.nome,
      onclick: () => {
        stato.categoriaAttiva = c.id;
        disegnaCategorie();
        disegnaProdotti();
      },
    })));
}

function disegnaProdotti() {
  const categoria = stato.menu.find((c) => c.id === stato.categoriaAttiva);
  const nodo = $('prodotti');
  if (!categoria) return nodo.replaceChildren();
  nodo.replaceChildren(...categoria.prodotti.map((p) =>
    el('button', {
      classe: 'prodotto',
      stile: { '--colore': categoria.colore },
      onclick: () => aggiungi(p, categoria.colore),
    }, [
      el('span', { classe: 'nome', testo: p.nome }),
      el('span', { classe: 'prezzo', testo: `€ ${euro(p.prezzo_cent)}` }),
    ])));
}

function disegnaScontrino() {
  $('righe').replaceChildren(...stato.carrello.map((r, i) =>
    el('div', { classe: 'riga' }, [
      el('div', {}, [
        el('div', { classe: 'nome', testo: r.nome }),
        el('div', { classe: 'dettaglio', testo: `€ ${euro(r.prezzoCent)} cad.${r.nota ? ` — ${r.nota}` : ''}` }),
      ]),
      el('div', { classe: 'quantita' }, [
        el('button', { testo: '−', onclick: () => cambiaQuantita(i, -1) }),
        el('span', { classe: 'valore', testo: String(r.quantita) }),
        el('button', { testo: '+', onclick: () => cambiaQuantita(i, +1) }),
      ]),
      el('div', { classe: 'importo', testo: euro(r.prezzoCent * r.quantita) }),
    ])));
  $('totale').textContent = euro(totaleCent());
  $('incassa').disabled = stato.carrello.length === 0;
}

function disegnaPagamenti() {
  $('pagamenti').replaceChildren(...PAGAMENTI.map((p) =>
    el('button', {
      classe: p === stato.pagamento ? 'attivo' : '',
      testo: p,
      onclick: () => {
        stato.pagamento = p;
        disegnaPagamenti();
      },
    })));
}

function mostraBrindisi(numero, totale) {
  $('brindisi-numero').textContent = numero;
  $('brindisi-totale').textContent = `€ ${euro(totale)}`;
  $('brindisi').classList.add('visibile');
  clearTimeout(mostraBrindisi.timer);
  mostraBrindisi.timer = setTimeout(chiudiBrindisi, 4000);
}

const chiudiBrindisi = () => $('brindisi').classList.remove('visibile');

function aggiornaStatoRete() {
  const inCoda = leggiCoda().length;
  $('pallino').classList.toggle('giu', !stato.collegato || inCoda > 0);
  $('etichetta-rete').textContent = inCoda > 0
    ? `${inCoda} ordin${inCoda === 1 ? 'e' : 'i'} da inviare`
    : stato.collegato ? 'collegato' : 'server non raggiungibile';
}

// ---------------------------------------------------------------------------
// Incasso
// ---------------------------------------------------------------------------

function svuotaCarrello() {
  stato.carrello = [];
  $('sconto').value = '0';
  $('coperti').value = '0';
  $('nota-ordine').value = '';
  disegnaScontrino();
}

async function incassa() {
  if (stato.carrello.length === 0) return;
  if (!stato.cassaId) return messaggio('Scegli la postazione di cassa', 'errore');

  const ordine = {
    // La chiave nasce QUI e non sul server: è quella che rende sicuro il
    // rinvio dopo un timeout. Stesso ordine, stessa chiave, un solo incasso.
    idemKey: (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
    cassaId: stato.cassaId,
    operatore: $('operatore').value.trim(),
    pagamento: stato.pagamento,
    scontoCent: scontoCent(),
    coperti: Number($('coperti').value) || 0,
    nota: $('nota-ordine').value.trim(),
    righe: stato.carrello.map((r) => ({ prodottoId: r.prodottoId, quantita: r.quantita, nota: r.nota })),
  };

  const totale = totaleCent();
  const bottone = $('incassa');
  bottone.disabled = true;

  try {
    const esito = await api('/api/ordini', { method: 'POST', corpo: ordine });
    stato.collegato = true;
    svuotaCarrello();
    mostraBrindisi(esito.numero, esito.totale_cent);
    aggiornaStatoRete();
  } catch (err) {
    // Distinzione importante: un rifiuto del server (prodotto inesistente,
    // serata chiusa) NON va accodato, va mostrato. Solo la rete che cade
    // giustifica la coda locale.
    const reteCaduta = err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(err.message);
    if (reteCaduta) {
      stato.collegato = false;
      accodaLocale(ordine);
      svuotaCarrello();
      messaggio(`Rete assente: ordine da € ${euro(totale)} salvato, parte appena torna il collegamento.`, 'errore');
    } else {
      messaggio(err.message, 'errore');
    }
  } finally {
    bottone.disabled = stato.carrello.length === 0;
  }
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

async function aggiornaStato() {
  try {
    const s = await api('/api/stato');
    stato.collegato = true;

    $('titolo-festa').textContent = s.festa;
    $('etichetta-serata').textContent = s.serata ? `${s.serata.nome} — ${s.serata.data}` : '';

    const avviso = $('avviso-serata');
    if (!s.serata) {
      avviso.style.display = 'block';
      avviso.textContent = 'Nessuna serata aperta: non si può incassare. Aprine una da Gestione.';
    } else {
      avviso.style.display = 'none';
    }

    const scelta = $('scelta-cassa');
    if (scelta.options.length !== s.casse.length) {
      scelta.replaceChildren(...s.casse.map((c) => el('option', { value: c.id, testo: c.nome })));
      const salvata = localStorage.getItem(CHIAVE_CASSA);
      if (salvata && s.casse.some((c) => String(c.id) === salvata)) scelta.value = salvata;
      stato.cassaId = Number(scelta.value) || null;
    }

    await svuotaCodaLocale();
  } catch {
    stato.collegato = false;
  }
  aggiornaStatoRete();
}

async function avvia() {
  evidenziaNav();
  disegnaPagamenti();
  disegnaScontrino();

  $('operatore').value = localStorage.getItem(CHIAVE_OPERATORE) ?? '';
  $('operatore').addEventListener('change', (e) =>
    localStorage.setItem(CHIAVE_OPERATORE, e.target.value.trim()));

  $('scelta-cassa').addEventListener('change', (e) => {
    stato.cassaId = Number(e.target.value) || null;
    localStorage.setItem(CHIAVE_CASSA, e.target.value);
  });

  $('sconto').addEventListener('input', disegnaScontrino);
  $('svuota').addEventListener('click', svuotaCarrello);
  $('incassa').addEventListener('click', incassa);
  $('brindisi').addEventListener('click', chiudiBrindisi);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') chiudiBrindisi();
  });

  try {
    stato.menu = await api('/api/menu');
    stato.categoriaAttiva = stato.menu[0]?.id ?? null;
    disegnaCategorie();
    disegnaProdotti();
  } catch (err) {
    messaggio(`Impossibile caricare il menu: ${err.message}`, 'errore');
  }

  await aggiornaStato();
  // Un giro ogni 5 secondi: tiene aggiornato lo stato e, soprattutto, è quello
  // che fa ripartire da sola la coda locale quando la rete torna.
  setInterval(aggiornaStato, 5000);
}

avvia();
