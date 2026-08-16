import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SIMOBS_DATI = mkdtempSync(join(tmpdir(), 'simobs-avanz-'));

let db, config, anagrafica, ordini, avanzamento;
let cassaId, cucina, bar, salamella, birra;

before(async () => {
  ({ db } = await import('../src/db.js'));
  ({ config } = await import('../src/config.js'));
  anagrafica = await import('../src/anagrafica.js');
  ordini = await import('../src/ordini.js');
  avanzamento = await import('../src/avanzamento.js');

  // Nei test le due sparate arrivano nello stesso millisecondo: qui
  // l'antirimbalzo va spento, e dove serve provarlo si rialza a mano.
  config.secondiAntirimbalzoPistola = 0;

  cassaId = anagrafica.salvaCassa({ nome: 'Cassa 1', modo_stampa: 'nessuna' }).id;
  cucina = anagrafica.salvaReparto({ nome: 'Cucina', ordine: 1 }).id;
  bar = anagrafica.salvaReparto({ nome: 'Bar', ordine: 2 }).id;
  const cat = anagrafica.salvaCategoria({ nome: 'Tutto' }).id;
  salamella = anagrafica.salvaProdotto({
    nome: 'Salamella', nome_comanda: 'SALAM', categoria_id: cat, reparto_id: cucina, prezzo_cent: 400,
  }).id;
  birra = anagrafica.salvaProdotto({
    nome: 'Media', nome_comanda: 'MEDIA', categoria_id: cat, reparto_id: bar, prezzo_cent: 500,
  }).id;
  anagrafica.apriSerata({ nome: 'Serata', data: '2026-08-15' });
});

let contatore = 0;
const ordineMisto = (extra = {}) => ordini.creaOrdine({
  idemKey: `av-${++contatore}`,
  cassaId,
  tavolo: '7',
  coperti: 2,
  righe: [{ prodottoId: salamella, quantita: 1 }, { prodottoId: birra, quantita: 2 }],
  ...extra,
});
const soloBirra = (extra = {}) => ordini.creaOrdine({
  idemKey: `av-${++contatore}`, cassaId, tavolo: '3',
  righe: [{ prodottoId: birra, quantita: 1 }], ...extra,
});

/** Le due sparate: presa in carico e uscita del vassoio. */
const esci = (ordineId, repartoId, operatore = '') => {
  avanzamento.avanza({ ordineId, repartoId, operatore });
  return avanzamento.avanza({ ordineId, repartoId, operatore });
};

describe('i due tempi della lavorazione', () => {
  test('un ordine misto nasce da fare presso entrambi i reparti', () => {
    const s = avanzamento.statoOrdine(ordineMisto().id);
    assert.deepEqual(s.reparti.map((r) => r.reparto).sort(), ['Bar', 'Cucina']);
    assert.ok(s.reparti.every((r) => r.stato === 'da_fare'));
    assert.equal(s.completo, false);
  });

  test('la prima sparata prende in carico, la seconda fa uscire il vassoio', () => {
    const o = soloBirra();
    const presa = avanzamento.avanza({ ordineId: o.id, repartoId: bar, operatore: 'Anna' });
    assert.equal(presa.passaggio, 'in_lavorazione');
    assert.equal(presa.completo, false, 'preso in carico non vuol dire uscito');
    assert.ok(presa.reparti[0].preso_il);
    assert.equal(presa.reparti[0].uscito_il, null);

    const uscita = avanzamento.avanza({ ordineId: o.id, repartoId: bar, operatore: 'Anna' });
    assert.equal(uscita.passaggio, 'uscito');
    assert.equal(uscita.completo, true);
    assert.ok(uscita.reparti[0].uscito_il);
  });

  test('finché un reparto non ha fatto uscire il vassoio l\'ordine non è completo', () => {
    const o = ordineMisto();
    assert.equal(esci(o.id, cucina).completo, false, 'la cucina da sola non basta');
    assert.equal(esci(o.id, bar).completo, true);
  });

  test('una terza sparata non fa niente e lo dice', () => {
    const o = soloBirra();
    esci(o.id, bar);
    const terza = avanzamento.avanza({ ordineId: o.id, repartoId: bar });
    assert.equal(terza.passaggio, 'gia_uscito');
    assert.equal(terza.completo, true);
  });

  test('due letture troppo ravvicinate contano come una sola', () => {
    // È il doppio bip della pistola: senza questa finestra un ordine appena
    // preso in carico risulterebbe subito uscito, saltando la preparazione.
    config.secondiAntirimbalzoPistola = 3;
    try {
      const o = soloBirra();
      assert.equal(avanzamento.avanza({ ordineId: o.id, repartoId: bar }).passaggio, 'in_lavorazione');
      const subito = avanzamento.avanza({ ordineId: o.id, repartoId: bar });
      assert.equal(subito.passaggio, 'rimbalzo');
      assert.equal(subito.reparti[0].stato, 'in_lavorazione', 'il vassoio non deve risultare uscito');
    } finally {
      config.secondiAntirimbalzoPistola = 0;
    }
  });

  test('si torna indietro di un passo per volta, se si spara per sbaglio', () => {
    const o = soloBirra();
    esci(o.id, bar);
    assert.equal(avanzamento.indietro({ ordineId: o.id, repartoId: bar }).reparti[0].stato, 'in_lavorazione');
    assert.equal(avanzamento.indietro({ ordineId: o.id, repartoId: bar }).reparti[0].stato, 'da_fare');
  });

  test('un reparto non può toccare un ordine che non lo riguarda', () => {
    const o = soloBirra();
    assert.throws(
      () => avanzamento.avanza({ ordineId: o.id, repartoId: cucina }),
      /non ha niente per questo reparto/,
    );
  });
});

