/* =================================================================
   Johnson Signature Realty — Property Inspection Report
   Google Apps Script backend — Code.gs

   Scalable photo upload architecture:
     1. Each photo is uploaded individually, immediately after the
        inspector picks it (action=uploadPhoto), into one shared
        TEMP UPLOADS folder. The file is never touched again until
        submit — no re-upload, no base64 round-trip on Submit.
     2. On Submit (action=submit) the frontend sends ONLY form
        answers + the list of {fileId, name} per category — never
        image bytes. The backend creates the inspection folder, its
        category subfolders, and MOVES the already-uploaded files
        from Temp Uploads into place.
     3. The PDF report links to the Drive folder instead of
        embedding every photo, so report generation stays fast no
        matter how many photos an inspection has.

   Deploy: Extensions → Apps Script in your Sheet/project → paste
   this file as Code.gs → Deploy → New deployment → Web app →
   Execute as: Me, Who has access: Anyone → Deploy. Put the /exec
   URL into netlify/functions/inspection.js (APPS_SCRIPT_URL).

   One-time setup (Script Properties, or just edit the CONFIG
   constants below): ROOT_FOLDER_ID, TEMP_FOLDER_ID, SPREADSHEET_ID.
   Run `setup()` once from the editor to auto-create anything
   missing and print the IDs to the log.
   ================================================================= */

/* =================================================================
   CONFIG
   ================================================================= */

const CONFIG = {
  // "Inspection Reports" parent folder. Leave blank to auto-create
  // on first run (the id is then cached in Script Properties).
  ROOT_FOLDER_ID: '',

  // Single shared scratch folder every photo lands in immediately
  // on upload, before it has a home. Leave blank to auto-create.
  TEMP_FOLDER_ID: '',

  // Spreadsheet that stores the Master Property list (sheet
  // "Properties", header row: property | city | state | zip) and
  // the inspection log (sheet "Inspections", created if missing).
  SPREADSHEET_ID: '',

  PROPERTIES_SHEET: 'Properties',
  LOG_SHEET: 'Inspections',

  // Canonical category list — keep in sync with the frontend's
  // PHOTO_CATEGORIES in script.js. Any category the frontend sends
  // that isn't in this list still gets its own subfolder; this list
  // just fixes display order.
  CATEGORIES: ['exterior', 'kitchen', 'bathroom', 'utility', 'roof', 'general'],

  REQUIRED_FIELDS: ['property', 'inspectionDate', 'inspectorName', 'inspectorEmail', 'roofCondition'],

  // How long an uploadPhoto idempotency key is remembered, so a
  // retried upload (same clientId) returns the existing file instead
  // of creating a duplicate. CacheService max is 6 hours.
  DEDUPE_TTL_SECONDS: 6 * 60 * 60,
};

/* =================================================================
   Entry points
   ================================================================= */

