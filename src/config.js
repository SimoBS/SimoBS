import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RADICE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CARTELLA_DATI = process.env.SIMOBS_DATI
  ? resolve(process.env.SIMOBS_DATI)
  : join(RADICE, 'dati');

const PERCORSO_CONFIG = join(CARTELLA_DATI, 'config.json');

const PREDEFINITA = {
  nomeFesta: 'Festa della Birra',
  porta: 8080,
  // Caratteri stampabili per riga: 48 per la carta da 80mm, 32 per la 58mm.
  colonneStampante: 48,
  // Larghezza fisica della carta in millimetri. Serve solo agli scontrini
  // stampati dal browser sulla termica collegata al PC della cassa: da qui
  // si calcola il corpo del carattere perché le colonne cadano allineate.
  larghezzaCartaMm: 80,
  // Ogni quanti millisecondi la coda ritenta le stampe non riuscite.
  intervalloCodaStampaMs: 2000,
  // Dopo quanti tentativi falliti una stampa smette di ritentare da sola
  // e resta in attesa di ristampa manuale.
  tentativiMassimiStampa: 60,
  // Timeout di connessione alla stampante termica.
  timeoutStampanteMs: 4000,
  // Stampa anche uno scontrino di cortesia per il cliente oltre alle comande.
  scontrinoCliente: true,
};

function caricaConfig() {
  mkdirSync(CARTELLA_DATI, { recursive: true });
  if (!existsSync(PERCORSO_CONFIG)) {
    writeFileSync(PERCORSO_CONFIG, JSON.stringify(PREDEFINITA, null, 2) + '\n');
    return { ...PREDEFINITA };
  }
  try {
    const letta = JSON.parse(readFileSync(PERCORSO_CONFIG, 'utf8'));
    return { ...PREDEFINITA, ...letta };
  } catch (err) {
    console.error(`config.json illeggibile (${err.message}), uso i valori predefiniti.`);
    return { ...PREDEFINITA };
  }
}

export const config = caricaConfig();

export function salvaConfig(modifiche) {
  Object.assign(config, modifiche);
  writeFileSync(PERCORSO_CONFIG, JSON.stringify(config, null, 2) + '\n');
  return config;
}
