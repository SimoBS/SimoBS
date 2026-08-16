import { db, backup } from './db.js';
import { config, salvaConfig } from './config.js';
import * as anagrafica from './anagrafica.js';
import * as magazzino from './magazzino.js';
import * as report from './report.js';
import * as avanzamento from './avanzamento.js';
import {
  creaOrdine, annullaOrdine, dettaglioOrdine, ultimiOrdini,
  scontrinoHtmlPerOrdine, ErroreOrdine,
} from './ordini.js';
import {
  accoda, statoCoda, ristampa, ristampaOrdine, documentoDiProva, euro,
} from './stampa.js';
import { versoTesto, versoHtml } from './escpos.js';

export class ErroreRichiesta extends Error {
  constructor(messaggio, stato = 400) {
    super(messaggio);
    this.stato = stato;
  }
}

const rotte = [];
const rotta = (metodo, schema, gestore) => rotte.push({ metodo, schema, gestore });

/** Confronta un percorso con uno schema tipo "/api/ordini/:id/annulla". */
function combacia(schema, percorso) {
  const a = schema.split('/');
  const b = percorso.split('/');
  if (a.length !== b.length) return null;
  const parametri = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) parametri[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return parametri;
}

export function trovaRotta(metodo, percorso) {
  for (const r of rotte) {
    if (r.metodo !== metodo) continue;
    const parametri = combacia(r.schema, percorso);
    if (parametri) return { gestore: r.gestore, parametri };
  }
  return null;
}

const intero = (v, predefinito = null) => {
  if (v === undefined || v === null || v === '') return predefinito;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ErroreRichiesta(`valore numerico non valido: ${v}`);
  return Math.trunc(n);
};

function serataRichiesta(query, parametri) {
  const id = intero(parametri?.serataId ?? query.get('serataId'));
  if (id) return id;
  const aperta = anagrafica.serataAperta();
  if (!aperta) throw new ErroreRichiesta('nessuna serata aperta e nessuna serata indicata');
  return aperta.id;
}

// ---------------------------------------------------------------------------
// Presenza delle postazioni
//
// Con quattro PC identici e volontari che si danno il cambio, capita che due
// postazioni scelgano la stessa cassa nel menu a tendina. Gli scontrini
// escono comunque giusti, perché li stampa il PC che ha venduto, ma incassi e
// chiusura di quella cassa finiscono mescolati e te ne accorgi a mezzanotte
// contando i cassetti.
//
// Ogni cassa si annuncia a ogni giro di aggiornamento con un identificativo
// del proprio browser: se per la stessa cassa se ne presentano due, tutte e
// due vedono l'avviso. È volutamente in memoria e non su disco: è uno stato
// del momento, un riavvio del server lo ricostruisce in cinque secondi.
// ---------------------------------------------------------------------------

const FINESTRA_PRESENZA_MS = 30_000;
const presenze = new Map();

function registraPresenza(cassaId, postazione) {
  if (!cassaId || !postazione) return [];
  const limite = Date.now() - FINESTRA_PRESENZA_MS;
  if (!presenze.has(cassaId)) presenze.set(cassaId, new Map());
  const perCassa = presenze.get(cassaId);
  perCassa.set(postazione, Date.now());
  for (const [chiave, visto] of perCassa) if (visto < limite) perCassa.delete(chiave);
  return [...perCassa.keys()];
}

rotta('GET', '/api/stato', (ctx) => {
  const cassaId = intero(ctx.query.get('cassaId'));
  const attive = registraPresenza(cassaId, ctx.query.get('postazione'));
  return {
    festa: config.nomeFesta,
    serata: anagrafica.serataAperta() ?? null,
    casse: anagrafica.listaCasse().filter((c) => c.attiva),
    coda: statoCoda(),
    allarmiScorte: magazzino.allarmiScorte(),
    // Più di una postazione sulla stessa cassa: da segnalare subito.
    postazioniSullaStessaCassa: attive.length,
  };
});

rotta('GET', '/api/menu', () => anagrafica.menuCassa());

// ---------------------------------------------------------------------------
// Serate
// ---------------------------------------------------------------------------

rotta('GET', '/api/serate', () => anagrafica.listaSerate());

rotta('POST', '/api/serate', (ctx) => {
  const { nome, data, edizione } = ctx.corpo;
  if (!nome || !data) throw new ErroreRichiesta('nome e data sono obbligatori');
  return anagrafica.apriSerata({ nome, data, edizione: edizione ?? '' });
});

rotta('POST', '/api/serate/:id/chiudi', (ctx) => anagrafica.chiudiSerata(intero(ctx.parametri.id)));

// ---------------------------------------------------------------------------
// Ordini
// ---------------------------------------------------------------------------

rotta('POST', '/api/ordini', (ctx) => creaOrdine(ctx.corpo));