function doGet(e) {
  try {
    const action = e && e.parameter && e.parameter.action;
    if (action === 'getProperties') {
      return jsonOut(getProperties_());
    }
    return jsonOut({ success: true, status: 'ok', message: 'Inspection backend is running.' });
  } catch (err) {
    return jsonOut({ success: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ success: false, error: 'Invalid JSON body.' });
  }

  const action = data.action || 'submit';
  try {
    if (action === 'uploadPhoto') return jsonOut(handleUploadPhoto_(data));
    if (action === 'deletePhoto') return jsonOut(handleDeletePhoto_(data));
    if (action === 'submit')      return jsonOut(handleSubmit_(data));
    return jsonOut({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut({ success: false, error: String(err && err.message || err) });
  }
}

/* =================================================================
   1. Per-photo upload  (action=uploadPhoto)
   Body: { action, clientId, category, name, mimeType, blob(base64) }
   Returns: { success, fileId, url, category, clientId }
   ================================================================= */

function handleUploadPhoto_(data) {
  const clientId = String(data.clientId || '').trim();
  const blobB64  = data.blob;
  const mimeType = data.mimeType || 'image/jpeg';
  const name     = sanitizeFileName_(data.name || 'photo.jpg');
  const category = String(data.category || 'general').trim() || 'general';

  if (!blobB64) return { success: false, error: 'Missing photo data.' };
  if (!clientId) return { success: false, error: 'Missing clientId (required for safe retries).' };

  // Idempotency: if this exact clientId was already uploaded (e.g. the
  // browser retried after a flaky response), hand back the same file
  // instead of creating a duplicate.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'upload_' + clientId;
  const cached = cache.get(cacheKey);
  if (cached) {
    const prior = JSON.parse(cached);
    try {
      const f = DriveApp.getFileById(prior.fileId); // confirm it still exists
      return { success: true, fileId: f.getId(), url: f.getUrl(), category: prior.category, clientId, deduped: true };
    } catch (_) {
      // File vanished (manually deleted) — fall through and re-upload.
    }
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(blobB64);
  } catch (err) {
    return { success: false, error: 'Could not decode photo data: ' + err.message };
  }

  const blob = Utilities.newBlob(bytes, mimeType, name);
  const tempFolder = getTempFolder_();
  // Prefix with category + clientId so the file is self-describing even
  // if it's ever found sitting in Temp Uploads after an interrupted submit.
  blob.setName(category + '__' + clientId + '__' + name);

  const file = tempFolder.createFile(blob);

  cache.put(cacheKey, JSON.stringify({ fileId: file.getId(), category }), CONFIG.DEDUPE_TTL_SECONDS);

  return { success: true, fileId: file.getId(), url: file.getUrl(), category, clientId };
}

/* =================================================================
   Optional: let the frontend free up Temp Uploads when the inspector
   removes a photo before submitting.
   Body: { action, fileId }
   ================================================================= */

function handleDeletePhoto_(data) {
  const fileId = data.fileId;
  if (!fileId) return { success: false, error: 'Missing fileId.' };
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    return { success: true };
  } catch (err) {
    // Already gone / never existed — not a failure from the frontend's
    // point of view, it just wants the file gone.
    return { success: true, note: 'File already absent: ' + err.message };
  }
}

/* =================================================================
   2 & 3. Submit  (action=submit)
   Body: { action, ...form fields..., photos: { category: [{fileId,name}] } }
   ================================================================= */

function handleSubmit_(data) {
  const missing = CONFIG.REQUIRED_FIELDS.filter(f => !String(data[f] || '').trim());
  if (missing.length) {
    return { success: false, error: 'Missing required field(s): ' + missing.join(', ') };
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(String(data.inspectorEmail).trim())) {
    return { success: false, error: 'Inspector email is invalid.' };
  }

  const photos = data.photos && typeof data.photos === 'object' ? data.photos : {};
  const inspectionId = buildInspectionId_(data);

  // Reuse a previous attempt's folder if this exact inspection was
  // partially submitted before (network drop, etc.) — keeps retries
  // idempotent instead of spawning duplicate folders each time.
  const inspectionFolder = getOrCreateInspectionFolder_(data, inspectionId);

  const moveErrors = [];
  const movedByCategory = {};

  const allCategories = Array.from(new Set(CONFIG.CATEGORIES.concat(Object.keys(photos))));
  allCategories.forEach(category => {
    const items = Array.isArray(photos[category]) ? photos[category] : [];
    if (!items.length) return;

    const categoryFolder = getOrCreateSubfolder_(inspectionFolder, displayCategoryName_(category));
    movedByCategory[category] = [];

    items.forEach(item => {
      const fileId = item && item.fileId;
      if (!fileId) {
        moveErrors.push({ category, name: item && item.name, error: 'Missing fileId.' });
        return;
      }
      try {
        const movedUrl = moveFileIntoFolder_(fileId, categoryFolder);
        movedByCategory[category].push({ fileId, name: item.name, url: movedUrl });
      } catch (err) {
        moveErrors.push({ category, fileId, name: item.name, error: String(err.message || err) });
      }
    });
  });

  // Per the spec: only generate the PDF once every photo has moved
  // successfully. If something failed, the inspection folder and
  // whatever DID move stay in place — the inspector can just hit
  // Submit again (moveFileIntoFolder_ is idempotent) without
  // re-uploading anything.
  if (moveErrors.length) {
    return {
      success: false,
      error: 'Some photos could not be filed into their category folders. Nothing was lost — press Submit again to retry.',
      inspectionId,
      folderUrl: inspectionFolder.getUrl(),
      moveErrors,
    };
  }

  let pdfUrl;
  try {
    pdfUrl = generateReportPdf_(data, inspectionId, inspectionFolder);
  } catch (err) {
    return {
      success: false,
      error: 'Photos were filed successfully, but the PDF failed to generate: ' + err.message + '. Press Submit again to retry just the report.',
      inspectionId,
      folderUrl: inspectionFolder.getUrl(),
    };
  }

  logInspection_(data, inspectionId, inspectionFolder.getUrl(), pdfUrl);

  return {
    success: true,
    inspectionId,
    property: data.property,
    inspectionDate: data.inspectionDate,
    pdfUrl,
    photoFolderUrl: inspectionFolder.getUrl(),
  };
}

/* =================================================================
   Drive helpers
   ================================================================= */

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = CONFIG.ROOT_FOLDER_ID || props.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (_) { /* fall through and recreate */ }
  }
  const folder = DriveApp.getRootFolder().createFolder('Inspection Reports');
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getTempFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = CONFIG.TEMP_FOLDER_ID || props.getProperty('TEMP_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (_) { /* fall through and recreate */ }
  }
  const folder = getRootFolder_().createFolder('_TempUploads');
  props.setProperty('TEMP_FOLDER_ID', folder.getId());
  return folder;
}

