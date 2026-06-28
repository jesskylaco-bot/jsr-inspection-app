# Johnson Signature Realty — Property Inspection Report

A production-ready, mobile-first web app for completing property inspections in
the field. Inspectors fill out the form, attach photos, and submit — the
existing Google Apps Script backend then generates a branded PDF report, saves
it to Drive, and returns the link.

Built with plain **HTML5 + CSS3 + vanilla JavaScript (ES6)** for the frontend,
plus a tiny **Netlify Function** that proxies requests to the backend so the
browser never hits a CORS wall. No frameworks, no npm packages.

---

## Why the proxy?

Browsers block direct calls from your site to the Apps Script Web App
(`script.google.com`) because of CORS. The fix: the frontend calls a Netlify
Function on its **own origin** (no CORS), and that function — running
server-side, where CORS rules don't apply — forwards the request to Apps Script
and returns the response.

```
Browser ──(same-origin)──▶ /.netlify/functions/inspection ──(server-side)──▶ Apps Script /exec
        ◀──── JSON ───────                                ◀──── JSON ────────
```

The Apps Script backend is **not modified**.

---

## Folder structure

```
inspection-app/
├── assets/
│   ├── logo.png            (you provide — header logo, optional)
│   ├── favicon.ico         (you provide — tab icon, optional)
│   └── README.txt
├── netlify/
│   └── functions/
│       └── inspection.js   the proxy (forwards GET + POST to Apps Script)
├── netlify.toml            tells Netlify where the site + functions live
├── index.html              markup: form, accordion sections, overlays
├── styles.css              navy/gold luxury-minimal styling, mobile-first
├── script.js               all logic: load, search, validate, submit, photos
├── config.js               the proxy path (frontend → function)
└── README.md               this file
```

---

## How it works

1. On load, the frontend calls `/.netlify/functions/inspection?action=getProperties`.
   The function relays it to Apps Script and returns the property list, which
   fills the searchable dropdown.
2. The inspector completes the sections (Property Info → Photos). Progress
   updates live; only one section is open at a time.
3. On **Submit Report**, the app validates required fields, compresses photos,
   and POSTs the JSON payload to the function, which relays it to Apps Script.
4. Apps Script returns an Inspection ID and a PDF link. The app shows a success
   screen and opens the PDF.

**Required fields:** Property, Inspection Date, Inspector Name, Email, Roof
Condition. (Email is required because the backend rejects submissions without
it.)

---

## How to replace the logo

1. Save your logo as `logo.png`.
2. Drop it into the `assets/` folder, replacing the placeholder.
3. The header loads `assets/logo.png` automatically (max height 100px). If it's
   missing, a "Company Logo" text fallback shows instead — the app never breaks.

Optionally add `favicon.ico` to `assets/` for the browser-tab icon.

---

## How to deploy to Netlify

Because the app now includes a serverless function, use one of the two
function-aware methods below. (Plain folder drag-and-drop publishes the static
files but may skip the function.)

**Option A — Netlify CLI (most reliable for functions)**
```bash
npm install -g netlify-cli      # one time
cd inspection-app
netlify deploy --prod
```
The CLI bundles the function and gives you a live URL. Accept the prompts
(create/link a site, publish directory `.`).

**Option B — connect a Git repo (best for ongoing updates)**
1. Push `inspection-app` to a GitHub/GitLab repo.
2. In Netlify: **Add new site → Import an existing project** → pick the repo.
3. `netlify.toml` already sets publish (`.`) and functions (`netlify/functions`),
   so leave the build command blank. Deploy.
4. Future pushes redeploy automatically.

No environment variables are required — the Apps Script URL is baked into the
function. (You can override it with an `APPS_SCRIPT_URL` env var in Netlify if
you ever redeploy a new Apps Script deployment.)

---

## Local testing

The submit/property calls depend on the function, so use the Netlify dev server
(plain `python -m http.server` won't run functions):

```bash
npm install -g netlify-cli
cd inspection-app
netlify dev
# opens http://localhost:8888 with the function live at
# http://localhost:8888/.netlify/functions/inspection
```

---

## Backend notes (for whoever maintains the Apps Script)

The function forwards to the backend, which is expected to:

- **GET `?action=getProperties`** → return
  `{ "success": true, "properties": [ { "property": "...", "city": "...", "state": "...", "zip": "..." }, ... ] }`
  (a plain array of strings also works).
- **POST** a JSON body (relayed as `text/plain`) containing all form fields plus
  a `photos` object bucketed as
  `{ exterior:[], kitchen:[], bathroom:[], utility:[], roof:[], general:[] }`,
  where each photo is `{ blob: "<base64>", mimeType: "...", name: "..." }`.
- Return `{ "success": true, "inspectionId": "...", "pdfUrl": "...", "property": "...", "inspectionDate": "..." }`.

Field names match the backend's `testData` map (e.g. `inspectorPhone`, `leaks`,
`waterTankAge`, and `appliances` as a single joined string).

---

## Troubleshooting

**The property dropdown is empty / "Could not load the property list."**
- Hit `https://YOUR-SITE.netlify.app/.netlify/functions/inspection?action=getProperties`
  in a browser. You should see the `properties` JSON.
  - If you get a **404**, the function didn't deploy — redeploy via the CLI or
    Git method above (drag-and-drop can skip functions).
  - If you get the Apps Script **health-check JSON** instead of properties, the
    Apps Script wasn't redeployed with `getProperties`: **Deploy → Manage
    deployments → ✏️ edit → Version: New version → Deploy.**
- Until it's fixed, inspectors can type the address manually, so submissions
  still work.

**The report saves with a blank or wrong property.**
- The app sends the **street** as the property value by default. If your backend
  matches on the full address instead, open `script.js`, set
  `SUBMIT_FULL_ADDRESS = true` (near the top), and redeploy. That's the only fix.

**Submit fails / "Proxy error" or "unexpected response."**
- Confirm the Apps Script deployment access is **"Anyone"** (not "Anyone with a
  Google account") — field inspectors won't be signed in.
- Confirm the `APPS_SCRIPT_URL` inside `netlify/functions/inspection.js` ends in
  `/exec` (not `/dev`).

**Submit fails only when there are many/large photos.**
- Netlify synchronous functions cap the request payload at ~6 MB. Photos are
  auto-compressed (1600px / 70% JPEG ≈ 200–400 KB each), so a handful is fine,
  but ~15+ large photos can exceed the limit. Lower `PHOTO_MAX_DIM` /
  `PHOTO_QUALITY` in `script.js`, or submit fewer photos per inspection.

**The PDF doesn't auto-download.**
- Expected on most browsers — Drive PDFs are cross-origin, so the app opens the
  PDF in a new tab. If a popup blocker stops it, the **Open PDF** button on the
  success screen always works.

**Function returns 502 / Node error.**
- The function uses the built-in global `fetch` (Node 18+). `netlify.toml`
  already pins `NODE_VERSION = "18"`; if you changed it, keep it ≥ 18.