rotta('GET', '/api/ordini', (ctx) => ultimiOrdini({
  serataId: serataRichiesta(ctx.query),
  limite: intero(ctx.query.get('limite'), 40),
}));

rotta('GET', '/api/ordini/:id', (ctx) => {
  const o = dettaglioOrdine(intero(ctx.parametri.id));
  if (!o) throw new ErroreRichiesta('ordine inesistente', 404);
  return o;
});

rotta('POST', '/api/ordini/:id/annulla', (ctx) => annullaOrdine(intero(ctx.parametri.id), ctx.corpo.motivo ?? ''));

rotta('POST', '/api/ordini/:id/ristampa', (ctx) => ({
  documenti: ristampaOrdine(intero(ctx.parametri.id)),
}));

/**
 * Scontrino da stampare dal browser della cassa (stampante attaccata al PC).
 * Vuoto se quella cassa non è in modalità locale: il client non deve sapere
 * come è configurata, gli basta vedere se arriva qualcosa da stampare.
 */
rotta('GET', '/api/ordini/:id/scontrino', (ctx) => ({
  html: scontrinoHtmlPerOrdine(intero(ctx.parametri.id)),
}));

// ---------------------------------------------------------------------------
// Postazioni di reparto (PC con la pistola per il codice a barre)
// ---------------------------------------------------------------------------

rotta('GET', '/api/reparto/:id/coda', (ctx) =>
  avanzamento.codaReparto(intero(ctx.parametri.id)));

/** Quello che ha sparato la pistola: un codice a barre letto come testo. */
rotta('POST', '/api/reparto/:id/scansione', (ctx) => avanzamento.scansiona({
  codice: ctx.corpo.codice,
  repartoId: intero(ctx.parametri.id),
  operatore: ctx.corpo.operatore ?? '',
}));

/** Stesso effetto della pistola, per quando il codice è illeggibile. */
rotta('POST', '/api/reparto/:id/avanza', (ctx) => avanzamento.avanza({
  ordineId: intero(ctx.corpo.ordineId),
  repartoId: intero(ctx.parametri.id),
  operatore: ctx.corpo.operatore ?? '',
}));

rotta('POST', '/api/reparto/:id/indietro', (ctx) => avanzamento.indietro({
  ordineId: intero(ctx.corpo.ordineId),
  repartoId: intero(ctx.parametri.id),
}));

/** Lavagna di produzione per il monitor appeso al reparto. */
rotta('GET', '/api/reparto/:id/monitor', (ctx) => {
  const repartoId = intero(ctx.parametri.id);
  const reparto = db.prepare('SELECT nome FROM reparti WHERE id = ?').get(repartoId);
  if (!reparto) throw new ErroreRichiesta('reparto inesistente', 404);
  return {
    reparto: reparto.nome,
    daProdurre: avanzamento.daProdurre(repartoId),
    riepilogo: avanzamento.riepilogoMonitor(repartoId),
  };
});

/** Numeri pronti al ritiro, per il monitor rivolto al pubblico. */
rotta('GET', '/api/chiamate', () => ({
  festa: config.nomeFesta,
  ordini: avanzamento.ordiniCompleti({ limite: 20 }),
}));

// ---------------------------------------------------------------------------
// Anagrafica
// ---------------------------------------------------------------------------

rotta('GET', '/api/anagrafica', () => ({
  casse: anagrafica.listaCasse(),
  reparti: anagrafica.listaReparti(),
  categorie: anagrafica.listaCategorie(),
  prodotti: anagrafica.listaProdotti(),
  articoli: magazzino.listaArticoli(),
}));

rotta('POST', '/api/casse', (ctx) => anagrafica.salvaCassa(ctx.corpo));
rotta('POST', '/api/reparti', (ctx) => anagrafica.salvaReparto(ctx.corpo));
rotta('POST', '/api/categorie', (ctx) => anagrafica.salvaCategoria(ctx.corpo));
rotta('POST', '/api/prodotti', (ctx) => anagrafica.salvaProdotto(ctx.corpo));
rotta('POST', '/api/articoli', (ctx) => anagrafica.salvaArticolo(ctx.corpo));
rotta('DELETE', '/api/prodotti/:id', (ctx) => anagrafica.eliminaProdotto(intero(ctx.parametri.id)));

rotta('GET', '/api/prodotti/:id/distinta', (ctx) => anagrafica.distintaProdotto(intero(ctx.parametri.id)));
rotta('POST', '/api/prodotti/:id/distinta', (ctx) =>
  anagrafica.impostaDistinta(intero(ctx.parametri.id), ctx.corpo.voci ?? []));

// ---------------------------------------------------------------------------
// Magazzino
// ---------------------------------------------------------------------------

rotta('GET', '/api/magazzino', () => magazzino.listaArticoli());

rotta('POST', '/api/magazzino/carico', (ctx) => magazzino.carica({
  articoloId: intero(ctx.corpo.articoloId),
  quantita: Number(ctx.corpo.quantita),
  nota: ctx.corpo.nota ?? '',
}));