/** Find-or-create so resubmitting the same inspection doesn't duplicate folders. */
function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function getOrCreateInspectionFolder_(data, inspectionId) {
  const root = getRootFolder_();
  const folderName = String(data.property || 'Unknown Property').trim() + ' — ' + inspectionId;
  return getOrCreateSubfolder_(root, folderName);
}

/** Idempotent: if the file is already in targetFolder, this is a no-op. */
function moveFileIntoFolder_(fileId, targetFolder) {
  const file = DriveApp.getFileById(fileId);

  const parents = file.getParents();
  let alreadyThere = false;
  const oldParents = [];
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() === targetFolder.getId()) alreadyThere = true;
    else oldParents.push(p);
  }

  if (!alreadyThere) {
    targetFolder.addFile(file);
  }
  oldParents.forEach(p => p.removeFile(file));

  return file.getUrl();
}

function sanitizeFileName_(name) {
  return String(name).replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 150) || 'photo.jpg';
}

function displayCategoryName_(category) {
  const known = {
    exterior: 'Exterior', kitchen: 'Kitchen', bathroom: 'Bathroom',
    utility: 'Utility', roof: 'Roof', general: 'General',
  };
  if (known[category]) return known[category];
  return String(category).charAt(0).toUpperCase() + String(category).slice(1);
}

function buildInspectionId_(data) {
  const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyyMMdd-HHmmss');
  return 'INS-' + ts;
}

/* =================================================================
   PDF generation — answers + a link to the photo folder, not the
   photos themselves.
   ================================================================= */

