import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SIMOBS_DATI = mkdtempSync(join(tmpdir(), 'simobs-avanz-'));

let db, anagrafica, ordini, avanzamento;
let cassaId, cucina, bar, salamella, birra;

before(async () => {
  ({ db } = await import('../src/db.js'));
  anagrafica = await import('../src/anagrafica.js');
  ordini = await import('../src/ordini.js');
  avanzamento = await import('../src/avanzamento.js');

  cassaId = anagrafica.salvaCassa({ nome: 'Cassa 1', modo_stampa: 'nessuna' }).id;
  cucina = anagrafica.salvaReparto({ nome: 'Cucina', ordine: 1 }).id;
  bar = anagrafica.salvaReparto({ nome: 'Bar', ordine: 2 }).id;
  const cat = anagrafica.salvaCategoria({ nome: 'Tutto' }).id;
  salamella = anagrafica.salvaProdotto({
    nome: 'Salamella', categoria_id: cat, reparto_id: cucina, prezzo_cent: 400,
  }).id;
  birra = anagrafica.salvaProdotto({
    nome: 'Media', categoria_id: cat, reparto_id: bar, prezzo_cent: 500,
  }).id;
  anagrafica.apriSerata({ nome: 'Serata', data: '2026-08-15' });
});

let contatore = 0;
const ordineMisto = () => ordini.creaOrdine({
  idemKey: `av-${++contatore}`,
  cassaId,
  righe: [{ prodottoId: salamella, quantita: 1 }, { prodottoId: birra, quantita: 2 }],
});
const soloBirra = () => ordini.creaOrdine({
  idemKey: `av-${++contatore}`, cassaId, righe: [{ prodottoId: birra, quantita: 1 }],
});

describe('sincronizzazione fra cucina e bar', () => {
  test('un ordine misto nasce in lavorazione presso entrambi i reparti', () => {
    const o = ordineMisto();
    const s = avanzamento.statoOrdine(o.id);
    assert.deepEqual(s.reparti.map((r) => r.reparto).sort(), ['Bar', 'Cucina']);
    assert.ok(s.reparti.every((r) => r.stato === 'da_fare'));
    assert.equal(s.completo, false);
  });

  test('un ordine di sole birre coinvolge solo il bar', () => {
    const o = soloBirra();
    const s = avanzamento.statoOrdine(o.id);
    assert.deepEqual(s.reparti.map((r) => r.reparto), ['Bar']);
  });

  test('finché manca un reparto l\'ordine NON è completo', () => {
    const o = ordineMisto();
    const dopoCucina = avanzamento.segnaPronto({ ordineId: o.id, repartoId: cucina });
    assert.equal(dopoCucina.completo, false, 'la cucina da sola non basta a chiamare il numero');
    const dopoBar = avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });
    assert.equal(dopoBar.completo, true);
  });

  test('un ordine con un solo reparto è completo appena quello ha finito', () => {
    const o = soloBirra();
    assert.equal(avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar }).completo, true);
  });

  test('una seconda lettura dello stesso codice non rimette in lavorazione', () => {
    // Le pistole partono da sole: un doppio bip non deve disfare il lavoro.
    const o = soloBirra();
    const prima = avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });
    const seconda = avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });
    assert.equal(seconda.giaPronto, true);
    assert.equal(seconda.completo, true);
    assert.equal(
      seconda.reparti.find((r) => r.reparto_id === bar).pronto_il,
      prima.reparti.find((r) => r.reparto_id === bar).pronto_il,
      'la seconda lettura ha sovrascritto l\'ora della prima',
    );
  });

  test('si può rimettere in lavorazione a mano, se si è segnato pronto per sbaglio', () => {
    const o = soloBirra();
    avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });
    const riaperto = avanzamento.riapri({ ordineId: o.id, repartoId: bar });
    assert.equal(riaperto.completo, false);
    assert.equal(riaperto.reparti[0].stato, 'da_fare');
  });

  test('un reparto non può segnare pronto un ordine che non lo riguarda', () => {
    const o = soloBirra();
    assert.throws(
      () => avanzamento.segnaPronto({ ordineId: o.id, repartoId: cucina }),
      /non ha niente per questo reparto/,
    );
  });
});

