import { api, euro, inCentesimi, el, messaggio, conErrori, evidenziaNav, dataBreve } from './comune.js';

const $ = (id) => document.getElementById(id);

let anagrafica = { casse: [], reparti: [], categorie: [], prodotti: [], articoli: [] };
let prodottoInModifica = null;
let distintaInModifica = [];

function tabella(nodo, colonne, righe, vuoto = 'Niente da mostrare') {
  if (righe.length === 0) {
    nodo.replaceChildren(el('tbody', {}, [el('tr', {}, [el('td', { testo: vuoto })])]));
    return;
  }
  nodo.replaceChildren(
    el('thead', {}, [el('tr', {}, colonne.map((c) => el('th', { classe: c.num ? 'num' : '', testo: c.titolo })))]),
    el('tbody', {}, righe.map((r) =>
      el('tr', {}, colonne.map((c) => {
        const v = c.valore(r);
        return el('td', { classe: c.num ? 'num' : '' }, [v instanceof Node ? v : String(v ?? '')]);
      })))),
  );
}

/** Campo che salva da solo quando perde il fuoco: niente bottoni "salva" ovunque. */
function campoLive(valore, onSalva, opzioni = {}) {
  return el('input', {
    value: valore ?? '',
    size: opzioni.size ?? 12,
    placeholder: opzioni.placeholder ?? '',
    onchange: conErrori(async (e) => {
      await onSalva(e.target.value);
      messaggio('Salvato', 'ok');
      await caricaTutto();
    }),
  });
}

// ---------------------------------------------------------------------------
// Serata
// ---------------------------------------------------------------------------

async function disegnaSerata() {
  const stato = await api('/api/stato');
  const nodo = $('serata-corrente');
  if (stato.serata) {
    nodo.replaceChildren(el('div', { classe: 'avviso' }, [
      el('strong', { testo: `Serata aperta: ${stato.serata.nome}` }),
      ` — ${dataBreve(stato.serata.data)}${stato.serata.edizione ? `, edizione ${stato.serata.edizione}` : ''}. `,
      el('button', {
        classe: 'bottone-rosso',
        testo: 'Chiudi serata',
        stile: { marginLeft: '10px' },
        onclick: conErrori(async () => {
          if (!confirm('Chiudere la serata? Non si potrà più incassare finché non ne apri un\'altra.')) return;
          await api(`/api/serate/${stato.serata.id}/chiudi`, { method: 'POST', corpo: {} });
          messaggio('Serata chiusa', 'ok');
          await caricaTutto();
        }),
      }),
    ]));
  } else {
    nodo.replaceChildren(el('div', { classe: 'avviso grave', testo: 'Nessuna serata aperta: le casse non possono incassare.' }));
  }

  const avvisi = $('avvisi');
  avvisi.replaceChildren(...stato.allarmiScorte.map((a) =>
    el('div', {
      classe: `avviso ${a.stato === 'esaurito' ? 'grave' : ''}`,
      testo: a.stato === 'esaurito'
        ? `${a.nome}: scorta esaurita (${a.giacenza} ${a.unita})`
        : `${a.nome}: ne restano ${a.giacenza} ${a.unita}, sotto la soglia di ${a.soglia_minima}`,
    })));
}

// ---------------------------------------------------------------------------
// Stampanti e coda
// ---------------------------------------------------------------------------

function bottoneProva(tipo, id) {
  return el('button', {
    testo: 'Prova',
    onclick: conErrori(async () => {
      await api('/api/stampe/prova', { method: 'POST', corpo: { destinazioneTipo: tipo, destinazioneId: id } });
      messaggio('Stampa di prova messa in coda', 'ok');
      setTimeout(disegnaCoda, 1500);
    }),
  });
}

