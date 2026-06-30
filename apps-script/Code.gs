/**
 * Code.gs
 * =======
 * Entry point for the JSR Property Inspection System.
 *
 * Exposes a single Web App endpoint:
 *   POST  →  action=uploadPhoto | deletePhoto | submit
 *   GET   →  ?action=getProperties, or health check
 *
 * Photo upload architecture (scalable):
 *   1. Each photo is uploaded individually the moment the inspector picks
 *      it (action=uploadPhoto) into a shared Temp Uploads folder. No image
 *      bytes are held back for Submit.
 *   2. Submit (action=submit) carries only form answers plus
 *      { category: [{ fileId, name }] } } — the backend MOVES those
 *      already-uploaded files into the property's category folders
 *      (movePhotosForSubmission, in PhotoUpload.gs) instead of re-uploading
 *      anything, then generates the PDF report (Reports.gs / Template.gs),
 *      which links to the photo folder rather than embedding every image.
 *   3. A move that partially fails leaves everything in place — pressing
 *      Submit again retries idempotently instead of restarting the
 *      inspection or re-uploading photos.
 *
 * Deployment type: "Execute as Me", "Anyone can access"
 * (adjust access level based on your security requirements)
 */

// ─── Web App: POST Handler ────────────────────────────────────────────────────

/**
 * Receives photo uploads and the final inspection submission from the
 * front-end.
 *
 * Expected JSON body — one of:
 *
 *   { "action": "uploadPhoto", "clientId", "category", "name", "mimeType", "blob" }
 *   { "action": "deletePhoto", "fileId" }
 *   {
 *     "action"            : "submit",
 *     "property"          : "123 Main St, Detroit MI 48201",
 *     "inspectionDate"    : "2025-01-15",
 *     "inspectorName"     : "John Smith",
 *     ... (all other fields from PLACEHOLDER_MAP in Config.gs) ...
 *     "photos": {
 *       "exterior" : [ { "fileId": "...", "name": "front.jpg" } ],
 *       "kitchen"  : [],
 *       "bathroom" : [],
 *       "utility"  : [],
 *       "roof"     : [],
 *       "general"  : []
 *     }
 *   }
 *
 * Submit returns JSON:
 * {
 *   "success"        : true,
 *   "inspectionId"   : "INS-20250115-A3F7",
 *   "pdfUrl"         : "https://drive.google.com/...",
 *   "property"       : "123 Main St, Detroit MI 48201",
 *   "inspectionDate" : "2025-01-15",
 *   "photoFolderUrl" : "https://drive.google.com/drive/folders/..."
 * }
 *
 * @param {Object} e  Apps Script event object
 * @returns {ContentService.TextOutput}
 */
function doPost(e) {
  try {
    // ── Parse request body ──────────────────────────────────
    const raw = e.postData && e.postData.contents;
    if (!raw) {
      return jsonResponse(errorResponse('No request body received.'));
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      return jsonResponse(errorResponse('Invalid JSON in request body.', parseErr));
    }

    const action = data.action || 'submit';

    if (action === 'uploadPhoto') {
      return jsonResponse(handleUploadPhoto(data));
    }
    if (action === 'deletePhoto') {
      return jsonResponse(handleDeletePhoto(data));
    }
    if (action !== 'submit') {
      return jsonResponse(errorResponse('Unknown action: ' + action));
    }

    // ── Submit: validate ────────────────────────────────────
    const validationError = validateRequiredFields(data);
    if (validationError) {
      return jsonResponse(errorResponse(validationError));
    }

    data.inspectionId = data.inspectionId || generateInspectionId();

    // ── File already-uploaded photos into the property's category
    //    folders. Only after every photo has moved successfully do we
    //    generate the PDF — a partial failure leaves the inspection
    //    folder + whatever DID move in place, ready for a retry.
    const photoResult = movePhotosForSubmission(data.property, data.photos || {});
    if (photoResult.moveErrors && photoResult.moveErrors.length) {
      return jsonResponse({
        success: false,
        error: 'Some photos could not be filed into their category folders. Nothing was lost — press Submit again to retry.',
        inspectionId: data.inspectionId,
        photoFolderUrl: photoResult.folderUrl,
        moveErrors: photoResult.moveErrors,
      });
    }
    data.photoFolderUrl = photoResult.folderUrl;
    data.generalPhotosLink = photoResult.generalFolderUrl;

    // ── Generate report ─────────────────────────────────────
    const result = generateInspectionReport(data);

    logToSheet({
      inspectionId: data.inspectionId,
      property: data.property,
      inspectorName: data.inspectorName,
      date: data.inspectionDate,
      pdfUrl: result.pdfUrl,
      status: 'Complete',
    });

    return jsonResponse(Object.assign({}, result, {
      inspectionId: data.inspectionId,
      inspectionDate: data.inspectionDate,
      photoFolderUrl: photoResult.folderUrl,
    }));

  } catch (err) {
    console.error('doPost unhandled error:', err);
    return jsonResponse(errorResponse('Report generation failed: ' + err.message, err));
  }
}

/**
 * Web App: GET Handler
 *
 * Supports:
 * ?action=getProperties
 * Default: Health Check
 */
