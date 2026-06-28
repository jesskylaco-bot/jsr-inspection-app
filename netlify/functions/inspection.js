/* =================================================================
   Netlify Function — Apps Script proxy
   netlify/functions/inspection.js

   Purpose: the browser cannot call the Google Apps Script Web App
   directly (CORS). This function runs server-side (no CORS rules),
   forwards the request to Apps Script, and returns the response to
   the frontend — which calls THIS function at the same origin.

   Handles:
     GET   /.netlify/functions/inspection?action=getProperties
     POST  /.netlify/functions/inspection   (inspection submission)

   The Apps Script backend is NOT modified. Its /exec URL lives here
   (override with the APPS_SCRIPT_URL environment variable if you wish).

   Runtime: Node 18+ (uses the built-in global fetch). No npm packages.
   ================================================================= */

const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbx9CkLyezIT-GbBV34ApEGQtOQnAHGcQ5kgvzIf-L_7qT1KBz3RAjQcebiZ1WgW3TR6/exec';

// Permissive CORS headers. The frontend is same-origin so these aren't
// strictly required, but they make the proxy safe to call from anywhere
// (e.g. local testing) and never hurt.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  // ── CORS preflight ──────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    let targetUrl = APPS_SCRIPT_URL;
    const fetchOptions = { method: event.httpMethod, redirect: 'follow' };

    if (event.httpMethod === 'GET') {
      // Forward the query string (e.g. ?action=getProperties) verbatim.
      const qs =
        event.rawQuery ||
        (event.queryStringParameters
          ? new URLSearchParams(event.queryStringParameters).toString()
          : '');
      if (qs) targetUrl += (targetUrl.includes('?') ? '&' : '?') + qs;

    } else if (event.httpMethod === 'POST') {
      // Forward the raw body. The frontend sends JSON as text/plain;
      // we relay it the same way so Apps Script reads e.postData.contents.
      let body = event.body || '';
      if (event.isBase64Encoded) {
        body = Buffer.from(body, 'base64').toString('utf-8');
      }
      fetchOptions.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      fetchOptions.body = body;

    } else {
      return {
        statusCode: 405,
        headers: JSON_HEADERS,
        body: JSON.stringify({ success: false, error: 'Method not allowed' }),
      };
    }

    // Forward to Apps Script. Apps Script answers with a 302 redirect to
    // its content host; fetch follows it and returns the final JSON.
    const upstream = await fetch(targetUrl, fetchOptions);
    const text = await upstream.text();

    return {
      statusCode: upstream.status,
      headers: JSON_HEADERS,
      body: text,
    };

  } catch (err) {
    return {
      statusCode: 502,
      headers: JSON_HEADERS,
      body: JSON.stringify({ success: false, error: 'Proxy error: ' + err.message }),
    };
  }
};