function disegnaStampanti() {
  tabella($('tabella-reparti'), [
    { titolo: 'Reparto', valore: (r) => r.nome },
    { titolo: 'Indirizzo IP', valore: (r) => campoLive(r.stampante_host, (v) =>
      api('/api/reparti', { method: 'POST', corpo: { id: r.id, stampante_host: v.trim() || null } }),
    { placeholder: '192.168.1.50', size: 15 }) },
    { titolo: 'Porta', valore: (r) => campoLive(r.stampante_porta, (v) =>
      api('/api/reparti', { method: 'POST', corpo: { id: r.id, stampante_porta: Number(v) || 9100 } }), { size: 5 }) },
    { titolo: 'Copie', valore: (r) => campoLive(r.copie, (v) =>
      api('/api/reparti', { method: 'POST', corpo: { id: r.id, copie: Math.max(1, Number(v) || 1) } }), { size: 3 }) },
    { titolo: '', valore: (r) => bottoneProva('reparto', r.id) },
  ], anagrafica.reparti);

  const MODI = [
    ['locale', 'attaccata a questo PC'],
    ['rete', 'stampante di rete'],
    ['nessuna', 'nessuno scontrino'],
  ];

  tabella($('tabella-casse'), [
    { titolo: 'Cassa', valore: (c) => c.nome },
    { titolo: 'Scontrino cliente', valore: (c) => el('select', {
      onchange: conErrori(async (e) => {
        await api('/api/casse', { method: 'POST', corpo: { id: c.id, modo_stampa: e.target.value } });
        messaggio('Salvato', 'ok');
        await caricaTutto();
      }),
    }, MODI.map(([v, etichetta]) =>
      el('option', { value: v, testo: etichetta, selected: c.modo_stampa === v }))) },
    { titolo: 'Indirizzo IP', valore: (c) => c.modo_stampa === 'rete'
      ? campoLive(c.stampante_host, (v) =>
        api('/api/casse', { method: 'POST', corpo: { id: c.id, stampante_host: v.trim() || null } }),
      { placeholder: '192.168.1.60', size: 15 })
      : el('span', { classe: 'spiega', testo: '—' }) },
    { titolo: '', valore: (c) => c.modo_stampa === 'locale'
      ? el('span', { classe: 'spiega', testo: 'prova dalla pagina Cassa di quel PC' })
      : c.modo_stampa === 'rete' ? bottoneProva('cassa', c.id) : '' },
  ], anagrafica.casse);
}

async function disegnaCoda() {
  const { conteggi, problemi } = await api('/api/stampe');
  $('riquadri-coda').replaceChildren(
    el('div', { classe: 'riquadro' }, [
      el('div', { classe: 'etichetta', testo: 'In attesa' }),
      el('div', { classe: 'valore', testo: String(conteggi.in_attesa) }),
    ]),
    el('div', { classe: 'riquadro' }, [
      el('div', { classe: 'etichetta', testo: 'Stampate' }),
      el('div', { classe: 'valore', testo: String(conteggi.stampata) }),
    ]),
    el('div', { classe: 'riquadro' }, [
      el('div', { classe: 'etichetta', testo: 'Non riuscite' }),
      el('div', { classe: `valore ${conteggi.errore > 0 ? 'ambra' : ''}`, testo: String(conteggi.errore) }),
    ]),
  );

  tabella($('tabella-problemi'), [
    { titolo: 'Documento', valore: (p) => p.descrizione },
    { titolo: 'Tentativi', num: true, valore: (p) => p.tentativi },
    { titolo: 'Errore', valore: (p) => p.ultimo_errore },
    { titolo: '', valore: (p) => el('button', {
      testo: 'Riprova',
      onclick: conErrori(async () => {
        await api(`/api/stampe/${p.id}/ristampa`, { method: 'POST', corpo: {} });
        messaggio('Rimessa in coda', 'ok');
        setTimeout(disegnaCoda, 1500);
      }),
    }) },
  ], problemi, 'Nessun problema di stampa');
}

// ---------------------------------------------------------------------------
// Ordini
// ---------------------------------------------------------------------------

async function disegnaOrdini() {
  let ordini = [];
  try {
    ordini = await api('/api/ordini?limite=25');
  } catch {
    // Nessuna serata aperta: normale a festa finita, non è un errore da urlare.
  }
  tabella($('tabella-ordini'), [
    { titolo: 'N.', num: true, valore: (o) => o.numero },
    { titolo: 'Ora', valore: (o) => o.ts.slice(11, 16) },
    { titolo: 'Cassa', valore: (o) => o.cassa },
    { titolo: 'Operatore', valore: (o) => o.operatore },
    { titolo: 'Pagamento', valore: (o) => o.pagamento },
    { titolo: 'Totale', num: true, valore: (o) => `€ ${euro(o.totale_cent)}` },
    { titolo: 'Stato', valore: (o) => o.annullato
      ? el('span', { classe: 'pillola esaurito', testo: 'annullato' })
      : el('span', { classe: 'pillola ok', testo: 'valido' }) },
    { titolo: '', valore: (o) => el('div', { stile: { display: 'flex', gap: '6px' } }, [
      el('button', {
        testo: 'Ristampa',
        onclick: conErrori(async () => {
          const r = await api(`/api/ordini/${o.id}/ristampa`, { method: 'POST', corpo: {} });
          messaggio(`${r.documenti} document${r.documenti === 1 ? 'o' : 'i'} rimess${r.documenti === 1 ? 'o' : 'i'} in coda`, 'ok');
        }),
      }),
      !o.annullato && el('button', {
        classe: 'bottone-rosso',
        testo: 'Storna',
        onclick: conErrori(async () => {
          const motivo = prompt(`Storno della comanda n. ${o.numero}. Motivo:`);
          if (motivo === null) return;
          await api(`/api/ordini/${o.id}/annulla`, { method: 'POST', corpo: { motivo } });
          messaggio('Ordine stornato, magazzino ricaricato', 'ok');
          await caricaTutto();
        }),
      }),
    ]) },
  ], ordini, 'Nessun ordine in questa serata');
}

