# Johnson Signature Realty — Property Inspection Report

A production-ready, mobile-first web app for completing property inspections in
the field. Inspectors fill out the form, attach photos, and submit — the
existing Google Apps Script backend then generates a branded PDF report, saves
it to Drive, and returns the link.

Built with plain **HTML5 + CSS3 + vanilla JavaScript (ES6)**. No frameworks, no
build step, no dependencies. Deploys to Netlify as static files.

---

## Folder structure

```
inspection-app/
├── assets/
│   ├── logo.png        (you provide — header logo, optional)
│   ├── favicon.ico     (you provide — tab icon, optional)
│   └── README.txt      (notes on the two files above)
├── index.html          markup: form, accordion sections, overlays
├── styles.css          navy/gold luxury-minimal styling, mobile-first
├── script.js           all logic: load, search, validate, submit, photos
├── config.js           the backend endpoint URL
└── README.md           this file
```

---

## How it works

1. On load, the app calls the backend `?action=getProperties` and fills the
   searchable property dropdown.
2. The inspector completes the sections (Property Info → Photos). Progress
   updates live; only one section is open at a time.
3. On **Submit Report**, the app validates required fields, compresses photos,
   and POSTs everything to the backend as JSON.
4. The backend returns an Inspection ID and a PDF link. The app shows a success
   screen and opens the PDF.

**Required fields:** Property, Inspection Date, Inspector Name, Email, Roof
Condition. (Email is required because the backend rejects submissions without
it.)

---

## How to replace the logo

1. Save your logo as `logo.png`.
2. Drop it into the `assets/` folder, replacing the placeholder.
3. That's it — the header loads `assets/logo.png` automatically (max height
   100px). If the file is missing, a "Company Logo" text fallback shows instead,
   so the app never breaks.

Optionally add `favicon.ico` to `assets/` for the browser-tab icon.

---

## How to deploy to Netlify

No build step is needed — these are static files.

**Option A — drag & drop (fastest)**
1. Go to <https://app.netlify.com/drop>.
2. Drag the entire `inspection-app` folder onto the page.
3. Netlify gives you a live URL. Done.

**Option B — connect a Git repo (for ongoing updates)**
1. Push `inspection-app` to a GitHub/GitLab repo.
2. In Netlify: **Add new site → Import an existing project** → pick the repo.
3. Leave **Build command** blank and set **Publish directory** to the folder
   containing `index.html` (the repo root, or `inspection-app/` if nested).
4. Deploy. Future pushes redeploy automatically.

No environment variables are required — the backend URL lives in `config.js`.

---

## Backend notes (for whoever maintains the Apps Script)

The frontend expects the backend to:

- **GET `?action=getProperties`** → return
  `{ "success": true, "properties": [ { "property": "...", "city": "...", "state": "...", "zip": "..." }, ... ] }`
  (a plain array of strings also works).
- **POST** a JSON body (sent as `text/plain`) containing all form fields plus a
  `photos` object bucketed as
  `{ exterior:[], kitchen:[], bathroom:[], utility:[], roof:[], general:[] }`,
  where each photo is `{ blob: "<base64>", mimeType: "...", name: "..." }`.
- Return `{ "success": true, "inspectionId": "...", "pdfUrl": "...", "property": "...", "inspectionDate": "..." }`.

Field names match the backend's `testData` map (e.g. `inspectorPhone`, `leaks`,
`waterTankAge`, and `appliances` as a single joined string).

---

## Troubleshooting

**The property dropdown is empty / says "Could not load the property list."**
- The backend `?action=getProperties` isn't responding with a `properties`
  array. Open the endpoint in a browser with `?action=getProperties` on the end.
  If you see the health-check JSON instead of properties, the Apps Script wasn't
  redeployed: **Deploy → Manage deployments → ✏️ edit → Version: New version →
  Deploy.** Editing the code alone doesn't republish it.
- Until it's fixed, the app lets inspectors type the address manually, so
  submissions still work.

**The report saves with a blank or wrong property.**
- The app sends the **street** as the property value by default. If your backend
  matches on the full address instead, open `script.js`, set
  `SUBMIT_FULL_ADDRESS = true` (line near the top), and redeploy the frontend.
  That's the only change needed.

**Submit fails immediately / "unexpected response."**
- Confirm the Apps Script deployment access is **"Anyone"** (not "Anyone with
  Google account"). Field inspectors won't be signed in.
- Confirm `WEB_APP_URL` in `config.js` ends in `/exec` (not `/dev`).

**The PDF doesn't auto-download.**
- Expected on most browsers — Drive PDFs are cross-origin, so the app opens the
  PDF in a new tab instead. If the tab is blocked by a popup blocker, the
  **Open PDF** button on the success screen always works.

**Photos are huge / uploads are slow.**
- Photos are auto-compressed to 1600px / 70% JPEG before upload. To change that,
  edit `PHOTO_MAX_DIM` and `PHOTO_QUALITY` near the top of `script.js`.

**Nothing happens on an old phone.**
- The app uses modern HTML (`<details name>` accordions). It works in current
  Chrome, Safari, Edge, and Firefox. Very old browsers (pre-2023) may not group
  the accordion exclusively, but the form still functions.

---

## Quick local preview

Because the app fetches from the backend, open it through a tiny local server
rather than double-clicking the file:

```bash
cd inspection-app
python3 -m http.server 8000
# then visit http://localhost:8000
```