describe('lettura del codice a barre', () => {
  test('il codice letto dalla pistola porta all\'ordine giusto', () => {
    const o = ordineMisto();
    const esito = avanzamento.scansiona({ codice: String(o.id), repartoId: cucina, operatore: 'Luca' });
    assert.equal(esito.numero, o.numero);
    assert.equal(esito.reparti.find((r) => r.reparto_id === cucina).operatore, 'Luca');
  });

  test('gli asterischi del Code 39 e gli spazi non danno fastidio', () => {
    const o = soloBirra();
    const esito = avanzamento.scansiona({ codice: ` *${o.id}* `, repartoId: bar });
    assert.equal(esito.numero, o.numero);
  });

  test('un codice illeggibile viene rifiutato con un messaggio, non con un errore tecnico', () => {
    assert.throws(() => avanzamento.scansiona({ codice: 'ABC-xyz', repartoId: bar }), /non riconosciuto/);
    assert.throws(() => avanzamento.scansiona({ codice: '', repartoId: bar }), /non riconosciuto/);
    assert.throws(() => avanzamento.scansiona({ codice: '999999', repartoId: bar }), /nessun ordine/);
  });

  test('una comanda annullata non si può segnare pronta', () => {
    const o = soloBirra();
    ordini.annullaOrdine(o.id, 'sbagliata');
    assert.throws(() => avanzamento.scansiona({ codice: String(o.id), repartoId: bar }), /annullata/);
  });

  test('una comanda di ieri sera non tocca la serata di oggi', () => {
    // Il codice contiene l'identificativo interno, non il numero di comanda che
    // riparte da 1: una comanda rimasta in tasca non può colpire l'omonima.
    const vecchio = soloBirra();
    const serataVecchia = anagrafica.serataAperta();
    anagrafica.chiudiSerata(serataVecchia.id);
    anagrafica.apriSerata({ nome: 'Serata dopo', data: '2026-08-16' });

    assert.throws(
      () => avanzamento.scansiona({ codice: String(vecchio.id), repartoId: bar }),
      /un'altra serata/,
    );

    const nuovo = soloBirra();
    assert.equal(nuovo.numero, 1, 'la nuova serata riparte da 1');
    assert.notEqual(nuovo.id, vecchio.id, 'l\'identificativo interno invece non si ripete mai');
    assert.equal(avanzamento.scansiona({ codice: String(nuovo.id), repartoId: bar }).completo, true);
  });
});

describe('coda della postazione', () => {
  test('ogni reparto vede solo la propria roba, ma sa a che punto è l\'altro', () => {
    const o = ordineMisto();
    avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });

    const inCucina = avanzamento.codaReparto(cucina).daFare.find((x) => x.id === o.id);
    assert.ok(inCucina, 'l\'ordine non compare fra quelli da preparare in cucina');
    assert.deepEqual(inCucina.righe.map((r) => r.nome), ['Salamella'],
      'la cucina non deve vedere le birre');
    assert.equal(inCucina.reparti.find((r) => r.reparto_id === bar).stato, 'pronto',
      'la cucina deve sapere che il bar ha già finito: è tutta la sincronizzazione');
  });

  test('chi ha finito lo trova fra quelli in attesa dell\'altro reparto', () => {
    const o = ordineMisto();
    avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });
    const coda = avanzamento.codaReparto(bar);
    assert.ok(coda.inAttesaDiAltri.some((x) => x.id === o.id));
    assert.ok(!coda.daFare.some((x) => x.id === o.id));
  });

  test('gli ordini annullati spariscono dalla coda di lavoro', () => {
    const o = ordineMisto();
    ordini.annullaOrdine(o.id);
    const coda = avanzamento.codaReparto(cucina);
    const presente = [...coda.daFare, ...coda.inAttesaDiAltri, ...coda.completatiDiRecente]
      .some((x) => x.id === o.id);
    assert.equal(presente, false);
  });
});

describe('monitor dei numeri pronti', () => {
  test('compaiono solo gli ordini finiti da tutti i reparti', () => {
    const meta = ordineMisto();
    avanzamento.segnaPronto({ ordineId: meta.id, repartoId: cucina });

    const tutto = ordineMisto();
    avanzamento.segnaPronto({ ordineId: tutto.id, repartoId: cucina });
    avanzamento.segnaPronto({ ordineId: tutto.id, repartoId: bar });

    const numeri = avanzamento.ordiniCompleti().map((o) => o.numero);
    assert.ok(numeri.includes(tutto.numero), 'un ordine completo deve essere chiamato');
    assert.ok(!numeri.includes(meta.numero), 'un ordine a metà non va chiamato');
  });

  test('un ordine annullato dopo essere stato pronto sparisce dal monitor', () => {
    const o = soloBirra();
    avanzamento.segnaPronto({ ordineId: o.id, repartoId: bar });
    assert.ok(avanzamento.ordiniCompleti().some((x) => x.numero === o.numero));
    ordini.annullaOrdine(o.id);
    assert.ok(!avanzamento.ordiniCompleti().some((x) => x.numero === o.numero));
  });
});