// ---------------------------------------------------------------------------
// Magazzino
// ---------------------------------------------------------------------------

function disegnaMagazzino() {
  tabella($('tabella-magazzino'), [
    { titolo: 'Articolo', valore: (a) => a.nome },
    { titolo: 'Giacenza', num: true, valore: (a) => `${a.giacenza} ${a.unita}` },
    { titolo: 'Soglia', num: true, valore: (a) => campoLive(a.soglia_minima, (v) =>
      api('/api/articoli', { method: 'POST', corpo: { id: a.id, soglia_minima: Number(v.replace(',', '.')) || 0 } }), { size: 5 }) },
    { titolo: 'Stato', valore: (a) => el('span', { classe: `pillola ${a.stato}`, testo: a.stato }) },
    { titolo: '', valore: (a) => {
      const campo = el('input', { size: 6, placeholder: '0', inputmode: 'decimal' });
      const leggi = () => {
        const n = Number(campo.value.replace(',', '.'));
        if (!Number.isFinite(n)) throw new Error('quantità non valida');
        return n;
      };
      return el('div', { stile: { display: 'flex', gap: '6px' } }, [
        campo,
        el('button', {
          testo: 'Carico',
          onclick: conErrori(async () => {
            await api('/api/magazzino/carico', { method: 'POST', corpo: { articoloId: a.id, quantita: leggi() } });
            messaggio(`Caricati ${leggi()} ${a.unita} di ${a.nome}`, 'ok');
            await caricaTutto();
          }),
        }),
        el('button', {
          testo: 'Inventario',
          title: 'Imposta la giacenza alla quantità che hai contato',
          onclick: conErrori(async () => {
            await api('/api/magazzino/rettifica', { method: 'POST', corpo: { articoloId: a.id, giacenzaReale: leggi() } });
            messaggio(`${a.nome} portato a ${leggi()} ${a.unita}`, 'ok');
            await caricaTutto();
          }),
        }),
      ]);
    } },
  ], anagrafica.articoli);
}

// ---------------------------------------------------------------------------
// Prodotti e distinta base
// ---------------------------------------------------------------------------

function disegnaProdotti() {
  tabella($('tabella-prodotti'), [
    { titolo: 'Prodotto', valore: (p) => p.nome },
    { titolo: 'Comanda', valore: (p) => p.nome_comanda ?? '' },
    { titolo: 'Categoria', valore: (p) => p.categoria },
    { titolo: 'Reparto', valore: (p) => p.reparto },
    { titolo: 'Prezzo', num: true, valore: (p) => `€ ${euro(p.prezzo_cent)}` },
    { titolo: 'Stato', valore: (p) => p.attivo
      ? el('span', { classe: 'pillola ok', testo: 'in vendita' })
      : el('span', { classe: 'pillola basso', testo: 'nascosto' }) },
    { titolo: '', valore: (p) => el('button', { testo: 'Modifica', onclick: () => caricaNelModulo(p) }) },
  ], anagrafica.prodotti);
}