/**
 * Un ordine che riguarda un reparto solo — solo birre, o solo cibo — non ha
 * niente da attendere. Va trattato bene in tre punti: non deve restare appeso
 * a un vassoio che non arriverà mai, deve contare come pronto da far uscire, e
 * la carta deve dirlo a chi monta il vassoio.
 */
describe('comande di un solo reparto', () => {
  const soloCucina = (extra = {}) => ordini.creaOrdine({
    idemKey: `solo-${++contatore}`, cassaId, tavolo: '9',
    righe: [{ prodottoId: salamella, quantita: 2 }], ...extra,
  });

  test('un ordine di solo cibo si completa senza aspettare il bar', () => {
    const o = soloCucina();
    const s = avanzamento.statoOrdine(o.id);
    assert.deepEqual(s.reparti.map((r) => r.reparto), ['Cucina']);
    assert.equal(esci(o.id, cucina).completo, true);
  });

  test('un ordine di sole birre si completa senza aspettare la cucina', () => {
    const o = soloBirra();
    assert.deepEqual(avanzamento.statoOrdine(o.id).reparti.map((r) => r.reparto), ['Bar']);
    assert.equal(esci(o.id, bar).completo, true);
  });

  test('conta subito fra i pronti da far uscire: non c\'è nessun altro da attendere', () => {
    const prima = avanzamento.riepilogoMonitor(cucina).sbloccati;
    soloCucina();
    assert.equal(avanzamento.riepilogoMonitor(cucina).sbloccati, prima + 1);
  });

  test('un ordine misto invece NON è sbloccato finché il bar non esce', () => {
    const prima = avanzamento.riepilogoMonitor(cucina).sbloccati;
    const o = ordineMisto();
    assert.equal(avanzamento.riepilogoMonitor(cucina).sbloccati, prima,
      'con il bar ancora al lavoro la cucina non deve mandare fuori niente');
    esci(o.id, bar);
    assert.equal(avanzamento.riepilogoMonitor(cucina).sbloccati, prima + 1);
  });
});

describe('lettura del codice a barre', () => {
  test('il codice porta all\'ordine giusto e registra chi ha sparato', () => {
    const o = ordineMisto();
    const esito = avanzamento.scansiona({ codice: String(o.id), repartoId: cucina, operatore: 'Luca' });
    assert.equal(esito.numero, o.numero);
    assert.equal(esito.reparti.find((r) => r.reparto_id === cucina).operatore, 'Luca');
  });

  test('gli asterischi del Code 39 e gli spazi non danno fastidio', () => {
    const o = soloBirra();
    assert.equal(avanzamento.scansiona({ codice: ` *${o.id}* `, repartoId: bar }).numero, o.numero);
  });

  test('un codice illeggibile viene rifiutato con un messaggio, non con un errore tecnico', () => {
    assert.throws(() => avanzamento.scansiona({ codice: 'ABC-xyz', repartoId: bar }), /non riconosciuto/);
    assert.throws(() => avanzamento.scansiona({ codice: '', repartoId: bar }), /non riconosciuto/);
    assert.throws(() => avanzamento.scansiona({ codice: '999999', repartoId: bar }), /nessun ordine/);
  });

  test('una comanda annullata non si può lavorare', () => {
    const o = soloBirra();
    ordini.annullaOrdine(o.id, 'sbagliata');
    assert.throws(() => avanzamento.scansiona({ codice: String(o.id), repartoId: bar }), /annullata/);
  });

  test('una comanda di ieri sera non tocca la serata di oggi', () => {
    const vecchio = soloBirra();
    anagrafica.chiudiSerata(anagrafica.serataAperta().id);
    anagrafica.apriSerata({ nome: 'Serata dopo', data: '2026-08-16' });

    assert.throws(
      () => avanzamento.scansiona({ codice: String(vecchio.id), repartoId: bar }),
      /un'altra serata/,
    );

    const nuovo = soloBirra();
    assert.equal(nuovo.numero, 1, 'la nuova serata riparte da 1');
    assert.notEqual(nuovo.id, vecchio.id, 'l\'identificativo interno invece non si ripete mai');
  });
});

