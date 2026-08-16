/*
 * Controllo di compatibilita' del browser.
 *
 * ATTENZIONE: questo file NON e' un modulo ed e' scritto apposta in JavaScript
 * vecchio stile. Deve poter essere letto anche da un browser troppo vecchio per
 * capire il resto del programma: se usasse sintassi moderna morirebbe prima di
 * riuscire a dire che il browser e' troppo vecchio.
 *
 * Serve perche' un browser datato non da' nessun errore visibile: ignora gli
 * script "type=module" e lascia la pagina bianca. Un volontario davanti a uno
 * schermo vuoto non ha modo di capire cosa fare.
 */
(function () {
  'use strict';

  var mancanti = [];

  if (typeof window.fetch !== 'function') mancanti.push('fetch');
  if (typeof window.Promise !== 'function') mancanti.push('Promise');
  if (typeof Element === 'undefined' || !Element.prototype.replaceChildren) {
    mancanti.push('replaceChildren');
  }
  // La sintassi moderna non si puo' provare con un "if": va compilata a parte,
  // altrimenti sarebbe questo file a non farsi leggere.
  try {
    new Function('var f = function (a) { return a?.b ?? 1; };');
  } catch (e) {
    mancanti.push('sintassi moderna');
  }

  if (mancanti.length === 0) return;

  function avvisa() {
    document.body.innerHTML = ''
      + '<div style="max-width:640px;margin:12vh auto;padding:28px;'
      + 'font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.6;'
      + 'color:#f5efe6;background:#1f1b17;border:1px solid #3a322a;border-radius:10px">'
      + '<h1 style="margin:0 0 12px;font-size:1.4rem;color:#d98324">Browser troppo vecchio</h1>'
      + '<p style="margin:0 0 14px">Questo computer non puo\' aprire la cassa con il browser '
      + 'che sta usando adesso. Non e\' un problema del programma ne\' del PC.</p>'
      + '<p style="margin:0 0 14px"><strong>Cosa fare:</strong> installa Google Chrome '
      + '(oppure Microsoft Edge) e riapri questa pagina da li\'. Vanno bene anche '
      + 'versioni di qualche anno fa.</p>'
      + '<p style="margin:0;color:#a89a89;font-size:0.9rem">Dettaglio tecnico, se serve: '
      + 'mancano ' + mancanti.join(', ') + '.</p>'
      + '</div>';
  }

  if (document.body) avvisa();
  else document.addEventListener('DOMContentLoaded', avvisa);
})();