function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : "";

    if (action === "getProperties") {
      return jsonResponse(getProperties());
    }

    // Default health check
    return jsonResponse({
      success: true,
      service: "JSR Property Inspection System",
      version: "1.2.0",
      status: "OK",
      time: new Date().toISOString()
    });

  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.message
    });
  }
}
// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates that the submitted data contains all required fields.
 * Returns a human-readable error string, or null if valid.
 *
 * @param {Object}      data  Parsed submission data
 * @returns {string|null}     Error message, or null if all required fields present
 */
function validateRequiredFields(data) {
  const REQUIRED = [
    'property',
    'inspectorName',
    'inspectorEmail',
    'inspectionDate',
  ];

  const missing = REQUIRED.filter(field =>
    !data[field] || String(data[field]).trim() === ''
  );

  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }

  return null;
}

// ─── Response Helper ─────────────────────────────────────────────────────────

/**
 * Wraps a plain object as a JSON ContentService response.
 *
 * @param {Object} obj  Object to serialize
 * @returns {ContentService.TextOutput}
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
/**
 * Returns the property list for the frontend dropdown.
 */
function getProperties() {

  const SPREADSHEET_ID = "1RLs1SKoBmWzftz7MNzU8LZaJ62dkqFiSos9qFbDxRjA";
  const SHEET_NAME = "Properties";

  try {

    const sheet = SpreadsheetApp
      .openById(SPREADSHEET_ID)
      .getSheetByName(SHEET_NAME);

    if (!sheet) {
      throw new Error("Properties sheet not found.");
    }

    const values = sheet.getDataRange().getValues();

    if (values.length < 2) {
      return {
        success: true,
        properties: []
      };
    }

    // Remove header row
    values.shift();

    const properties = values
      .filter(row => row[0]) // Property Address
      .map(row => ({
        property: row[0],
        city: row[1],
        state: row[2],
        zip: row[3],
        driveFolder: row[10],          // Column K
        reportsFolder: row[11]         // Column L
      }));

    return {
      success: true,
      properties: properties
    };

  } catch (err) {

    return {
      success: false,
      error: err.message
    };

  }

}

// ─── Manual Test Runner ──────────────────────────────────────────────────────

/**
 * testGenerate()
 * ==============
 * Run this function directly from the Apps Script editor to test the
 * full pipeline without going through the web form.
 *
 * Steps:
 *   1. Open Apps Script editor → select "testGenerate" from the function list
 *   2. Click Run
 *   3. Check Execution Log and your Google Drive for the output files
 */
function testGenerate() {
  const testData = {
    property          : '456 Elm Street, Detroit MI 48202',
    inspectionDate    : '2025-01-15',
    inspectorName     : 'Jane Inspector',
    inspectorPhone    : '313-555-9876',
    inspectorEmail    : 'jane@cobbgroup.com',

    occupancyStatus   : 'Vacant',
    propertySecure    : 'Yes',
    violationNotice   : 'No',

    frontDoor         : 'Good',
    rearDoor          : 'Fair — lock stiff',
    sideDoor          : 'N/A',
    brokenWindows     : 'None',

    electric          : 'On',
    gas               : 'Off',
    water             : 'On',

    roofCondition     : 'Fair',
    shingleType       : 'Asphalt',
    roofDamage        : 'Minor shingle loss at ridge',
    guttersPresent    : 'Yes',
    gutterDamage      : 'Debris in rear gutters',

    fireDamage        : 'None',
    waterDamage       : 'Staining on basement ceiling',
    freezeDamage      : 'None',
    vandalism         : 'None',
    damageDescription : 'Water stain approx. 2×3 ft on basement ceiling near HVAC.',

    plumbingDamage    : 'None',
    leaks             : 'No active leaks observed',
    electricalDamage  : 'None',
    electricianNeeded : 'No',
    systemNotes       : 'Panel appears updated — 200 amp service.',

    furnaceCondition  : 'Good',
    furnaceAge        : '~8 years',
    waterTankCondition: 'Good',
    waterTankAge      : '~5 years',
    appliances        : 'Washer/dryer hookups present. No appliances.',

    kitchenCondition  : 'Fair',
    cabinets          : 'Scratches — functional',
    countertops       : 'Laminate — worn edges',
    kitchenFlooring   : 'Vinyl — good condition',
    kitchenNotes      : 'Cabinet doors rehung; minor touch-up paint needed.',

    bathroomCondition : 'Fair',
    fixtures          : 'Functional',
    tileGrout         : 'Grout discoloured — no cracks',
    ventilation       : 'Fan present and operational',
    bathroomNotes     : 'Toilet runs — flapper replacement needed.',

    estimatedValue    : '$145,000',
    estimatedRent     : '$1,200/month',
    generalNotes      : 'Property shows well overall. Recommend water stain investigation and minor cosmetic repairs before listing.',

    inspectionId      : generateInspectionId(),
    photos            : {},   // No photos in test — uploadPhoto/movePhotosForSubmission is exercised separately
  };

  const result = generateInspectionReport(testData);
  console.log('Test result:', JSON.stringify(result, null, 2));
}

/**
 * setupTempFolder()
 * =================
 * Run once from the editor to confirm the shared Temp Uploads scratch
 * folder exists (it auto-creates on first uploadPhoto call too, but this
 * lets you verify Drive access works before going live).
 */
function setupTempFolder() {
  const folder = getTempUploadsFolder_();
  Logger.log('Temp Uploads folder ready: ' + folder.getUrl());
}
