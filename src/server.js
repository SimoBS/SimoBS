import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import os from 'node:os';
import { RADICE, config } from './config.js';
import { trovaRotta, ErroreRichiesta, ErroreOrdine, ErroreScansione } from './api.js';
import { avviaCodaStampa, fermaCodaStampa } from './stampa.js';

const CARTELLA_WEB = join(RADICE, 'web');

const TIPI = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const LIMITE_CORPO = 1_000_000;

function leggiCorpo(req) {
  return new Promise((risolvi, rifiuta) => {
    const pezzi = [];
    let lunghezza = 0;
    req.on('data', (c) => {
      lunghezza += c.length;
      if (lunghezza > LIMITE_CORPO) {
        rifiuta(new ErroreRichiesta('richiesta troppo grande', 413));
        req.destroy();
        return;
      }
      pezzi.push(c);
    });
    req.on('end', () => {
      const grezzo = Buffer.concat(pezzi).toString('utf8');
      if (!grezzo) return risolvi({});
      try {
        risolvi(JSON.parse(grezzo));
      } catch {
        rifiuta(new ErroreRichiesta('corpo della richiesta non è JSON valido'));
      }
    });
    req.on('error', rifiuta);
  });
}

function json(res, stato, dati) {
  const corpo = JSON.stringify(dati);
  res.writeHead(stato, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store',
  });
  res.end(corpo);
}

async function serviStatico(res, percorso) {
  const relativo = percorso === '/' ? 'cassa.html' : percorso.slice(1);
  // Difesa contro il path traversal: il file risolto deve restare dentro web/.
  const assoluto = normalize(join(CARTELLA_WEB, relativo));
  if (!assoluto.startsWith(CARTELLA_WEB + sep)) {
    return json(res, 403, { errore: 'percorso non consentito' });
  }
  try {
    const contenuto = await readFile(assoluto);
    res.writeHead(200, {
      'Content-Type': TIPI[extname(assoluto)] ?? 'application/octet-stream',
      'Content-Length': contenuto.length,
      // Niente cache: durante la festa si aggiorna il menu e si preme F5.
      'Cache-Control': 'no-store',
    });
    res.end(contenuto);
  } catch {
    json(res, 404, { errore: 'non trovato' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const percorso = url.pathname;

  try {
    if (!percorso.startsWith('/api/')) {
      if (req.method !== 'GET') return json(res, 405, { errore: 'metodo non consentito' });
      return await serviStatico(res, percorso);
    }

    const trovata = trovaRotta(req.method, percorso);
    if (!trovata) return json(res, 404, { errore: `rotta sconosciuta: ${req.method} ${percorso}` });

    const corpo = req.method === 'GET' || req.method === 'DELETE' ? {} : await leggiCorpo(req);
    const risultato = await trovata.gestore({
      corpo,
      query: url.searchParams,
      parametri: trovata.parametri,
    });

    // Alcune rotte (CSV) restituiscono un corpo già formato.
    if (risultato && risultato._grezzo) {
      res.writeHead(200, {
        'Content-Type': risultato.tipoContenuto,
        'Cache-Control': 'no-store',
        ...risultato.intestazioni,
      });
      return res.end(risultato.corpo);
    }

    json(res, 200, risultato ?? {});
  } catch (err) {
    if (err instanceof ErroreRichiesta) return json(res, err.stato, { errore: err.message });
    if (err instanceof ErroreOrdine) return json(res, 400, { errore: err.message });
    // Una lettura sbagliata della pistola è un fatto normale della serata,
    // non un guasto: torna alla postazione come messaggio, non come errore 500.
    if (err instanceof ErroreScansione) return json(res, 400, { errore: err.message });
    console.error(`errore su ${req.method} ${percorso}:`, err);
    json(res, 500, { errore: err.message ?? 'errore interno' });
  }
});

function indirizziLocali() {
  const trovati = [];
  for (const schede of Object.values(os.networkInterfaces())) {
    for (const s of schede ?? []) {
      if (s.family === 'IPv4' && !s.internal) trovati.push(s.address);
    }
  }
  return trovati;
}

avviaCodaStampa();

server.listen(config.porta, '0.0.0.0', () => {
  const indirizzi = indirizziLocali();
  console.log('');
  console.log(`  ${config.nomeFesta} — SimoBS avviato`);
  console.log('');
  console.log('  Apri il browser sulle casse a uno di questi indirizzi:');
  for (const ip of indirizzi) console.log(`      http://${ip}:${config.porta}`);
  if (indirizzi.length === 0) {
    console.log('      (nessuna rete rilevata) http://localhost:' + config.porta);
  }
  console.log('');
  console.log('  Su questo PC:  http://localhost:' + config.porta);
  console.log('  Gestione:      /gestione.html      Report: /report.html');
  console.log('');
  console.log('  Per fermare tutto: chiudi questa finestra oppure premi Ctrl+C.');
  console.log('');
});

for (const segnale of ['SIGINT', 'SIGTERM']) {
  process.on(segnale, () => {
    console.log('\nChiusura in corso...');
    fermaCodaStampa();
    server.close(() => process.exit(0));
    // Se qualche connessione resta appesa, non teniamo in ostaggio l'operatore.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
