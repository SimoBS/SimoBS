import { db, adesso, inTransazione } from './db.js';
import { config } from './config.js';
import { serataAperta } from './anagrafica.js';
import { scaricaPerOrdine } from './magazzino.js';
import { accoda, comandaReparto, comandaStorno, scontrinoCliente } from './stampa.js';

export class ErroreOrdine extends Error {}

const leggiOrdine = (id) => db.prepare('SELECT * FROM ordini WHERE id = ?').get(id);
const leggiRighe = (ordineId) => db.prepare(`
  SELECT r.*, p.nome_comanda
  FROM righe r LEFT JOIN prodotti p ON p.id = r.prodotto_id
  WHERE r.ordine_id = ? ORDER BY r.id
`).all(ordineId);

export function dettaglioOrdine(id) {
  const ordine = leggiOrdine(id);
  if (!ordine) return null;
  return { ...ordine, righe: leggiRighe(id) };
}

export function ultimiOrdini({ serataId, limite = 40 }) {
  return db.prepare(`
    SELECT o.*, c.nome AS cassa
    FROM ordini o JOIN casse c ON c.id = o.cassa_id
    WHERE o.serata_id = ?
    ORDER BY o.id DESC LIMIT ?
  `).all(serataId, limite);
}

/**
 * Accoda i documenti di un ordine. Un reparto senza stampante configurata viene
 * saltato di proposito: è una scelta di allestimento (il bar che serve al banco
 * non ha bisogno di comande), non un errore da segnalare tutta la sera.
 */
function accodaDocumentiOrdine({ ordine, righe, serata, cassa }) {
  const reparti = db.prepare('SELECT * FROM reparti WHERE attivo = 1').all();
  for (const reparto of reparti) {
    const sue = righe.filter((r) => r.reparto_id === reparto.id);
    if (sue.length === 0 || !reparto.stampante_host) continue;
    accoda({
      ordineId: ordine.id,
      destinazioneTipo: 'reparto',
      destinazioneId: reparto.id,
      tipo: 'comanda',
      descrizione: `Comanda n. ${ordine.numero} - ${reparto.nome}`,
      documento: comandaReparto({ ordine, righe: sue, reparto, cassa }),
    });
  }

  if (config.scontrinoCliente && cassa?.stampante_host) {
    accoda({
      ordineId: ordine.id,
      destinazioneTipo: 'cassa',
      destinazioneId: cassa.id,
      tipo: 'scontrino',
      descrizione: `Scontrino n. ${ordine.numero}`,
      documento: scontrinoCliente({ ordine, righe, serata, cassa }),
    });
  }
}

/**
 * Registra una vendita.
 *
 * Ordine, righe, scarico magazzino e messa in coda delle stampe stanno tutti
 * nella stessa transazione: non esiste uno stato in cui la cucina ha la comanda
 * ma l'incasso non è stato registrato, o viceversa.
 *
 * I prezzi arrivano SEMPRE dal database, mai dal client: la cassa manda solo
 * quali prodotti e quante unità.
 */