async function caricaNelModulo(p) {
  prodottoInModifica = p?.id ?? null;
  $('titolo-form').textContent = p ? `Modifica: ${p.nome}` : 'Nuovo prodotto';
  $('p-nome').value = p?.nome ?? '';
  $('p-comanda').value = p?.nome_comanda ?? '';
  $('p-categoria').value = p?.categoria_id ?? anagrafica.categorie[0]?.id ?? '';
  $('p-reparto').value = p?.reparto_id ?? anagrafica.reparti[0]?.id ?? '';
  $('p-prezzo').value = p ? euro(p.prezzo_cent) : '0,00';
  $('p-ordine').value = p?.ordine ?? 0;
  $('p-attivo').value = String(p?.attivo ?? 1);
  distintaInModifica = p ? await api(`/api/prodotti/${p.id}/distinta`) : [];
  disegnaDistinta();
  $('elimina-prodotto').style.display = p ? '' : 'none';
  $('titolo-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function disegnaDistinta() {
  const nodo = $('editor-distinta');
  if (!prodottoInModifica) {
    nodo.replaceChildren(el('p', { classe: 'spiega', testo: 'Salva il prodotto per poterne impostare la distinta base.' }));
    return;
  }
  const perArticolo = new Map(distintaInModifica.map((d) => [d.articolo_id, d.quantita]));
  nodo.replaceChildren(
    el('h3', { stile: { fontSize: '0.95rem' }, testo: 'Distinta base: cosa consuma un pezzo venduto' }),
    el('div', { classe: 'griglia-campi' }, anagrafica.articoli.map((a) =>
      el('div', { classe: 'campo' }, [
        el('label', { testo: `${a.nome} (${a.unita})` }),
        el('input', {
          value: perArticolo.get(a.id) ?? '',
          placeholder: '0',
          inputmode: 'decimal',
          'data-articolo': a.id,
        }),
      ]))),
    el('button', {
      stile: { marginTop: '10px' },
      testo: 'Salva distinta base',
      onclick: conErrori(async () => {
        const voci = [...nodo.querySelectorAll('[data-articolo]')]
          .map((i) => ({ articolo_id: Number(i.dataset.articolo), quantita: Number(String(i.value).replace(',', '.')) }))
          .filter((v) => Number.isFinite(v.quantita) && v.quantita > 0);
        distintaInModifica = await api(`/api/prodotti/${prodottoInModifica}/distinta`, { method: 'POST', corpo: { voci } });
        messaggio('Distinta base salvata', 'ok');
        disegnaDistinta();
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Categorie / reparti / casse
// ---------------------------------------------------------------------------

function disegnaCategorieEReparti() {
  tabella($('tabella-categorie'), [
    { titolo: 'Categoria', valore: (c) => campoLive(c.nome, (v) =>
      api('/api/categorie', { method: 'POST', corpo: { id: c.id, nome: v } })) },
    { titolo: 'Colore', valore: (c) => el('input', {
      type: 'color',
      value: c.colore,
      onchange: conErrori(async (e) => {
        await api('/api/categorie', { method: 'POST', corpo: { id: c.id, colore: e.target.value } });
        await caricaTutto();
      }),
    }) },
    { titolo: 'Posizione', num: true, valore: (c) => campoLive(c.ordine, (v) =>
      api('/api/categorie', { method: 'POST', corpo: { id: c.id, ordine: Number(v) || 0 } }), { size: 4 }) },
  ], anagrafica.categorie);

  tabella($('tabella-elenco-reparti'), [
    { titolo: 'Reparto', valore: (r) => campoLive(r.nome, (v) =>
      api('/api/reparti', { method: 'POST', corpo: { id: r.id, nome: v } })) },
    { titolo: 'Posizione', num: true, valore: (r) => campoLive(r.ordine, (v) =>
      api('/api/reparti', { method: 'POST', corpo: { id: r.id, ordine: Number(v) || 0 } }), { size: 4 }) },
  ], anagrafica.reparti);
}

function riempiSelect(id, elenco) {
  const precedente = $(id).value;
  $(id).replaceChildren(...elenco.map((x) => el('option', { value: x.id, testo: x.nome })));
  if (precedente) $(id).value = precedente;
}

// ---------------------------------------------------------------------------
// Caricamento
// ---------------------------------------------------------------------------

async function caricaTutto() {
  anagrafica = await api('/api/anagrafica');
  riempiSelect('p-categoria', anagrafica.categorie);
  riempiSelect('p-reparto', anagrafica.reparti);
  disegnaStampanti();
  disegnaMagazzino();
  disegnaProdotti();
  disegnaCategorieEReparti();
  await disegnaSerata();
  await disegnaOrdini();
  await disegnaCoda();
}

async function caricaConfig() {
  const c = await api('/api/config');
  $('c-nome').value = c.nomeFesta;
  $('c-porta').value = c.porta;
  $('c-colonne').value = c.colonneStampante;
  $('c-mm').value = c.larghezzaCartaMm;
  $('c-scontrino').value = c.scontrinoCliente ? '1' : '0';
}

async function avvia() {
  evidenziaNav();
  $('serata-data').value = new Date().toISOString().slice(0, 10);
  $('serata-edizione').value = String(new Date().getFullYear());

  $('apri-serata').addEventListener('click', conErrori(async () => {
    await api('/api/serate', {
      method: 'POST',
      corpo: {
        nome: $('serata-nome').value.trim(),
        data: $('serata-data').value,
        edizione: $('serata-edizione').value.trim(),
      },
    });
    messaggio('Serata aperta', 'ok');
    $('serata-nome').value = '';
    await caricaTutto();
  }));

  $('salva-prodotto').addEventListener('click', conErrori(async () => {
    const dati = {
      id: prodottoInModifica ?? undefined,
      nome: $('p-nome').value.trim(),
      nome_comanda: $('p-comanda').value.trim() || null,
      categoria_id: Number($('p-categoria').value),
      reparto_id: Number($('p-reparto').value),
      prezzo_cent: inCentesimi($('p-prezzo').value),
      ordine: Number($('p-ordine').value) || 0,
      attivo: Number($('p-attivo').value),
    };
    if (!dati.nome) throw new Error('il nome del prodotto è obbligatorio');
    const salvato = await api('/api/prodotti', { method: 'POST', corpo: dati });
    messaggio('Prodotto salvato', 'ok');
    await caricaTutto();
    await caricaNelModulo(anagrafica.prodotti.find((p) => p.id === salvato.id));
  }));

  $('nuovo-prodotto').addEventListener('click', () => caricaNelModulo(null));

  $('elimina-prodotto').addEventListener('click', conErrori(async () => {
    if (!confirm('Eliminare il prodotto?')) return;
    const esito = await api(`/api/prodotti/${prodottoInModifica}`, { method: 'DELETE' });
    messaggio(esito.disattivato
      ? 'Ha già venduto: l\'ho tolto dalla cassa ma resta nei report delle serate passate.'
      : 'Prodotto eliminato', 'ok');
    await caricaTutto();
    await caricaNelModulo(null);
  }));

  $('aggiungi-articolo').addEventListener('click', conErrori(async () => {
    const nome = $('nuovo-articolo').value.trim();
    if (!nome) throw new Error('serve un nome');
    await api('/api/articoli', {
      method: 'POST',
      corpo: {
        nome,
        unita: $('nuova-unita').value.trim() || 'pz',
        soglia_minima: Number($('nuova-soglia').value.replace(',', '.')) || 0,
      },
    });
    $('nuovo-articolo').value = '';
    messaggio('Articolo aggiunto', 'ok');
    await caricaTutto();
  }));

  $('aggiungi-categoria').addEventListener('click', conErrori(async () => {
    const nome = $('nuova-categoria').value.trim();
    if (!nome) throw new Error('serve un nome');
    await api('/api/categorie', { method: 'POST', corpo: { nome, colore: $('nuovo-colore').value } });
    $('nuova-categoria').value = '';
    await caricaTutto();
  }));

  $('aggiungi-reparto').addEventListener('click', conErrori(async () => {
    const nome = $('nuovo-reparto').value.trim();
    if (!nome) throw new Error('serve un nome');
    await api('/api/reparti', { method: 'POST', corpo: { nome } });
    $('nuovo-reparto').value = '';
    await caricaTutto();
  }));

  $('aggiungi-cassa').addEventListener('click', conErrori(async () => {
    const nome = $('nuova-cassa').value.trim();
    if (!nome) throw new Error('serve un nome');
    await api('/api/casse', { method: 'POST', corpo: { nome } });
    $('nuova-cassa').value = '';
    await caricaTutto();
  }));

  $('salva-config').addEventListener('click', conErrori(async () => {
    await api('/api/config', {
      method: 'POST',
      corpo: {
        nomeFesta: $('c-nome').value.trim(),
        porta: Number($('c-porta').value) || 8080,
        colonneStampante: Number($('c-colonne').value) || 48,
        larghezzaCartaMm: Number($('c-mm').value) || 80,
        scontrinoCliente: $('c-scontrino').value === '1',
      },
    });
    messaggio('Impostazioni salvate', 'ok');
  }));

  $('fai-backup').addEventListener('click', conErrori(async () => {
    const esito = await api('/api/backup', { method: 'POST', corpo: {} });
    const kb = Math.max(1, Math.round(esito.dimensione / 1024));
    $('esito-backup').textContent = `Copia creata: ${esito.percorso} (${kb} kB)`;
    messaggio('Copia di sicurezza creata', 'ok');
  }));

  try {
    await caricaConfig();
    await caricaTutto();
    await caricaNelModulo(null);
  } catch (err) {
    messaggio(err.message, 'errore');
  }

  // La coda di stampa si aggiorna da sola: è la cosa che si guarda di più
  // durante la serata.
  setInterval(() => disegnaCoda().catch(() => {}), 5000);
}

avvia();
