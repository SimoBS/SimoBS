import { api, euro, el, messaggio, conErrori, evidenziaNav, dataBreve } from './comune.js';

const $ = (id) => document.getElementById(id);
let serataId = null;

/** Costruisce una tabella da un elenco di colonne e righe. */
function tabella(nodo, colonne, righe, vuoto = 'Nessun dato') {
  if (righe.length === 0) {
    nodo.replaceChildren(el('tbody', {}, [
      el('tr', {}, [el('td', { classe: 'dettaglio', testo: vuoto })]),
    ]));
    return;
  }
  nodo.replaceChildren(
    el('thead', {}, [
      el('tr', {}, colonne.map((c) => el('th', { classe: c.num ? 'num' : '', testo: c.titolo }))),
    ]),
    el('tbody', {}, righe.map((r) =>
      el('tr', {}, colonne.map((c) => {
        const valore = c.valore(r);
        return el('td', { classe: c.num ? 'num' : '' },
          [valore instanceof Node ? valore : String(valore)]);
      })))),
  );
}

function riquadro(etichetta, valore, ambra = false) {
  return el('div', { classe: 'riquadro' }, [
    el('div', { classe: 'etichetta', testo: etichetta }),
    el('div', { classe: `valore ${ambra ? 'ambra' : ''}`, testo: valore }),
  ]);
}

async function caricaSerate() {
  const serate = await api('/api/serate');
  const scelta = $('scelta-serata');
  scelta.replaceChildren(...serate.map((s) =>
    el('option', { value: s.id, testo: `${s.nome} — ${dataBreve(s.data)}${s.aperta ? ' (aperta)' : ''}` })));
  if (serate.length === 0) return null;
  serataId = Number(scelta.value);
  return serataId;
}

async function caricaCasse() {
  const { casse } = await api('/api/anagrafica');
  $('cassa-chiusura').replaceChildren(...casse.map((c) =>
    el('option', { value: c.id, testo: c.nome + (c.stampante_host ? '' : ' — senza stampante') })));
}