describe('coda della postazione', () => {
  test('ogni reparto vede solo la propria roba, ma sa a che punto è l\'altro', () => {
    const o = ordineMisto();
    esci(o.id, bar);

    const inCucina = avanzamento.codaReparto(cucina).daFare.find((x) => x.id === o.id);
    assert.ok(inCucina, 'l\'ordine non compare fra quelli da preparare in cucina');
    assert.deepEqual(inCucina.righe.map((r) => r.nome), ['Salamella'], 'la cucina non deve vedere le birre');
    assert.equal(inCucina.reparti.find((r) => r.reparto_id === bar).stato, 'uscito',
      'la cucina deve sapere che il bar è già uscito: è tutta la sincronizzazione');
  });

  test('l\'ordine si sposta fra i tre gruppi a ogni sparata', () => {
    const o = ordineMisto();
    const dove = () => {
      const c = avanzamento.codaReparto(cucina);
      if (c.daFare.some((x) => x.id === o.id)) return 'daFare';
      if (c.inLavorazione.some((x) => x.id === o.id)) return 'inLavorazione';
      return c.usciti.some((x) => x.id === o.id) ? 'usciti' : 'sparito';
    };
    assert.equal(dove(), 'daFare');
    avanzamento.avanza({ ordineId: o.id, repartoId: cucina });
    assert.equal(dove(), 'inLavorazione');
    avanzamento.avanza({ ordineId: o.id, repartoId: cucina });
    assert.equal(dove(), 'usciti');
  });

  test('gli ordini annullati spariscono dalla coda di lavoro', () => {
    const o = ordineMisto();
    ordini.annullaOrdine(o.id);
    const c = avanzamento.codaReparto(cucina);
    assert.ok(![...c.daFare, ...c.inLavorazione, ...c.usciti].some((x) => x.id === o.id));
  });
});

describe('lavagna di produzione del monitor', () => {
  test('somma le porzioni ancora da fare, per prodotto', () => {
    const medie = () => avanzamento.daProdurre(bar).find((p) => p.prodotto === 'MEDIA')?.pezzi ?? 0;
    const prima = medie();
    ordineMisto(); // due medie
    ordineMisto(); // altre due
    assert.equal(medie(), prima + 4);
  });

  test('i vassoi usciti non contano più: la lavagna dice cosa manca, non cosa è stato venduto', () => {
    const o = ordineMisto();
    const prima = avanzamento.daProdurre(cucina).find((p) => p.prodotto === 'SALAM').pezzi;
    esci(o.id, cucina);
    const dopo = avanzamento.daProdurre(cucina).find((p) => p.prodotto === 'SALAM')?.pezzi ?? 0;
    assert.equal(dopo, prima - 1);
  });

  test('distingue quanto è già stato preso in carico', () => {
    const o = ordineMisto();
    avanzamento.avanza({ ordineId: o.id, repartoId: cucina });
    const voce = avanzamento.daProdurre(cucina).find((p) => p.prodotto === 'SALAM');
    assert.ok(voce.in_lavorazione >= 1);
    assert.ok(voce.pezzi >= voce.in_lavorazione);
  });

  test('il riepilogo conta gli ordini sbloccati dall\'altro reparto', () => {
    const o = ordineMisto();
    const prima = avanzamento.riepilogoMonitor(cucina).sbloccati;
    esci(o.id, bar);
    assert.equal(avanzamento.riepilogoMonitor(cucina).sbloccati, prima + 1,
      'con il bar uscito, per la cucina quell\'ordine è pronto da far uscire');
  });
});

describe('monitor dei ritiri al banco', () => {
  test('mostra self-service e asporto, non gli ordini serviti al tavolo', () => {
    const alTavolo = ordineMisto();
    esci(alTavolo.id, cucina);
    esci(alTavolo.id, bar);

    const daAsporto = soloBirra({ servizio: 'asporto' });
    esci(daAsporto.id, bar);

    const numeri = avanzamento.ordiniCompleti().map((x) => x.numero);
    assert.ok(numeri.includes(daAsporto.numero), 'un asporto pronto va chiamato');
    assert.ok(!numeri.includes(alTavolo.numero),
      'al tavolo ci pensa il cameriere: chiamare quel numero confonderebbe');
  });

  test('un ordine a metà non compare', () => {
    const o = soloBirra({ servizio: 'self' });
    avanzamento.avanza({ ordineId: o.id, repartoId: bar });
    assert.ok(!avanzamento.ordiniCompleti().some((x) => x.numero === o.numero));
  });
});
