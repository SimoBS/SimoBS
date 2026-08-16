import net from 'node:net';
import { db, adesso } from './db.js';
import { config } from './config.js';
import { Documento, versoEscPos, versoTesto } from './escpos.js';

/** Centesimi -> "12,50". Tutti gli importi girano come interi, mai come float. */
export function euro(centesimi) {
  const segno = centesimi < 0 ? '-' : '';
  const v = Math.abs(centesimi);
  return `${segno}${Math.floor(v / 100)},${String(v % 100).padStart(2, '0')}`;
}

function oraDi(ts) {
  return String(ts).slice(11, 16);
}

function fraSecondi(secondi) {
  const d = new Date(Date.now() + secondi * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Modelli di stampa
// ---------------------------------------------------------------------------

/**
 * Comanda di reparto: quella che il cuoco legge di corsa, di sera, sotto una
 * lampada. Nessun prezzo, numero enorme, quantità e prodotto a corpo doppio.
 */
/** "TAVOLO 12", "ASPORTO" o "SELF SERVICE": la destinazione del vassoio. */
export function destinazione(ordine) {
  if (ordine.servizio === 'asporto') return 'ASPORTO';
  if (ordine.servizio === 'self') return 'SELF SERVICE';
  return `TAVOLO ${ordine.tavolo}`;
}

export function comandaReparto({ ordine, righe, reparto, cassa, altriReparti = [] }) {
  const doc = new Documento(config.colonneStampante);
  doc.titolo(reparto.nome.toUpperCase());
  doc.separatore('=');
  // Il tavolo prima e più grande del numero d'ordine: è quello che legge il
  // cameriere quando prende il vassoio, ed è l'unica cosa che gli dice dove
  // portarlo. Il numero d'ordine serve solo a ritrovare la comanda.
  if (ordine.servizio === 'tavolo') {
    doc.testo(`TAVOLO ${ordine.tavolo}`, { size: 3, align: 'center', bold: true });
    if (ordine.coperti > 0) doc.testo(`${ordine.coperti} coperti`, { align: 'center' });
  } else {
    // Senza tavolo il cliente ritira al banco e viene chiamato per numero:
    // allora è il numero a dover essere leggibile da lontano, non la parola.
    doc.testo(ordine.servizio === 'asporto' ? 'DA ASPORTO' : 'SELF SERVICE',
      { size: 2, align: 'center', bold: true });
    doc.testo(`N. ${ordine.numero}`, { size: 3, align: 'center', bold: true });
    // L'asporto non è solo un modo di pagare: si prepara diversamente, nei
    // contenitori invece che nel piatto. Chi monta il vassoio deve saperlo.
    if (ordine.servizio === 'asporto') {
      doc.testo('>> PREPARA DA PORTARE VIA <<', { align: 'center', bold: true });
    }
  }

  // Se per questo tavolo esce anche un altro vassoio, chi monta questo deve
  // saperlo dalla carta, senza andare a guardare uno schermo: è quello che
  // decide se il vassoio parte subito o aspetta il bar. Una comanda che
  // riguarda un reparto solo non ha niente da attendere.
  doc.testo(
    altriReparti.length > 0 ? `ANCHE: ${altriReparti.join(', ').toUpperCase()}` : `SOLO ${reparto.nome.toUpperCase()}`,
    { align: 'center', bold: true },
  );
  doc.separatore('=');
  doc.colonne(`comanda n. ${ordine.numero}`, oraDi(ordine.ts));
  if (cassa?.nome) doc.testo(cassa.nome);
  doc.separatore();
  for (const r of righe) {
    doc.testo(`${r.quantita} x ${r.nome_comanda || r.nome}`, { size: 2, bold: true });
    if (r.nota) doc.testo(`>> ${r.nota}`, { bold: true });
  }
  doc.separatore();
  if (ordine.nota) {
    doc.testo(`NOTA: ${ordine.nota}`, { bold: true });
    doc.separatore();
  }
  // Da leggere con la pistola quando la roba è pronta. Sta in fondo perché è
  // la parte che resta esposta quando la comanda è infilzata sul portacomande.
  doc.codiceABarre(ordine.id);
  doc.testo('1) spara quando prendi in carico', { align: 'center' });
  doc.testo('2) spara quando esce il vassoio', { align: 'center' });
  doc.spazio(1);
  doc.taglio();
  return doc;
}

/**
 * Comanda di annullamento. Volutamente sgraziata e piena di asterischi: deve
 * essere impossibile scambiarla per una comanda normale in mezzo alle altre.
 */
export function comandaStorno({ ordine, righe, reparto, cassa, motivo }) {
  const doc = new Documento(config.colonneStampante);
  doc.separatore('*');
  doc.titolo('ANNULLATO');
  doc.separatore('*');
  doc.testo(reparto.nome.toUpperCase(), { align: 'center', bold: true });
  doc.testo(destinazione(ordine), { size: 2, align: 'center', bold: true });
  doc.testo(`n. ${ordine.numero}`, { align: 'center' });
  doc.separatore('=');
  doc.testo('NON PREPARARE:', { bold: true });
  for (const r of righe) {
    doc.testo(`${r.quantita} x ${r.nome_comanda || r.nome}`, { size: 2, bold: true });
  }
  doc.separatore();
  if (motivo) doc.testo(`Motivo: ${motivo}`);
  doc.colonne(cassa?.nome ?? '', oraDi(adesso()));
  doc.separatore('*');
  doc.spazio(1);
  doc.taglio();
  return doc;
}

/**
 * Scontrino di cortesia per il cliente. Non è un documento fiscale: serve
 * a farsi consegnare la roba al banco e a controllare il conto.
 */
export function scontrinoCliente({ ordine, righe, serata, cassa }) {
  const doc = new Documento(config.colonneStampante);
  doc.titolo(config.nomeFesta);
  doc.testo(serata.nome, { align: 'center' });
  doc.separatore('=');
  doc.testo(destinazione(ordine), { size: 2, align: 'center', bold: true });
  doc.testo(`N. ${ordine.numero}`, { size: 3, align: 'center', bold: true });
  if (ordine.servizio !== 'tavolo') {
    doc.testo('Attendi che il tuo numero', { align: 'center' });
    doc.testo('compaia sul monitor', { align: 'center' });
  }
  doc.separatore('=');
  for (const r of righe) {
    doc.colonne(`${r.quantita} ${r.nome}`, euro(r.quantita * r.prezzo_cent));
  }
  doc.separatore();
  if (ordine.sconto_cent > 0) {
    const lordo = ordine.totale_cent + ordine.sconto_cent;
    doc.colonne('Parziale', euro(lordo));
    doc.colonne('Sconto', `-${euro(ordine.sconto_cent)}`);
  }
  doc.colonne('TOTALE', euro(ordine.totale_cent), { size: 2, bold: true });
  doc.separatore();
  if (ordine.coperti > 0) doc.testo(`Coperti: ${ordine.coperti}`);
  doc.testo(`${cassa?.nome ?? ''}  ${oraDi(ordine.ts)}  ${ordine.pagamento}`, { align: 'center' });
  // Lo stesso codice della comanda: le postazioni possono leggere anche lo
  // scontrino che porta il cliente, non solo la propria copia.
  doc.codiceABarre(ordine.id);
  doc.testo('Documento non fiscale', { align: 'center' });
  doc.spazio(1);
  doc.taglio();
  return doc;
}

// ---------------------------------------------------------------------------
// Coda persistente
// ---------------------------------------------------------------------------

const inserisciStampa = () => db.prepare(`
  INSERT INTO stampe
    (ordine_id, destinazione_tipo, destinazione_id, tipo, descrizione,
     payload, anteprima, stato, prossimo_tentativo, creata_il)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'in_attesa', ?, ?)
`);

/**
 * Mette un documento in coda di stampa. Va chiamata DENTRO la transazione che
 * salva l'ordine: o si salva tutto (ordine, righe, scarico, stampe) o niente.
 */
export function accoda({ ordineId = null, destinazioneTipo, destinazioneId, tipo, descrizione, documento }) {
  const ora = adesso();
  const info = inserisciStampa().run(
    ordineId,
    destinazioneTipo,
    destinazioneId,
    tipo,
    descrizione,
    versoEscPos(documento),
    versoTesto(documento),
    ora,
    ora,
  );
  return Number(info.lastInsertRowid);
}

function risolviDestinazione(stampa) {
  if (stampa.destinazione_tipo === 'reparto') {
    return db.prepare('SELECT nome, stampante_host AS host, stampante_porta AS porta, copie FROM reparti WHERE id = ?')
      .get(stampa.destinazione_id);
  }
  const cassa = db.prepare('SELECT nome, stampante_host AS host, stampante_porta AS porta FROM casse WHERE id = ?')
    .get(stampa.destinazione_id);
  return cassa ? { ...cassa, copie: 1 } : undefined;
}

/** Invia byte grezzi a una stampante ESC/POS via socket TCP (di norma la 9100). */
export function inviaAllaStampante(host, porta, byte) {
  return new Promise((risolvi, rifiuta) => {
    const socket = net.createConnection({ host, port: porta });
    let concluso = false;
    const chiudi = (err) => {
      if (concluso) return;
      concluso = true;
      socket.destroy();
      err ? rifiuta(err) : risolvi();
    };
    socket.setTimeout(config.timeoutStampanteMs);
    socket.on('timeout', () => chiudi(new Error('timeout: la stampante non risponde')));
    socket.on('error', (err) => chiudi(err));
    socket.on('connect', () => {
      socket.write(byte, (err) => {
        if (err) return chiudi(err);
        // end() aspetta lo svuotamento del buffer di scrittura prima del FIN.
        socket.end();
      });
    });
    socket.on('close', () => chiudi());
  });
}

async function elaboraStampa(stampa) {
  const dest = risolviDestinazione(stampa);
  if (!dest) throw new Error('destinazione di stampa inesistente');
  if (!dest.host) throw new Error(`nessuna stampante configurata per "${dest.nome}"`);
  for (let copia = 0; copia < Math.max(1, dest.copie ?? 1); copia++) {
    await inviaAllaStampante(dest.host, dest.porta ?? 9100, Buffer.from(stampa.payload));
  }
}

let inCorso = false;
let timer = null;

/** Un giro completo della coda. Esportata per poterla pilotare nei test. */
export async function giroDiCoda() {
  if (inCorso) return;
  inCorso = true;
  try {
    const daFare = db.prepare(`
      SELECT * FROM stampe
      WHERE stato = 'in_attesa' AND prossimo_tentativo <= ?
      ORDER BY id
      LIMIT 20
    `).all(adesso());

    for (const stampa of daFare) {
      try {
        await elaboraStampa(stampa);
        db.prepare(`UPDATE stampe SET stato = 'stampata', stampata_il = ?, ultimo_errore = '' WHERE id = ?`)
          .run(adesso(), stampa.id);
      } catch (err) {
        const tentativi = stampa.tentativi + 1;
        const esaurita = tentativi >= config.tentativiMassimiStampa;
        // Backoff progressivo fino a 30s: una stampante staccata non merita
        // un tentativo ogni due secondi per tutta la serata.
        const attesa = Math.min(30, 2 ** Math.min(tentativi, 5));
        db.prepare(`
          UPDATE stampe
          SET tentativi = ?, ultimo_errore = ?, stato = ?, prossimo_tentativo = ?
          WHERE id = ?
        `).run(
          tentativi,
          String(err.message).slice(0, 300),
          esaurita ? 'errore' : 'in_attesa',
          fraSecondi(attesa),
          stampa.id,
        );
        if (esaurita) {
          console.error(`stampa #${stampa.id} sospesa dopo ${tentativi} tentativi: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error('errore nel giro di coda stampa:', err.message);
  } finally {
    inCorso = false;
  }
}

export function avviaCodaStampa() {
  if (timer) return;
  // All'avvio, le stampe rimaste "in_attesa" da una sessione precedente
  // vengono riprese automaticamente: è tutto già su disco.
  const arretrate = db.prepare(`SELECT COUNT(*) AS n FROM stampe WHERE stato = 'in_attesa'`).get().n;
  if (arretrate > 0) console.log(`coda di stampa: ${arretrate} document${arretrate === 1 ? 'o' : 'i'} da recuperare`);
  timer = setInterval(giroDiCoda, config.intervalloCodaStampaMs);
  timer.unref?.();
}

export function fermaCodaStampa() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Rimette in coda una stampa fallita o già uscita (carta inceppata, persa...). */
export function ristampa(id) {
  const info = db.prepare(`
    UPDATE stampe
    SET stato = 'in_attesa', tentativi = 0, ultimo_errore = '', prossimo_tentativo = ?
    WHERE id = ?
  `).run(adesso(), id);
  return info.changes > 0;
}

/** Rimette in coda tutti i documenti di un ordine. */
export function ristampaOrdine(ordineId) {
  const info = db.prepare(`
    UPDATE stampe
    SET stato = 'in_attesa', tentativi = 0, ultimo_errore = '', prossimo_tentativo = ?
    WHERE ordine_id = ?
  `).run(adesso(), ordineId);
  return info.changes;
}

export function statoCoda() {
  const righe = db.prepare(`SELECT stato, COUNT(*) AS n FROM stampe GROUP BY stato`).all();
  const conteggi = { in_attesa: 0, stampata: 0, errore: 0 };
  for (const r of righe) conteggi[r.stato] = r.n;
  const problemi = db.prepare(`
    SELECT s.id, s.tipo, s.descrizione, s.tentativi, s.ultimo_errore, s.creata_il, o.numero
    FROM stampe s LEFT JOIN ordini o ON o.id = s.ordine_id
    WHERE s.stato = 'errore' OR (s.stato = 'in_attesa' AND s.tentativi > 2)
    ORDER BY s.id DESC LIMIT 50
  `).all();
  return { conteggi, problemi };
}

/** Stampa di prova, per verificare una stampante prima di aprire i cancelli. */
export function documentoDiProva(nomeDestinazione) {
  const doc = new Documento(config.colonneStampante);
  doc.titolo('PROVA');
  doc.separatore('=');
  doc.testo(nomeDestinazione, { align: 'center', bold: true, size: 2 });
  doc.separatore();
  doc.testo('Accenti: à è é ì ò ù');
  doc.testo(`Simbolo euro: € ${euro(1250)}`);
  doc.testo(`Larghezza carta: ${config.colonneStampante} colonne`);
  doc.testo('0123456789'.repeat(Math.ceil(config.colonneStampante / 10)).slice(0, config.colonneStampante));
  doc.separatore();
  doc.testo(adesso().replace('T', ' '), { align: 'center' });
  doc.spazio(1);
  doc.taglio();
  return doc;
}
