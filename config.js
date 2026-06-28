/* =================================================================
   Johnson Signature Realty — Property Inspection Report
   config.js

   The frontend now calls a same-origin Netlify Function PROXY instead
   of the Apps Script Web App directly. That is what fixes the CORS
   errors: the browser only ever talks to its own origin, and the
   function (server-side) relays to Apps Script.

   WEB_APP_URL below is the PROXY path — do not change it unless you
   rename the function file.

   The real Apps Script /exec URL lives inside the Netlify Function at
   netlify/functions/inspection.js (or set the APPS_SCRIPT_URL env var
   in Netlify → Site settings → Environment variables).
   ================================================================= */
const CONFIG = {
  WEB_APP_URL: '/.netlify/functions/inspection',
};
