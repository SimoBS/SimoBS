import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ogni file di test lavora su un database usa-e-getta. La variabile va
// impostata PRIMA di importare i moduli, che leggono la cartella all'avvio:
// per questo gli import sono dinamici e non in testa al file.
process.env.SIMOBS_DATI = mkdtempSync(join(tmpdir(), 'simobs-test-'));

let db, anagrafica, ordini, magazzino, report;
let cassaId, repartoId, categoriaId, birraId, salamellaId, artFusto, artBicchieri;

before(async () => {
  ({ db } = await import('../src/db.js'));
  anagrafica = await import('../src/anagrafica.js');
  ordini = await import('../src/ordini.js');
  magazzino = await import('../src/magazzino.js');
  report = await import('../src/report.js');

  cassaId = anagrafica.salvaCassa({ nome: 'Cassa prova' }).id;
  repartoId = anagrafica.salvaReparto({ nome: 'Spina' }).id;
  categoriaId = anagrafica.salvaCategoria({ nome: 'Birre' }).id;

  artFusto = anagrafica.salvaArticolo({ nome: 'Fusto', unita: 'L', soglia_minima: 10 }).id;
  artBicchieri = anagrafica.salvaArticolo({ nome: 'Bicchieri', unita: 'pz', soglia_minima: 50 }).id;
  magazzino.carica({ articoloId: artFusto, quantita: 100 });
  magazzino.carica({ articoloId: artBicchieri, quantita: 500 });

  birraId = anagrafica.salvaProdotto({
    nome: 'Media 0,4', categoria_id: categoriaId, reparto_id: repartoId, prezzo_cent: 500,
  }).id;
  salamellaId = anagrafica.salvaProdotto({
    nome: 'Salamella', categoria_id: categoriaId, reparto_id: repartoId, prezzo_cent: 400,
  }).id;

  anagrafica.impostaDistinta(birraId, [
    { articolo_id: artFusto, quantita: 0.4 },
    { articolo_id: artBicchieri, quantita: 1 },
  ]);

  anagrafica.apriSerata({ nome: 'Serata test', data: '2026-08-15', edizione: '2026' });
});

const nuovoOrdine = (righe, extra = {}) => ordini.creaOrdine({
  idemKey: `k-${Math.random()}`, cassaId, righe, ...extra,
});