rotta('POST', '/api/magazzino/rettifica', (ctx) => magazzino.rettifica({
  articoloId: intero(ctx.corpo.articoloId),
  giacenzaReale: Number(ctx.corpo.giacenzaReale),
  nota: ctx.corpo.nota ?? '',
}));

rotta('GET', '/api/magazzino/movimenti', (ctx) => magazzino.movimenti({
  articoloId: intero(ctx.query.get('articoloId')),
  limite: intero(ctx.query.get('limite'), 200),
}));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

rotta('GET', '/api/report', (ctx) => {
  const r = report.reportCompleto(serataRichiesta(ctx.query));
  if (!r) throw new ErroreRichiesta('serata inesistente', 404);
  return r;
});

rotta('GET', '/api/report/confronto', () => ({
  serate: report.confrontoSerate(),
  edizioni: report.confrontoEdizioni(),
}));

rotta('GET', '/api/report/chiusura-cassa', (ctx) => report.chiusuraCassa(
  serataRichiesta(ctx.query),
  intero(ctx.query.get('cassaId')),
));

rotta('GET', '/api/report/chiusura/anteprima', (ctx) => ({
  testo: versoTesto(report.documentoChiusura(serataRichiesta(ctx.query))),
}));

rotta('POST', '/api/report/chiusura/stampa', (ctx) => {
  const serataId = serataRichiesta(ctx.query);
  const destinazioneId = intero(ctx.corpo.cassaId);
  if (!destinazioneId) throw new ErroreRichiesta('indica su quale cassa stampare la chiusura');
  const id = accoda({
    destinazioneTipo: 'cassa',
    destinazioneId,
    tipo: 'chiusura',
    descrizione: `Chiusura serata ${serataId}`,
    documento: report.documentoChiusura(serataId),
  });
  return { stampaId: id };
});

/** Esportazione CSV del venduto, per chi vuole finire il lavoro in un foglio. */
rotta('GET', '/api/report/csv', (ctx) => {
  const serataId = serataRichiesta(ctx.query);
  const righe = report.vendutoPerProdotto(serataId);
  const csv = [
    'prodotto;categoria;reparto;pezzi;lordo_euro',
    ...righe.map((r) => [
      r.nome, r.categoria ?? '', r.reparto, r.pezzi, euro(r.lordo_cent),
    ].join(';')),
  ].join('\r\n');
  return {
    _grezzo: true,
    tipoContenuto: 'text/csv; charset=utf-8',
    intestazioni: { 'Content-Disposition': `attachment; filename="venduto-serata-${serataId}.csv"` },
    // BOM: senza, Excel in italiano sbaglia gli accenti.
    corpo: '﻿' + csv,
  };
});

// ---------------------------------------------------------------------------
// Stampa
// ---------------------------------------------------------------------------

rotta('GET', '/api/stampe', () => statoCoda());

rotta('GET', '/api/stampe/:id/anteprima', (ctx) => {
  const s = db.prepare('SELECT anteprima, descrizione FROM stampe WHERE id = ?').get(intero(ctx.parametri.id));
  if (!s) throw new ErroreRichiesta('stampa inesistente', 404);
  return s;
});

rotta('POST', '/api/stampe/:id/ristampa', (ctx) => ({ ok: ristampa(intero(ctx.parametri.id)) }));

rotta('POST', '/api/stampe/prova', (ctx) => {
  const tipo = ctx.corpo.destinazioneTipo === 'cassa' ? 'cassa' : 'reparto';
  const id = intero(ctx.corpo.destinazioneId);
  const dest = tipo === 'cassa'
    ? db.prepare('SELECT nome, modo_stampa FROM casse WHERE id = ?').get(id)
    : db.prepare('SELECT nome FROM reparti WHERE id = ?').get(id);
  if (!dest) throw new ErroreRichiesta('destinazione inesistente', 404);

  const documento = documentoDiProva(dest.nome);

  // Una cassa con la stampante attaccata al proprio PC non è raggiungibile dal
  // server: la prova torna come HTML e deve stamparla il browser di quel PC.
  if (tipo === 'cassa' && dest.modo_stampa === 'locale') {
    return {
      modo: 'locale',
      html: versoHtml(documento, { larghezzaMm: config.larghezzaCartaMm, titolo: `Prova ${dest.nome}` }),
    };
  }

  const stampaId = accoda({
    destinazioneTipo: tipo,
    destinazioneId: id,
    tipo: 'prova',
    descrizione: `Prova ${dest.nome}`,
    documento,
  });
  return { modo: 'rete', stampaId };
});

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

rotta('GET', '/api/config', () => config);
rotta('POST', '/api/config', (ctx) => salvaConfig(ctx.corpo));
rotta('POST', '/api/backup', () => backup());

export { ErroreOrdine };
export const { ErroreScansione } = avanzamento;
