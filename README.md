# Johnson Signature Realty — Property Inspection Report

A production-ready, mobile-first web app for completing property inspections in
the field. Inspectors fill out the form; photos upload to Drive in the
background, one at a time, the moment they're picked. Submit sends only form
answers and photo file IDs — the Google Apps Script backend then files the
already-uploaded photos into the inspection's folder structure and generates a
branded PDF report that links to the photo folder.

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

---

## Photo upload architecture

Photos are **never** batched into the Submit request. Instead:

1. **Pick → upload immediately.** The instant an inspector selects photos for
   a category (Exterior, Kitchen, Bathroom, Utility, Roof, General), each
   photo is compressed client-side and POSTed individually
   (`action: 'uploadPhoto'`) to a shared **Temp Uploads** folder in Drive. The
   browser keeps only the returned `{ fileId, url }` plus a thumbnail — never
   a backlog of base64 blobs.
2. **Small, capped concurrency.** Uploads run through a queue (2 at a time by
   default — `UPLOAD_CONCURRENCY` in `script.js`) so a 50–200 photo inspection
   never floods a field connection or times out a single huge request.
3. **Per-photo retry.** A failed upload (dropped signal, etc.) is marked
   *failed* with a **Retry** button on its thumbnail — the inspector fixes
   just that photo, not the whole form. Already-uploaded photos persist to
   `localStorage`, so a page reload mid-inspection doesn't lose them.
4. **Submit = metadata only.** `action: 'submit'` sends form answers plus
   `{ category: [{ fileId, name }] } }` — no image bytes. The backend gets or
   creates the property's `Inspection Photos` folder, creates a subfolder per
   category, and **moves** (not re-uploads) each file from Temp Uploads into
   place. The move is idempotent, so pressing Submit again after a partial
   failure safely picks up where it left off.
5. **PDF links, doesn't embed.** The generated PDF includes a `{{PHOTO_LINK}}`
   placeholder linking to the Drive folder instead of embedding every image,
   so report generation stays fast regardless of photo count.

The Apps Script source lives in [`apps-script/`](apps-script/) (`Code.gs`,
`Config.gs`, `Reports.gs`, `Template.gs`, `Utilities.gs`, `PhotoUpload.gs`) —
see "One-time Apps Script setup" below for deployment steps.

---

## Folder structure

```
inspection-app/
├── assets/
│   ├── logo.png            (you provide — header logo, optional)
│   ├── favicon.ico         (you provide — tab icon, optional)
│   └── README.txt
├── apps-script/
│   ├── Code.gs              entry point: doGet/doPost, action routing
│   ├── Config.gs            Drive/Doc/Sheet IDs + placeholder map
│   ├── PhotoUpload.gs       temp upload, idempotent move-on-submit
│   ├── Reports.gs           report generation + PDF export
│   ├── Template.gs          template copy + placeholder replacement
│   └── Utilities.gs         shared helpers (IDs, dates, Drive, logging)
├── netlify/
│   └── functions/
│       └── inspection.js   the proxy (forwards GET + POST to Apps Script)
├── netlify.toml            tells Netlify where the site + functions live
├── index.html              markup: form, accordion sections, overlays
├── styles.css              navy/gold luxury-minimal styling, mobile-first
├── script.js               all logic: load, search, validate, per-photo upload, submit
├── config.js               the proxy path (frontend → function)
└── README.md               this file
```

---

## How it works

1. On load, the frontend calls `/.netlify/functions/inspection?action=getProperties`.
   The function relays it to Apps Script and returns the property list, which
   fills the searchable dropdown.
2. The inspector completes the sections (Property Info → Photos). Progress
   updates live; only one section is open at a time. Photos upload to Drive's
   Temp Uploads folder as soon as they're picked — see "Photo upload
   architecture" above.
3. On **Submit Report**, the app validates required fields, confirms every
   photo finished uploading (blocking submit on anything still uploading or
   failed), and POSTs a small JSON payload — answers + photo file IDs — to the
   function, which relays it to Apps Script.
4. Apps Script moves the already-uploaded photos into the inspection's folder
   structure, generates the PDF, and returns an Inspection ID and PDF link.
   The app shows a success screen and opens the PDF.

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

## Backend notes (Apps Script — `apps-script/Code.gs`)

The function forwards to the backend, which exposes:

- **GET `?action=getProperties`** → returns
  `{ "success": true, "properties": [ { "property": "...", "city": "...", "state": "...", "zip": "..." }, ... ] }`,
  read from the `Properties` sheet in the configured spreadsheet.
