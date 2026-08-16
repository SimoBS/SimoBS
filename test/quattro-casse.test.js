import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SIMOBS_DATI = mkdtempSync(join(tmpdir(), 'simobs-casse-'));

/**
 * L'impianto vero: quattro postazioni di cassa, ognuna con la sua termica
 * attaccata in USB, e due sole stampanti di rete (Cucina e Bar).
 */
let db, anagrafica, ordini, stampa, api;
const casse = [];
const reparti = {};
const prodotti = {};

function stampanteFinta() {
  const ricevuti = [];
  const server = net.createServer((s) => {
    const pezzi = [];
    s.on('data', (c) => pezzi.push(c));
    s.on('close', () => ricevuti.push(Buffer.concat(pezzi)));
  });
  return {
    ricevuti,
    ascolta: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    chiudi: () => new Promise((r) => server.close(r)),
  };
}

const cucina = stampanteFinta();
const bar = stampanteFinta();

before(async () => {
  ({ db } = await import('../src/db.js'));
  anagrafica = await import('../src/anagrafica.js');
  ordini = await import('../src/ordini.js');
  stampa = await import('../src/stampa.js');
  api = await import('../src/api.js');

  for (const n of [1, 2, 3, 4]) casse.push(anagrafica.salvaCassa({ nome: `Cassa ${n}`, modo_stampa: 'locale' }).id);

  reparti.cucina = anagrafica.salvaReparto({
    nome: 'Cucina', stampante_host: '127.0.0.1', stampante_porta: await cucina.ascolta(),
  }).id;
  reparti.bar = anagrafica.salvaReparto({
    nome: 'Bar', stampante_host: '127.0.0.1', stampante_porta: await bar.ascolta(),
  }).id;

  const catCibo = anagrafica.salvaCategoria({ nome: 'Cibo' }).id;
  const catBevande = anagrafica.salvaCategoria({ nome: 'Bevande' }).id;
  prodotti.salamella = anagrafica.salvaProdotto({
    nome: 'Salamella', categoria_id: catCibo, reparto_id: reparti.cucina, prezzo_cent: 400,
  }).id;
  prodotti.birra = anagrafica.salvaProdotto({
    nome: 'Media', categoria_id: catBevande, reparto_id: reparti.bar, prezzo_cent: 500,
  }).id;

  anagrafica.apriSerata({ nome: 'Serata piena', data: '2026-08-15', edizione: '2026' });
});

after(async () => {
  await cucina.chiudi();
  await bar.chiudi();
});

/** Manda in stampa tutta la coda, non solo il primo lotto del giro. */
async function svuotaCodaCompletamente() {
  for (let giro = 0; giro < 30; giro++) {
    const restanti = db.prepare(`SELECT COUNT(*) AS n FROM stampe WHERE stato = 'in_attesa'`).get().n;
    if (restanti === 0) return;
    await stampa.giroDiCoda();
  }
  throw new Error('la coda di stampa non si svuota');
}