describe('creazione ordini', () => {
  test('il totale si calcola sui prezzi del database, non su quelli mandati dal client', () => {
    const o = ordini.creaOrdine({
      idemKey: 'prezzo-falso',
      cassaId,
      // Un client malevolo (o un bug) prova a imporre il prezzo: va ignorato.
      righe: [{ prodottoId: birraId, quantita: 2, prezzo_cent: 1, prezzoCent: 1 }],
    });
    assert.equal(o.totale_cent, 1000);
  });

  test('la stessa idemKey non incassa due volte', () => {
    const primo = ordini.creaOrdine({ idemKey: 'ripetuta', cassaId, righe: [{ prodottoId: birraId, quantita: 1 }] });
    const secondo = ordini.creaOrdine({ idemKey: 'ripetuta', cassaId, righe: [{ prodottoId: birraId, quantita: 1 }] });
    assert.equal(secondo.duplicato, true);
    assert.equal(secondo.id, primo.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ordini WHERE idem_key = ?').get('ripetuta').n, 1);
  });

  test('i numeri di comanda sono progressivi e senza buchi nella serata', () => {
    const a = nuovoOrdine([{ prodottoId: birraId, quantita: 1 }]);
    const b = nuovoOrdine([{ prodottoId: birraId, quantita: 1 }]);
    assert.equal(b.numero, a.numero + 1);
  });

  test('lo sconto si sottrae dal totale', () => {
    const o = nuovoOrdine([{ prodottoId: birraId, quantita: 2 }], { scontoCent: 150 });
    assert.equal(o.totale_cent, 850);
    assert.equal(o.sconto_cent, 150);
  });

  test('uno sconto maggiore del totale viene rifiutato invece di generare un incasso negativo', () => {
    assert.throws(
      () => nuovoOrdine([{ prodottoId: birraId, quantita: 1 }], { scontoCent: 99999 }),
      /sconto supera/,
    );
  });

  test('un ordine senza righe viene rifiutato', () => {
    assert.throws(() => nuovoOrdine([]), /senza righe/);
  });

  test('una quantità non intera o negativa viene rifiutata', () => {
    assert.throws(() => nuovoOrdine([{ prodottoId: birraId, quantita: -1 }]), /quantità non valida/);
    assert.throws(() => nuovoOrdine([{ prodottoId: birraId, quantita: 1.5 }]), /quantità non valida/);
  });

  test('un prodotto inesistente non crea un ordine a metà', () => {
    const prima = db.prepare('SELECT COUNT(*) AS n FROM ordini').get().n;
    assert.throws(() => nuovoOrdine([{ prodottoId: 99999, quantita: 1 }]), /inesistente/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ordini').get().n, prima, 'la transazione non è stata annullata');
  });

  test('il nome del prodotto viene congelato nella riga, così i report storici non cambiano', () => {
    const o = nuovoOrdine([{ prodottoId: salamellaId, quantita: 1 }]);
    anagrafica.salvaProdotto({ id: salamellaId, nome: 'Salamella maxi' });
    const riletto = ordini.dettaglioOrdine(o.id);
    assert.equal(riletto.righe[0].nome, 'Salamella');
  });
});

describe('magazzino', () => {
  test('la vendita scarica le scorte seguendo la distinta base', () => {
    const prima = db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(artFusto).giacenza;
    nuovoOrdine([{ prodottoId: birraId, quantita: 5 }]);
    const dopo = db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(artFusto).giacenza;
    assert.ok(Math.abs((prima - dopo) - 2) < 1e-9, `atteso -2 L, ottenuto ${prima - dopo}`);
  });

  test('un prodotto senza distinta base non tocca il magazzino', () => {
    const prima = db.prepare('SELECT SUM(giacenza) AS t FROM articoli').get().t;
    nuovoOrdine([{ prodottoId: salamellaId, quantita: 3 }]);
    assert.equal(db.prepare('SELECT SUM(giacenza) AS t FROM articoli').get().t, prima);
  });

  test('la scorta insufficiente NON blocca la vendita', () => {
    const scarso = anagrafica.salvaArticolo({ nome: 'Quasi finito', unita: 'pz' }).id;
    const prodotto = anagrafica.salvaProdotto({
      nome: 'Ultimo pezzo', categoria_id: categoriaId, reparto_id: repartoId, prezzo_cent: 100,
    }).id;
    anagrafica.impostaDistinta(prodotto, [{ articolo_id: scarso, quantita: 1 }]);
    const o = nuovoOrdine([{ prodottoId: prodotto, quantita: 3 }]);
    assert.equal(o.totale_cent, 300);
    assert.equal(db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(scarso).giacenza, -3);
  });

  test('lo storno ricarica esattamente quello che era stato scaricato', () => {
    const prima = db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(artFusto).giacenza;
    const o = nuovoOrdine([{ prodottoId: birraId, quantita: 4 }]);
    ordini.annullaOrdine(o.id, 'prova');
    const dopo = db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(artFusto).giacenza;
    assert.ok(Math.abs(prima - dopo) < 1e-9, `giacenza non ripristinata: ${prima} -> ${dopo}`);
  });

  test('stornare due volte non ricarica il magazzino due volte', () => {
    const o = nuovoOrdine([{ prodottoId: birraId, quantita: 2 }]);
    ordini.annullaOrdine(o.id);
    const dopoPrimo = db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(artFusto).giacenza;
    const secondo = ordini.annullaOrdine(o.id);
    assert.equal(secondo.giaAnnullato, true);
    assert.equal(db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(artFusto).giacenza, dopoPrimo);
  });

  test('l\'inventario porta la giacenza al valore contato e lascia traccia del movimento', () => {
    const a = anagrafica.salvaArticolo({ nome: 'Da contare', unita: 'pz' }).id;
    magazzino.carica({ articoloId: a, quantita: 100 });
    magazzino.rettifica({ articoloId: a, giacenzaReale: 87, nota: 'inventario di mezzanotte' });
    assert.equal(db.prepare('SELECT giacenza FROM articoli WHERE id = ?').get(a).giacenza, 87);
    const ultimo = magazzino.movimenti({ articoloId: a, limite: 1 })[0];
    assert.equal(ultimo.tipo, 'rettifica');
    assert.equal(ultimo.quantita, -13);
  });

  test('gli allarmi segnalano scorte basse ed esaurite', () => {
    const a = anagrafica.salvaArticolo({ nome: 'Sotto soglia', unita: 'pz', soglia_minima: 10 }).id;
    magazzino.carica({ articoloId: a, quantita: 5 });
    const allarme = magazzino.allarmiScorte().find((x) => x.id === a);
    assert.equal(allarme.stato, 'basso');
  });
});

describe('report', () => {
  test('gli ordini annullati non entrano nell\'incasso ma vengono contati a parte', () => {
    const serata = anagrafica.serataAperta();
    const prima = report.riepilogoSerata(serata.id);
    const o = nuovoOrdine([{ prodottoId: birraId, quantita: 2 }]);
    ordini.annullaOrdine(o.id, 'cliente ripensato');
    const dopo = report.riepilogoSerata(serata.id);
    assert.equal(dopo.incasso_cent, prima.incasso_cent, 'lo storno ha sporcato l\'incasso');
    assert.equal(dopo.storni.ordini, prima.storni.ordini + 1);
  });

  test('lo scontrino medio è coerente con incasso e numero di ordini', () => {
    const r = report.riepilogoSerata(anagrafica.serataAperta().id);
    assert.equal(r.scontrino_medio_cent, Math.round(r.incasso_cent / r.ordini));
  });

  test('il venduto per reparto somma quanto il venduto per prodotto', () => {
    const id = anagrafica.serataAperta().id;
    const perReparto = report.vendutoPerReparto(id).reduce((t, r) => t + r.lordo_cent, 0);
    const perProdotto = report.vendutoPerProdotto(id).reduce((t, r) => t + r.lordo_cent, 0);
    assert.equal(perReparto, perProdotto);
  });

  test('il documento di chiusura riporta l\'incasso della serata', async () => {
    const { versoTesto } = await import('../src/escpos.js');
    const { euro } = await import('../src/stampa.js');
    const id = anagrafica.serataAperta().id;
    // Titolo e incasso sono a corpo ingrandito: nell'anteprima escono coi
    // caratteri distanziati, quindi il confronto si fa a spazi rimossi.
    const compatto = versoTesto(report.documentoChiusura(id)).replace(/ /g, '');
    assert.match(compatto, /CHIUSURA/);
    assert.ok(compatto.includes(`INCASSO${euro(report.riepilogoSerata(id).incasso_cent)}`));
  });
});

describe('serate', () => {
  test('non si possono tenere due serate aperte insieme', () => {
    assert.throws(
      () => anagrafica.apriSerata({ nome: 'Doppia', data: '2026-08-16' }),
      /ancora aperta/,
    );
  });

  test('a serata chiusa la cassa non incassa più', () => {
    const serata = anagrafica.serataAperta();
    anagrafica.chiudiSerata(serata.id);
    assert.throws(() => nuovoOrdine([{ prodottoId: birraId, quantita: 1 }]), /nessuna serata aperta/);
    anagrafica.apriSerata({ nome: 'Riaperta', data: '2026-08-16', edizione: '2026' });
  });

  test('la numerazione delle comande riparte da 1 in una serata nuova', () => {
    const o = nuovoOrdine([{ prodottoId: birraId, quantita: 1 }]);
    assert.equal(o.numero, 1);
  });
});
