import { api, euro, inCentesimi, el, messaggio, conErrori, evidenziaNav, stampaDalBrowser } from './comune.js';

const PAGAMENTI = ['contanti', 'pos', 'gettoni'];
const SERVIZI = [
  ['tavolo', 'Al tavolo'],
  ['self', 'Self service'],
  ['asporto', 'Asporto'],
];
const CHIAVE_CODA = 'simobs.coda';
const CHIAVE_CASSA = 'simobs.cassa';
const CHIAVE_OPERATORE = 'simobs.operatore';
const CHIAVE_POSTAZIONE = 'simobs.postazione';

/**
 * Identificativo di QUESTO computer, non della cassa scelta nel menu.
 * Serve al server per accorgersi se due PC diversi stanno incassando sulla
 * stessa cassa: sarebbe un guaio scoperto solo a fine serata, contando i
 * cassetti e trovandone uno vuoto e uno doppio.
 */
function idPostazione() {
  let id = localStorage.getItem(CHIAVE_POSTAZIONE);
  if (!id) {
    id = crypto.randomUUID?.() ?? `p-${Date.now()}-${Math.random()}`;
    localStorage.setItem(CHIAVE_POSTAZIONE, id);
  }
  return id;
}

const stato = {
  menu: [],
  categoriaAttiva: null,
  carrello: [],
  pagamento: 'contanti',
  servizio: 'tavolo',
  cassaId: null,
  collegato: true,
  ultimoScontrino: null,
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
      // Lo scontrino di un ordine rimasto in coda non è mai stato stampato:
      // esce adesso, con il numero che il server gli ha finalmente assegnato.
      if (esito.scontrinoHtml) {
        stato.ultimoScontrino = { numero: esito.numero, html: esito.scontrinoHtml };
        $('ristampa').disabled = false;
        await stampaDalBrowser(esito.scontrinoHtml);
      }
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

function disegnaServizi() {
  $('servizi').replaceChildren(...SERVIZI.map(([valore, etichetta]) =>
    el('button', {
      classe: valore === stato.servizio ? 'attivo' : '',
      testo: etichetta,
      onclick: () => {
        stato.servizio = valore;
        disegnaServizi();
        if (valore === 'tavolo') $('tavolo').focus();
      },
    })));

  // Senza tavolo non c'è niente da scrivere, e i coperti non si contano:
  // i campi si spengono invece di restare lì a farsi compilare per sbaglio.
  const alTavolo = stato.servizio === 'tavolo';
  $('tavolo').disabled = !alTavolo;
  $('coperti').disabled = !alTavolo;
  if (!alTavolo) {
    $('tavolo').value = '';
    $('coperti').value = '0';
  }
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

const destinazione = (o) => (o.servizio === 'asporto' ? 'Asporto'
  : o.servizio === 'self' ? 'Self service' : `Tavolo ${o.tavolo}`);

function mostraBrindisi(esito) {
  $('brindisi-numero').textContent = esito.numero;
  $('brindisi-totale').textContent = `${destinazione(esito)} — € ${euro(esito.totale_cent)}`;
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
  $('tavolo').value = '';
  $('nota-ordine').value = '';
  // Il servizio torna al caso più frequente, pronto per il cliente dopo.
  stato.servizio = 'tavolo';
  disegnaServizi();
  disegnaScontrino();
}

async function incassa() {
  if (stato.carrello.length === 0) return;
  if (!stato.cassaId) return messaggio('Scegli la postazione di cassa', 'errore');

  const tavolo = $('tavolo').value.trim();
  if (stato.servizio === 'tavolo' && !tavolo) {
    $('tavolo').focus();
    return messaggio('Manca il numero di tavolo: senza, il cameriere non sa dove portare il vassoio.', 'errore');
  }

  const ordine = {
    // La chiave nasce QUI e non sul server: è quella che rende sicuro il
    // rinvio dopo un timeout. Stesso ordine, stessa chiave, un solo incasso.
    idemKey: (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
    cassaId: stato.cassaId,
    operatore: $('operatore').value.trim(),
    pagamento: stato.pagamento,
    servizio: stato.servizio,
    tavolo,
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
    mostraBrindisi(esito);
    aggiornaStatoRete();
    // Le comande di Cucina e Bar le manda il server alle stampanti di rete.
    // Lo scontrino del cliente arriva invece qui come HTML, perché la sua
    // stampante è attaccata a questo PC e solo questo browser la vede.
    if (esito.scontrinoHtml) {
      stato.ultimoScontrino = { numero: esito.numero, html: esito.scontrinoHtml };
      $('ristampa').disabled = false;
      stampaDalBrowser(esito.scontrinoHtml);
    }
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
    const parametri = new URLSearchParams({ postazione: idPostazione() });
    if (stato.cassaId) parametri.set('cassaId', stato.cassaId);
    const s = await api(`/api/stato?${parametri}`);
    stato.collegato = true;

    const avvisoPostazione = $('avviso-postazione');
    if (s.postazioniSullaStessaCassa > 1) {
      const nome = $('scelta-cassa').selectedOptions[0]?.textContent ?? 'questa cassa';
      avvisoPostazione.style.display = 'block';
      avvisoPostazione.textContent =
        `Attenzione: un altro computer sta incassando su ${nome}. `
        + 'Uno dei due deve cambiare postazione, altrimenti a fine serata gli '
        + 'incassi delle due casse risulteranno mescolati.';
    } else {
      avvisoPostazione.style.display = 'none';
    }

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
  disegnaServizi();
  disegnaPagamenti();
  disegnaScontrino();

  $('operatore').value = localStorage.getItem(CHIAVE_OPERATORE) ?? '';
  $('operatore').addEventListener('change', (e) =>
    localStorage.setItem(CHIAVE_OPERATORE, e.target.value.trim()));

  $('scelta-cassa').addEventListener('change', (e) => {
    stato.cassaId = Number(e.target.value) || null;
    localStorage.setItem(CHIAVE_CASSA, e.target.value);
    // Subito, non al prossimo giro: se la postazione appena scelta è già
    // occupata da un altro PC va detto prima che parta il primo incasso.
    aggiornaStato();
  });

  $('sconto').addEventListener('input', disegnaScontrino);
  $('svuota').addEventListener('click', svuotaCarrello);
  $('incassa').addEventListener('click', incassa);

  $('ristampa').addEventListener('click', () => {
    if (!stato.ultimoScontrino) return;
    stampaDalBrowser(stato.ultimoScontrino.html);
    messaggio(`Ristampa scontrino n. ${stato.ultimoScontrino.numero}`, 'ok');
  });

  // La prova va fatta da qui e non dal pannello di gestione: la stampante è
  // attaccata a questo PC, il server non la può raggiungere.
  $('prova-stampante').addEventListener('click', conErrori(async () => {
    if (!stato.cassaId) throw new Error('Scegli prima la postazione di cassa');
    const esito = await api('/api/stampe/prova', {
      method: 'POST',
      corpo: { destinazioneTipo: 'cassa', destinazioneId: stato.cassaId },
    });
    if (esito.html) await stampaDalBrowser(esito.html);
    else messaggio('Questa cassa stampa in rete: la prova è partita dal server', 'ok');
  }));
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