function generateReportPdf_(data, inspectionId, inspectionFolder) {
  const doc = DocumentApp.create(inspectionId + ' - ' + (data.property || ''));
  const body = doc.getBody();

  body.appendParagraph('Property Inspection Report').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('Inspection ID: ' + inspectionId);
  body.appendParagraph('Property: ' + (data.property || ''));
  body.appendParagraph('Inspection Date: ' + (data.inspectionDate || ''));
  body.appendParagraph('Inspector: ' + (data.inspectorName || '') + (data.inspectorPhone ? ' — ' + data.inspectorPhone : ''));
  body.appendParagraph('Email: ' + (data.inspectorEmail || ''));

  const sections = [
    { title: 'Property Condition', fields: ['occupancyStatus', 'propertySecure', 'violationNotice'] },
    { title: 'Doors & Windows', fields: ['frontDoor', 'rearDoor', 'sideDoor', 'brokenWindows'] },
    { title: 'Utilities', fields: ['electric', 'gas', 'water'] },
    { title: 'Roof & Gutters', fields: ['roofCondition', 'shingleType', 'roofDamage', 'guttersPresent', 'gutterDamage'] },
    { title: 'Damage Assessment', fields: ['fireDamage', 'waterDamage', 'freezeDamage', 'vandalism', 'damageDescription'] },
    { title: 'Plumbing & Electrical', fields: ['plumbingDamage', 'leaks', 'electricalDamage', 'electricianNeeded', 'systemNotes'] },
    { title: 'Mechanical Systems', fields: ['furnaceCondition', 'furnaceAge', 'waterTankCondition', 'waterTankAge', 'appliances'] },
    { title: 'Kitchen Assessment', fields: ['kitchenCondition', 'cabinets', 'countertops', 'kitchenFlooring', 'kitchenNotes'] },
    { title: 'Bathroom Assessment', fields: ['bathroomCondition', 'fixtures', 'tileGrout', 'ventilation', 'bathroomNotes'] },
    { title: 'Additional Information', fields: ['estimatedValue', 'estimatedRent', 'generalNotes'] },
  ];

  sections.forEach(section => {
    body.appendParagraph(section.title).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    section.fields.forEach(field => {
      const val = data[field];
      if (val === undefined || val === null || String(val).trim() === '') return;
      body.appendParagraph(humanizeField_(field) + ': ' + val);
    });
  });

  body.appendParagraph('Inspection Photos').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  const linkPara = body.appendParagraph('View all inspection photos here: ' + inspectionFolder.getUrl());
  linkPara.editAsText().setLinkUrl(0, linkPara.getText().length - 1, inspectionFolder.getUrl());

  doc.saveAndClose();

  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs('application/pdf').setName(inspectionId + ' - ' + (data.property || '') + '.pdf');
  const pdfFile = inspectionFolder.createFile(pdfBlob);
  docFile.setTrashed(true); // keep only the PDF in the inspection folder

  return pdfFile.getUrl();
}

function humanizeField_(field) {
  return String(field)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

/* =================================================================
   Properties list + logging
   ================================================================= */

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = CONFIG.SPREADSHEET_ID || props.getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not configured.');
  return SpreadsheetApp.openById(id);
}

function getProperties_() {
  try {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(CONFIG.PROPERTIES_SHEET);
    if (!sheet) return { success: false, error: 'Properties sheet not found.' };

    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return { success: true, properties: [] };

    const headers = values[0].map(h => String(h).trim().toLowerCase());
    const idx = { property: headers.indexOf('property'), city: headers.indexOf('city'), state: headers.indexOf('state'), zip: headers.indexOf('zip') };

    const properties = values.slice(1)
      .filter(row => row[idx.property])
      .map(row => ({
        property: row[idx.property],
        city: idx.city > -1 ? row[idx.city] : '',
        state: idx.state > -1 ? row[idx.state] : '',
        zip: idx.zip > -1 ? row[idx.zip] : '',
      }));

    return { success: true, properties };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

function logInspection_(data, inspectionId, folderUrl, pdfUrl) {
  try {
    const ss = getSpreadsheet_();
    let sheet = ss.getSheetByName(CONFIG.LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.LOG_SHEET);
      sheet.appendRow(['Inspection ID', 'Timestamp', 'Property', 'Inspection Date', 'Inspector', 'Email', 'Folder URL', 'PDF URL']);
    }
    sheet.appendRow([inspectionId, new Date(), data.property, data.inspectionDate, data.inspectorName, data.inspectorEmail, folderUrl, pdfUrl]);
  } catch (err) {
    // Logging is best-effort — never fail the submission because the
    // log sheet had a problem.
  }
}

/* =================================================================
   JSON response helper
   ================================================================= */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =================================================================
   One-time setup helper — run manually from the Apps Script editor.
   Creates the root + temp folders if CONFIG/Script Properties don't
   already point at real ones, and logs the IDs.
   ================================================================= */

function setup() {
  const root = getRootFolder_();
  const temp = getTempFolder_();
  Logger.log('ROOT_FOLDER_ID: ' + root.getId());
  Logger.log('TEMP_FOLDER_ID: ' + temp.getId());
  Logger.log('Set SPREADSHEET_ID in CONFIG (or Script Properties) to your Master Property DB spreadsheet ID.');
}
