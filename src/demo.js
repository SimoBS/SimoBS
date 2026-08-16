/**
 * Genera una serata finta, per vedere il sistema in funzione da soli.
 *
 *   node --no-warnings src/demo.js         una trentina di ordini
 *   node --no-warnings src/demo.js 80      quanti ne vuoi
 *   node --no-warnings src/demo.js 30 --forza   anche su dati veri (sconsigliato)
 *
 * Serve a provare cassa, postazioni e monitor senza avere quattro volontari e
 * due stampanti: crea ordini sparsi nell'ultima ora e mezza, misti fra tavolo,
 * self service e asporto, e li porta a punti diversi della lavorazione. Così i
 * monitor hanno qualcosa da mostrare e le code non sono vuote.
 *
 * Gli ordini generati portano la nota [demo] e si riconoscono: lo script si
 * rifiuta di girare se nella serata aperta ci sono ordini veri.
 */
import { db, adesso } from './db.js';
import { serataAperta } from './anagrafica.js';
import { creaOrdine } from './ordini.js';
import { avanza } from './avanzamento.js';
import { config } from './config.js';

const MARCA = '[demo]';
const quanti = Number(process.argv[2]) || 30;
const forza = process.argv.includes('--forza');

const serata = serataAperta();
if (!serata) {
  console.error('Nessuna serata aperta: aprine una da /gestione.html, poi rilancia.');
  process.exit(1);
}

const veri = db.prepare(
  `SELECT COUNT(*) AS n FROM ordini WHERE serata_id = ? AND nota NOT LIKE ?`,
).get(serata.id, `%${MARCA}%`).n;

if (veri > 0 && !forza) {
  console.error(`La serata "${serata.nome}" contiene ${veri} ordini veri: non ci scrivo sopra.`);
  console.error('Apri una serata nuova per le prove, oppure usa --forza se sai cosa stai facendo.');
  process.exit(1);
}

const prodotti = db.prepare('SELECT id, reparto_id FROM prodotti WHERE attivo = 1').all();
const casse = db.prepare('SELECT id FROM casse WHERE attiva = 1').all();
if (prodotti.length === 0 || casse.length === 0) {
  console.error('Mancano prodotti o casse: lancia prima "node --no-warnings src/seed.js".');
  process.exit(1);
}

// Generatore deterministico: due esecuzioni danno la stessa serata, così se
// una schermata sembra sbagliata la si può riguardare identica.
let seme = 20260815;
const caso = () => {
  seme = (seme * 1103515245 + 12345) % 2147483648;
  return seme / 2147483648;
};
const scegli = (v) => v[Math.floor(caso() * v.length)];
const fra = (min, max) => min + Math.floor(caso() * (max - min + 1));

/** Sposta indietro nel tempo un ordine e la sua lavorazione. */
function retrodata(ordineId, minutiFa) {
  const d = new Date(Date.now() - minutiFa * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  db.prepare('UPDATE ordini SET ts = ? WHERE id = ?').run(ts, ordineId);
  db.prepare('UPDATE avanzamento SET preso_il = ? WHERE ordine_id = ? AND preso_il IS NOT NULL')
    .run(ts, ordineId);
  db.prepare('UPDATE avanzamento SET uscito_il = ? WHERE ordine_id = ? AND uscito_il IS NOT NULL')
    .run(ts, ordineId);
}

// L'antirimbalzo servirebbe a distinguere due sparate vere: qui gli stati
// vengono impostati in un colpo solo e va tolto di mezzo.
const antirimbalzoVero = config.secondiAntirimbalzoPistola;
config.secondiAntirimbalzoPistola = 0;

const reparti = db.prepare('SELECT id, nome FROM reparti ORDER BY ordine').all();
const conteggi = { tavolo: 0, self: 0, asporto: 0, completi: 0, inCorso: 0, daFare: 0 };

for (let i = 0; i < quanti; i++) {
  // I più recenti in fondo: la coda deve sembrare una serata vera, con
  // qualche ordine vecchio rimasto indietro e i nuovi appena arrivati.
  const minutiFa = Math.round((1 - i / quanti) * 90);
  const sorte = caso();
  const servizio = sorte < 0.75 ? 'tavolo' : sorte < 0.9 ? 'self' : 'asporto';

  const righe = [];
  for (let r = 0; r < fra(1, 4); r++) {
    righe.push({ prodottoId: scegli(prodotti).id, quantita: fra(1, 3) });
  }

  const ordine = creaOrdine({
    idemKey: `demo-${seme}-${i}`,
    cassaId: scegli(casse).id,
    servizio,
    tavolo: servizio === 'tavolo' ? String(fra(1, 24)) : '',
    coperti: servizio === 'tavolo' ? fra(1, 6) : 0,
    operatore: scegli(['Anna', 'Marco', 'Giulia', 'Paolo']),
    pagamento: caso() < 0.8 ? 'contanti' : 'pos',
    nota: MARCA,
    righe,
  });
  conteggi[servizio]++;

  // Più un ordine è vecchio, più è probabile che sia già stato evaso.
  const avanzamentoDesiderato = caso() * (minutiFa / 90) * 1.6;
  const suoi = reparti.filter((rep) => ordine.righe.some((r) => r.reparto_id === rep.id));

  if (avanzamentoDesiderato > 0.75) {
    for (const rep of suoi) {
      avanza({ ordineId: ordine.id, repartoId: rep.id });
      avanza({ ordineId: ordine.id, repartoId: rep.id });
    }
    conteggi.completi++;
  } else if (avanzamentoDesiderato > 0.4) {
    // Il bar lavora per primo: è la regola della casa, e così i monitor
    // mostrano il caso interessante, cioè la cucina sbloccata dal bar.
    const [primo] = [...suoi].reverse();
    if (primo) {
      avanza({ ordineId: ordine.id, repartoId: primo.id });
      avanza({ ordineId: ordine.id, repartoId: primo.id });
    }
    conteggi.inCorso++;
  } else if (avanzamentoDesiderato > 0.2 && suoi.length > 0) {
    avanza({ ordineId: ordine.id, repartoId: scegli(suoi).id });
    conteggi.inCorso++;
  } else {
    conteggi.daFare++;
  }

  retrodata(ordine.id, minutiFa);
}

config.secondiAntirimbalzoPistola = antirimbalzoVero;

console.log(`serata di prova generata su "${serata.nome}" (${adesso().slice(11, 16)})`);
console.log(`  ${quanti} ordini: ${conteggi.tavolo} al tavolo, ${conteggi.self} self, ${conteggi.asporto} asporto`);
console.log(`  ${conteggi.completi} completi, ${conteggi.inCorso} in lavorazione, ${conteggi.daFare} ancora da fare`);
console.log('');
console.log('Ora avvia il server e apri:');
console.log(`  http://localhost:${config.porta}/monitor.html?reparto=Cucina`);
console.log(`  http://localhost:${config.porta}/reparto.html`);
console.log(`  http://localhost:${config.porta}/report.html`);
console.log('');
console.log('Per ripulire: node --no-warnings src/seed.js --reset');