- **POST `{ "action": "uploadPhoto", "clientId", "category", "name", "mimeType", "blob" }`**
  — uploads one photo (base64) into the shared Temp Uploads folder and returns
  `{ "success": true, "fileId", "url", "category", "clientId" }`. `clientId` is
  an idempotency key: retrying the same upload returns the same file instead
  of duplicating it.
- **POST `{ "action": "deletePhoto", "fileId" }`** — trashes a temp file the
  inspector removed before submitting.
- **POST `{ "action": "submit", ...form fields..., "photos": { category: [{ fileId, name }] } }`**
  — creates the inspection + category folders, moves each file by ID (no
  re-upload), generates the PDF, and returns
  `{ "success": true, "inspectionId", "pdfUrl", "property", "inspectionDate", "photoFolderUrl" }`.
  If any photo fails to move, it returns `{ "success": false, "error", "moveErrors": [...] }`
  without generating the PDF — press Submit again to retry just the filing step.

Field names match the form's `name=` attributes (e.g. `inspectorPhone`,
`leaks`, `waterTankAge`, and `appliances` as a single joined string).

### Drive folder structure

```
<ROOT_FOLDER_ID>/
└── _TempUploads/                       (shared scratch space, drains on every submit)

<PROPERTIES_FOLDER_ID>/
└── 123 Main St/
    ├── Inspection Photos/
    │   ├── Exterior/
    │   ├── Kitchen/
    │   ├── Bathroom/
    │   ├── Utility/
    │   ├── Roof/
    │   └── General/
    └── Reports/
        └── Inspection - 123 Main St - 2026-06-30.pdf
```

Photos land in `_TempUploads` the moment they're picked. On Submit they're
**moved** (not re-uploaded) into `<property>/Inspection Photos/<category>`,
and the generated PDF is written to `<property>/Reports/`. Folder IDs are
configured in `apps-script/Config.gs` (`ROOT_FOLDER_ID`,
`PROPERTIES_FOLDER_ID`, `TEMPLATE_DOC_ID`, `LOG_SHEET_ID`).

### One-time Apps Script setup

1. Open the Apps Script project and add/update `Config.gs`, `Code.gs`,
   `Reports.gs`, `Template.gs`, `Utilities.gs`, and `PhotoUpload.gs` from
   `apps-script/`.
2. Set `ROOT_FOLDER_ID`, `PROPERTIES_FOLDER_ID`, `TEMPLATE_DOC_ID`, and
   `LOG_SHEET_ID` in `Config.gs` to your real Drive/Doc/Sheet IDs.
3. Run `setupTempFolder()` once from the editor (▶) to confirm Drive access
   and create the shared `_TempUploads` scratch folder; check **Logs** for
   its URL.
4. **Deploy → New deployment → Web app** → Execute as **Me**, Who has access
   **Anyone** → Deploy. Copy the `/exec` URL.
5. Put that URL in `netlify/functions/inspection.js` (`APPS_SCRIPT_URL`), or
   set it as the `APPS_SCRIPT_URL` environment variable in Netlify.

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

**A photo thumbnail shows "Retry" / upload failed.**
- Expected on a flaky field connection — tap **Retry** on that one thumbnail.
  Nothing else is lost; other photos and form answers are unaffected. Submit
  is blocked while any photo is still uploading or failed, so this can't slip
  through silently.

**Submit succeeds for some photos but returns an error about filing photos.**
- The inspection folder and any photos that *did* move are kept as-is (moves
  are idempotent). Just press **Submit** again — it picks up where it left
  off instead of re-uploading anything.

**Photos are huge / individual uploads are slow.**
- Photos are auto-compressed to 1600px / 70% JPEG before upload (typically
  200–400 KB each), and uploads happen one at a time as they're picked rather
  than all at submit. To change the compression target, edit `PHOTO_MAX_DIM` /
  `PHOTO_QUALITY` near the top of `script.js`. To raise/lower simultaneous
  uploads, edit `UPLOAD_CONCURRENCY`.

**The PDF doesn't auto-download.**
- Expected on most browsers — Drive PDFs are cross-origin, so the app opens the
  PDF in a new tab. If a popup blocker stops it, the **Open PDF** button on the
  success screen always works.

**Function returns 502 / Node error.**
- The function uses the built-in global `fetch` (Node 18+). `netlify.toml`
  already pins `NODE_VERSION = "18"`; if you changed it, keep it ≥ 18.