async function carica() {
  if (!serataId) return;
  const d = await api(`/api/report?serataId=${serataId}`);
  const r = d.riepilogo;

  $('riquadri').replaceChildren(
    riquadro('Incasso', `€ ${euro(r.incasso_cent)}`, true),
    riquadro('Ordini', String(r.ordini)),
    riquadro('Scontrino medio', `€ ${euro(r.scontrino_medio_cent)}`),
    riquadro('Pezzi venduti', String(r.pezzi)),
    riquadro('Coperti', String(r.coperti)),
    riquadro('Sconti', `€ ${euro(r.sconti_cent)}`),
    riquadro('Storni', `${r.storni.ordini} (€ ${euro(r.storni.valore_cent)})`),
  );

  // Andamento orario: barre proporzionali disegnate con un div, senza librerie.
  const massimo = Math.max(1, ...d.perOra.map((o) => o.incasso_cent));
  tabella($('tabella-ore'), [
    { titolo: 'Ora', valore: (o) => `${o.ora}:00` },
    { titolo: 'Ordini', num: true, valore: (o) => o.ordini },
    { titolo: 'Incasso', num: true, valore: (o) => `€ ${euro(o.incasso_cent)}` },
    {
      titolo: '',
      valore: (o) => el('div', { classe: 'barra-grafico' }, [
        el('i', { stile: { width: `${(o.incasso_cent / massimo) * 100}%` } }),
      ]),
    },
  ], d.perOra, 'Nessun ordine in questa serata');

  tabella($('tabella-casse'), [
    { titolo: 'Cassa', valore: (c) => c.nome },
    { titolo: 'Ordini', num: true, valore: (c) => c.ordini },
    { titolo: 'Incasso', num: true, valore: (c) => `€ ${euro(c.incasso_cent)}` },
  ], d.perCassa);

  tabella($('tabella-pagamenti'), [
    { titolo: 'Pagamento', valore: (p) => p.pagamento },
    { titolo: 'Ordini', num: true, valore: (p) => p.ordini },
    { titolo: 'Incasso', num: true, valore: (p) => `€ ${euro(p.incasso_cent)}` },
  ], r.perPagamento);

  const NOMI_SERVIZIO = { tavolo: 'Al tavolo', self: 'Self service', asporto: 'Asporto' };
  tabella($('tabella-servizio'), [
    { titolo: 'Modalità', valore: (s) => NOMI_SERVIZIO[s.servizio] ?? s.servizio },
    { titolo: 'Ordini', num: true, valore: (s) => s.ordini },
    { titolo: 'Coperti', num: true, valore: (s) => s.coperti },
    { titolo: 'Incasso', num: true, valore: (s) => `€ ${euro(s.incasso_cent)}` },
  ], d.perServizio ?? []);

  tabella($('tabella-tempi'), [
    { titolo: 'Reparto', valore: (t) => t.reparto },
    { titolo: 'Vassoi usciti', num: true, valore: (t) => t.ordini },
    { titolo: 'Attesa media', num: true, valore: (t) => `${t.attesa_media_min} min` },
    { titolo: 'Lavorazione media', num: true, valore: (t) => `${t.lavorazione_media_min} min` },
  ], d.tempiReparto ?? [],
  'Nessun vassoio ancora uscito: i tempi compaiono quando i reparti sparano il codice a barre');

  tabella($('tabella-reparti'), [
    { titolo: 'Reparto', valore: (x) => x.nome },
    { titolo: 'Pezzi', num: true, valore: (x) => x.pezzi },
    { titolo: 'Venduto', num: true, valore: (x) => `€ ${euro(x.lordo_cent)}` },
  ], d.perReparto);

  tabella($('tabella-prodotti'), [
    { titolo: 'Prodotto', valore: (x) => x.nome },
    { titolo: 'Categoria', valore: (x) => x.categoria ?? '' },
    { titolo: 'Reparto', valore: (x) => x.reparto },
    { titolo: 'Pezzi', num: true, valore: (x) => x.pezzi },
    { titolo: 'Venduto', num: true, valore: (x) => `€ ${euro(x.lordo_cent)}` },
  ], d.perProdotto);

  tabella($('tabella-consumo'), [
    { titolo: 'Articolo', valore: (x) => x.articolo },
    { titolo: 'Consumato', num: true, valore: (x) => `${x.consumato} ${x.unita}` },
  ], d.consumo, 'Nessun consumo registrato: i prodotti non hanno una distinta base');

  const conf = await api('/api/report/confronto');
  tabella($('tabella-confronto'), [
    { titolo: 'Serata', valore: (s) => s.nome },
    { titolo: 'Data', valore: (s) => dataBreve(s.data) },
    { titolo: 'Edizione', valore: (s) => s.edizione },
    { titolo: 'Ordini', num: true, valore: (s) => s.ordini },
    { titolo: 'Coperti', num: true, valore: (s) => s.coperti },
    { titolo: 'Incasso', num: true, valore: (s) => `€ ${euro(s.incasso_cent)}` },
  ], conf.serate);

  tabella($('tabella-edizioni'), [
    { titolo: 'Edizione', valore: (e) => e.edizione },
    { titolo: 'Serate', num: true, valore: (e) => e.serate },
    { titolo: 'Ordini', num: true, valore: (e) => e.ordini },
    { titolo: 'Incasso', num: true, valore: (e) => `€ ${euro(e.incasso_cent)}` },
  ], conf.edizioni, 'Assegna un\'edizione alle serate per confrontare gli anni');
}

async function avvia() {
  evidenziaNav();
  $('scelta-serata').addEventListener('change', conErrori(async (e) => {
    serataId = Number(e.target.value);
    await carica();
  }));

  $('scarica-csv').addEventListener('click', () => {
    location.href = `/api/report/csv?serataId=${serataId}`;
  });

  $('anteprima-chiusura').addEventListener('click', conErrori(async () => {
    const { testo } = await api(`/api/report/chiusura/anteprima?serataId=${serataId}`);
    $('testo-anteprima').textContent = testo;
    $('scheda-anteprima').style.display = 'block';
    $('scheda-anteprima').scrollIntoView({ behavior: 'smooth' });
  }));

  $('stampa-chiusura').addEventListener('click', conErrori(async () => {
    await api(`/api/report/chiusura/stampa?serataId=${serataId}`, {
      method: 'POST',
      corpo: { cassaId: Number($('cassa-chiusura').value) },
    });
    messaggio('Chiusura messa in coda di stampa', 'ok');
  }));

  try {
    await caricaCasse();
    if (await caricaSerate()) await carica();
    else messaggio('Nessuna serata registrata: aprine una da Gestione.');
  } catch (err) {
    messaggio(err.message, 'errore');
  }
}

avvia();