describe('quattro casse in contemporanea', () => {
  test('quaranta vendite dalle quattro casse mantengono numeri unici e progressivi', () => {
    for (let i = 0; i < 40; i++) {
      ordini.creaOrdine({
        tavolo: '5',
        idemKey: `carico-${i}`,
        cassaId: casse[i % 4],
        righe: [{ prodottoId: prodotti.birra, quantita: 1 }],
      });
    }
    const numeri = db.prepare('SELECT numero FROM ordini ORDER BY numero').all().map((r) => r.numero);
    assert.equal(new Set(numeri).size, numeri.length, 'due ordini hanno lo stesso numero di comanda');
    assert.deepEqual(numeri, numeri.map((_, i) => i + 1), 'la numerazione ha buchi o salti');
  });

  test('ogni cassa risponde del proprio incasso e tutte e quattro compaiono nel report', async () => {
    const report = await import('../src/report.js');
    const serataId = anagrafica.serataAperta().id;
    const perCassa = report.vendutoPerCassa(serataId);
    assert.equal(perCassa.length, 4, 'non tutte le casse compaiono nel report');
    assert.equal(
      perCassa.reduce((t, c) => t + c.incasso_cent, 0),
      report.riepilogoSerata(serataId).incasso_cent,
    );
  });

  test('la somma dei quattro cassetti torna con l\'incasso della serata', async () => {
    // È il conto che si fa davvero a fine serata: quello che ogni chiusura di
    // cassa dichiara deve sommare all'incasso complessivo, altrimenti qualcuno
    // conta soldi che il report non vede.
    const report = await import('../src/report.js');
    const serataId = anagrafica.serataAperta().id;
    const somma = casse.reduce((t, id) => t + report.chiusuraCassa(serataId, id).incasso_cent, 0);
    assert.equal(somma, report.riepilogoSerata(serataId).incasso_cent);
  });

  test('un ordine misto si divide fra le due stampanti di rete, una riga per parte', async () => {
    // Un giro di coda ne processa al massimo venti: prima si smaltisce
    // l'arretrato delle vendite qui sopra, altrimenti si misura quello.
    await svuotaCodaCompletamente();
    cucina.ricevuti.length = 0;
    bar.ricevuti.length = 0;

    const o = ordini.creaOrdine({
      tavolo: '5',
      idemKey: 'misto-reparti',
      cassaId: casse[2],
      righe: [
        { prodottoId: prodotti.salamella, quantita: 2 },
        { prodottoId: prodotti.birra, quantita: 3 },
      ],
    });
    await stampa.giroDiCoda();

    assert.equal(cucina.ricevuti.length, 1);
    assert.equal(bar.ricevuti.length, 1);

    const testoCucina = cucina.ricevuti[0].toString('latin1');
    const testoBar = bar.ricevuti[0].toString('latin1');
    // La cucina non deve vedere le birre, e il bar non deve vedere il cibo:
    // ogni reparto prepara solo la sua roba.
    assert.match(testoCucina, /2 x Salamella/);
    assert.doesNotMatch(testoCucina, /Media/);
    assert.match(testoBar, /3 x Media/);
    assert.doesNotMatch(testoBar, /Salamella/);
    // Lo stesso numero di comanda su entrambe: è così che il cliente ritira.
    assert.match(testoCucina, new RegExp(`comanda n. ${o.numero}`));
    assert.match(testoBar, new RegExp(`comanda n. ${o.numero}`));
    // Ognuna avvisa che per lo stesso tavolo esce anche l'altro vassoio:
    // è quello che dice a chi monta se partire subito o aspettare.
    assert.match(testoCucina, /ANCHE: BAR/);
    assert.match(testoBar, /ANCHE: CUCINA/);
    // Lo scontrino invece esce dalla termica del PC di quella cassa.
    assert.ok(o.scontrinoHtml);
  });

  test('una comanda di un reparto solo lo dichiara sulla carta', async () => {
    await svuotaCodaCompletamente();
    bar.ricevuti.length = 0;
    cucina.ricevuti.length = 0;

    ordini.creaOrdine({
      idemKey: 'solo-bar', cassaId: casse[0], tavolo: '21',
      righe: [{ prodottoId: prodotti.birra, quantita: 4 }],
    });
    await stampa.giroDiCoda();

    assert.equal(cucina.ricevuti.length, 0, 'la cucina non deve ricevere niente');
    assert.equal(bar.ricevuti.length, 1);
    const testo = bar.ricevuti[0].toString('latin1');
    // Senza questa riga chi monta il vassoio non sa se aspettare la cucina,
    // e resterebbe fermo per un vassoio che non arriverà mai.
    assert.match(testo, /SOLO BAR/);
    assert.doesNotMatch(testo, /ANCHE/);
  });
});

describe('due postazioni sulla stessa cassa', () => {
  const chiedi = (cassaId, postazione) => api.trovaRotta('GET', '/api/stato').gestore({
    corpo: {},
    parametri: {},
    query: new URLSearchParams({ cassaId: String(cassaId), postazione }),
  });

  // Le presenze restano valide mezzo minuto, quindi ogni prova si crea le
  // proprie casse: così l'esito non dipende da quelle usate poco fa.
  let contatore = 0;
  const cassaNuova = () => anagrafica.salvaCassa({ nome: `Prova presenza ${++contatore}` }).id;

  test('la stessa postazione che si ripresenta resta una sola', () => {
    const cassa = cassaNuova();
    assert.equal(chiedi(cassa, 'pc-uno').postazioniSullaStessaCassa, 1);
    assert.equal(chiedi(cassa, 'pc-uno').postazioniSullaStessaCassa, 1);
  });

  test('due computer diversi sulla stessa cassa vengono segnalati a entrambi', () => {
    const cassa = cassaNuova();
    chiedi(cassa, 'pc-due');
    assert.equal(chiedi(cassa, 'pc-tre').postazioniSullaStessaCassa, 2);
    assert.equal(chiedi(cassa, 'pc-due').postazioniSullaStessaCassa, 2,
      'anche la prima postazione deve vedere l\'avviso, non solo l\'ultima arrivata');
  });

  test('quattro postazioni su quattro casse distinte stanno tranquille', () => {
    const quattro = [cassaNuova(), cassaNuova(), cassaNuova(), cassaNuova()];
    quattro.forEach((cassa, i) => {
      assert.equal(chiedi(cassa, `distinto-${i}`).postazioniSullaStessaCassa, 1,
        `la cassa ${i + 1} risulta occupata da più postazioni`);
    });
  });

  test('senza identificativo di postazione non si segnala niente', () => {
    // Le pagine Report e Gestione interrogano lo stesso stato senza essere
    // una cassa: non devono far scattare l'avviso.
    const risposta = api.trovaRotta('GET', '/api/stato').gestore({
      corpo: {}, parametri: {}, query: new URLSearchParams(),
    });
    assert.equal(risposta.postazioniSullaStessaCassa, 0);
  });
});
