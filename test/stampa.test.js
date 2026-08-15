import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SIMOBS_DATI = mkdtempSync(join(tmpdir(), 'simobs-stampa-'));

let db, anagrafica, ordini, stampa, escpos, config;
let cassaId, repartoId, prodottoId;

/** Stampante finta: accetta connessioni e conserva i byte ricevuti. */
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

before(async () => {
  ({ db } = await import('../src/db.js'));
  ({ config } = await import('../src/config.js'));
  anagrafica = await import('../src/anagrafica.js');
  ordini = await import('../src/ordini.js');
  stampa = await import('../src/stampa.js');
  escpos = await import('../src/escpos.js');

  cassaId = anagrafica.salvaCassa({ nome: 'Cassa 1' }).id;
  repartoId = anagrafica.salvaReparto({ nome: 'Cucina' }).id;
  const categoriaId = anagrafica.salvaCategoria({ nome: 'Cibo' }).id;
  prodottoId = anagrafica.salvaProdotto({
    nome: 'Salamella', nome_comanda: 'SALAM', categoria_id: categoriaId,
    reparto_id: repartoId, prezzo_cent: 400,
  }).id;
  anagrafica.apriSerata({ nome: 'Serata stampa', data: '2026-08-15' });
});

describe('coda di stampa', () => {
  test('un reparto senza stampante non accoda nulla: è una scelta di allestimento', () => {
    const o = ordini.creaOrdine({
      idemKey: 'senza-stampante', cassaId, righe: [{ prodottoId, quantita: 1 }],
    });
    const n = db.prepare('SELECT COUNT(*) AS n FROM stampe WHERE ordine_id = ?').get(o.id).n;
    assert.equal(n, 0);
  });

  test('la comanda arriva davvero alla stampante e contiene il numero e il prodotto', async () => {
    const finta = stampanteFinta();
    const porta = await finta.ascolta();
    anagrafica.salvaReparto({ id: repartoId, stampante_host: '127.0.0.1', stampante_porta: porta });

    const o = ordini.creaOrdine({
      idemKey: 'con-stampante', cassaId, righe: [{ prodottoId, quantita: 3, nota: 'senza cipolla' }],
    });
    await stampa.giroDiCoda();

    assert.equal(finta.ricevuti.length, 1, 'la stampante non ha ricevuto nulla');
    const testo = finta.ricevuti[0].toString('latin1');
    assert.match(testo, /CUCINA/);
    assert.match(testo, new RegExp(`N\\. ${o.numero}`));
    assert.match(testo, /3 x SALAM/);
    assert.match(testo, /senza cipolla/);

    const riga = db.prepare('SELECT stato FROM stampe WHERE ordine_id = ?').get(o.id);
    assert.equal(riga.stato, 'stampata');
    await finta.chiudi();
  });

  test('rispetta il numero di copie configurato sul reparto', async () => {
    const finta = stampanteFinta();
    const porta = await finta.ascolta();
    anagrafica.salvaReparto({ id: repartoId, stampante_host: '127.0.0.1', stampante_porta: porta, copie: 2 });

    ordini.creaOrdine({ idemKey: 'due-copie', cassaId, righe: [{ prodottoId, quantita: 1 }] });
    await stampa.giroDiCoda();

    assert.equal(finta.ricevuti.length, 2);
    anagrafica.salvaReparto({ id: repartoId, copie: 1 });
    await finta.chiudi();
  });

  test('una stampante spenta non perde la comanda: resta in attesa e ritenta', async () => {
    // Porta chiusa: nessuno in ascolto, come una stampante staccata.
    anagrafica.salvaReparto({ id: repartoId, stampante_host: '127.0.0.1', stampante_porta: 1 });
    const o = ordini.creaOrdine({ idemKey: 'stampante-giu', cassaId, righe: [{ prodottoId, quantita: 1 }] });

    await stampa.giroDiCoda();

    const riga = db.prepare('SELECT * FROM stampe WHERE ordine_id = ?').get(o.id);
    assert.equal(riga.stato, 'in_attesa', 'la comanda non deve essere buttata via');
    assert.equal(riga.tentativi, 1);
    assert.ok(riga.ultimo_errore.length > 0);
  });

  test('quando la stampante torna su, la comanda in attesa esce da sola', async () => {
    const finta = stampanteFinta();
    const porta = await finta.ascolta();
    // Stessa comanda di prima, ora la destinazione è raggiungibile: la coda
    // punta al reparto, non a un IP congelato al momento dell'ordine.
    anagrafica.salvaReparto({ id: repartoId, stampante_host: '127.0.0.1', stampante_porta: porta });
    db.prepare(`UPDATE stampe SET prossimo_tentativo = '2000-01-01T00:00:00' WHERE stato = 'in_attesa'`).run();

    await stampa.giroDiCoda();

    assert.ok(finta.ricevuti.length >= 1);
    const rimaste = db.prepare(`SELECT COUNT(*) AS n FROM stampe WHERE stato = 'in_attesa'`).get().n;
    assert.equal(rimaste, 0);
    await finta.chiudi();
  });

  test('lo storno manda ai reparti una comanda di annullamento', async () => {
    const finta = stampanteFinta();
    const porta = await finta.ascolta();
    anagrafica.salvaReparto({ id: repartoId, stampante_host: '127.0.0.1', stampante_porta: porta });

    const o = ordini.creaOrdine({ idemKey: 'da-stornare', cassaId, righe: [{ prodottoId, quantita: 2 }] });
    await stampa.giroDiCoda();
    finta.ricevuti.length = 0;

    ordini.annullaOrdine(o.id, 'errore di battitura');
    await stampa.giroDiCoda();

    assert.equal(finta.ricevuti.length, 1);
    const testo = finta.ricevuti[0].toString('latin1');
    assert.match(testo, /ANNULLATO/);
    assert.match(testo, /NON PREPARARE/);
    assert.match(testo, /errore di battitura/);
    await finta.chiudi();
  });

  test('la ristampa rimette in coda un documento già uscito', async () => {
    const finta = stampanteFinta();
    const porta = await finta.ascolta();
    anagrafica.salvaReparto({ id: repartoId, stampante_host: '127.0.0.1', stampante_porta: porta });

    const o = ordini.creaOrdine({ idemKey: 'da-ristampare', cassaId, righe: [{ prodottoId, quantita: 1 }] });
    await stampa.giroDiCoda();
    const primoGiro = finta.ricevuti.length;

    assert.equal(ordini !== undefined && stampa.ristampaOrdine(o.id), 1);
    await stampa.giroDiCoda();
    assert.equal(finta.ricevuti.length, primoGiro + 1);
    await finta.chiudi();
  });

  test('lo scontrino cliente esce solo se la cassa ha una stampante', async () => {
    const finta = stampanteFinta();
    const porta = await finta.ascolta();
    anagrafica.salvaReparto({ id: repartoId, stampante_host: null });
    anagrafica.salvaCassa({ id: cassaId, stampante_host: '127.0.0.1', stampante_porta: porta });

    const o = ordini.creaOrdine({ idemKey: 'scontrino', cassaId, righe: [{ prodottoId, quantita: 2 }] });
    await stampa.giroDiCoda();

    assert.equal(finta.ricevuti.length, 1);
    const testo = finta.ricevuti[0].toString('latin1');
    assert.match(testo, /Documento non fiscale/);
    // 2 salamelle da 4,00 = 8,00
    assert.match(testo, /8,00/);
    assert.match(testo, new RegExp(`N\\. ${o.numero}`));
    await finta.chiudi();
  });
});