export function creaOrdine(dati) {
  const { idemKey, cassaId, righe } = dati;

  if (!idemKey) throw new ErroreOrdine('idemKey mancante');
  if (!Array.isArray(righe) || righe.length === 0) throw new ErroreOrdine('ordine senza righe');

  // Idempotenza: la cassa che ritenta dopo un timeout di rete non deve
  // incassare due volte. Fuori transazione perché è il caso più frequente.
  const esistente = db.prepare('SELECT id FROM ordini WHERE idem_key = ?').get(idemKey);
  if (esistente) return { ...dettaglioOrdine(esistente.id), duplicato: true };

  return inTransazione(() => {
    const serata = serataAperta();
    if (!serata) throw new ErroreOrdine('nessuna serata aperta: aprine una dal pannello di gestione');

    const cassa = db.prepare('SELECT * FROM casse WHERE id = ?').get(cassaId);
    if (!cassa) throw new ErroreOrdine('cassa inesistente');

    const prendiProdotto = db.prepare('SELECT * FROM prodotti WHERE id = ?');
    const daScrivere = [];
    let lordo = 0;

    for (const r of righe) {
      const quantita = Number(r.quantita);
      if (!Number.isInteger(quantita) || quantita <= 0) {
        throw new ErroreOrdine(`quantità non valida per il prodotto ${r.prodottoId}`);
      }
      const p = prendiProdotto.get(r.prodottoId);
      if (!p) throw new ErroreOrdine(`prodotto ${r.prodottoId} inesistente`);
      lordo += p.prezzo_cent * quantita;
      daScrivere.push({
        prodotto_id: p.id,
        nome: p.nome,
        nome_comanda: p.nome_comanda,
        reparto_id: p.reparto_id,
        prezzo_cent: p.prezzo_cent,
        quantita,
        nota: String(r.nota ?? '').slice(0, 120),
      });
    }

    const sconto = Math.max(0, Math.round(Number(dati.scontoCent ?? 0)));
    if (sconto > lordo) throw new ErroreOrdine('lo sconto supera il totale');

    const numero = db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ordini WHERE serata_id = ?')
      .get(serata.id).n;

    const info = db.prepare(`
      INSERT INTO ordini
        (serata_id, cassa_id, numero, ts, totale_cent, sconto_cent,
         pagamento, operatore, coperti, nota, idem_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      serata.id,
      cassa.id,
      numero,
      adesso(),
      lordo - sconto,
      sconto,
      String(dati.pagamento ?? 'contanti'),
      String(dati.operatore ?? '').slice(0, 60),
      Math.max(0, Math.round(Number(dati.coperti ?? 0))),
      String(dati.nota ?? '').slice(0, 200),
      idemKey,
    );
    const ordineId = Number(info.lastInsertRowid);

    const insRiga = db.prepare(`
      INSERT INTO righe (ordine_id, prodotto_id, nome, reparto_id, prezzo_cent, quantita, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of daScrivere) {
      insRiga.run(ordineId, r.prodotto_id, r.nome, r.reparto_id, r.prezzo_cent, r.quantita, r.nota);
    }

    scaricaPerOrdine(ordineId, daScrivere, -1);

    const ordine = leggiOrdine(ordineId);
    accodaDocumentiOrdine({ ordine, righe: daScrivere, serata, cassa });

    return { ...ordine, righe: leggiRighe(ordineId), duplicato: false };
  });
}

/**
 * Storno di un ordine sbagliato. Ricarica le scorte e manda ai reparti una
 * comanda di ANNULLAMENTO: se la salamella è già sulla griglia, il cuoco deve
 * saperlo, non scoprirlo a fine serata guardando i report.
 */
export function annullaOrdine(id, motivo = '') {
  return inTransazione(() => {
    const ordine = leggiOrdine(id);
    if (!ordine) throw new ErroreOrdine('ordine inesistente');
    if (ordine.annullato) return { ...ordine, righe: leggiRighe(id), giaAnnullato: true };

    const righe = leggiRighe(id);
    db.prepare('UPDATE ordini SET annullato = 1, annullato_il = ?, nota = ? WHERE id = ?')
      .run(adesso(), motivo ? `${ordine.nota} [storno: ${motivo}]`.trim() : ordine.nota, id);

    scaricaPerOrdine(id, righe, +1);

    const cassa = db.prepare('SELECT * FROM casse WHERE id = ?').get(ordine.cassa_id);
    const reparti = db.prepare('SELECT * FROM reparti WHERE attivo = 1').all();
    for (const reparto of reparti) {
      const sue = righe.filter((r) => r.reparto_id === reparto.id);
      if (sue.length === 0 || !reparto.stampante_host) continue;
      accoda({
        ordineId: id,
        destinazioneTipo: 'reparto',
        destinazioneId: reparto.id,
        tipo: 'storno',
        descrizione: `ANNULLA n. ${ordine.numero} - ${reparto.nome}`,
        documento: comandaStorno({ ordine, righe: sue, reparto, cassa, motivo }),
      });
    }

    return { ...leggiOrdine(id), righe, giaAnnullato: false };
  });
}
