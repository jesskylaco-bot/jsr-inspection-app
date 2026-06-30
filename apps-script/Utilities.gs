/**
 * Utilities.gs
 * ============
 * Shared helper functions used across the inspection system.
 * No business logic here — only reusable utilities.
 */

// ─── ID Generation ────────────────────────────────────────────────────────────

/**
 * Generates a unique inspection ID.
 * Format: INS-YYYYMMDD-XXXX  (e.g. INS-20250115-A3F7)
 *
 * @returns {string} Unique inspection ID
 */
function generateInspectionId() {
  const datePart = Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMdd');
  const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INS-${datePart}-${randomPart}`;
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

/**
 * Formats a Date object or ISO string using the project timezone.
 *
 * @param {Date|string} date  Date to format (Date object or ISO string)
 * @param {string}      fmt   Utilities.formatDate() format string
 * @returns {string}          Formatted date string
 */
function formatDate(date, fmt) {
  const d = (date instanceof Date) ? date : new Date(date);
  return Utilities.formatDate(d, TIMEZONE, fmt || DATE_FORMAT);
}

/**
 * Returns today's date formatted per the project DATE_FORMAT.
 *
 * @returns {string}
 */
function todayFormatted() {
  return formatDate(new Date(), DATE_FORMAT);
}

// ─── Placeholder Resolution ──────────────────────────────────────────────────

/**
 * Resolves a value from the data object using a key from PLACEHOLDER_MAP.
 * Returns 'N/A' if the key is missing or the value is empty/null/undefined.
 *
 * @param {Object} data   Submitted inspection data
 * @param {string} key    The placeholder key (e.g. 'property')
 * @returns {string}      The value to insert, or 'N/A'
 */
function resolveValue(data, key) {
  const val = data[key];
  if (val === null || val === undefined || String(val).trim() === '') {
    return 'N/A';
  }
  return String(val).trim();
}

/**
 * Builds the complete replacement map for a given data object.
 * Each entry is  { '{{PLACEHOLDER}}' : 'resolved value' }.
 *
 * @param {Object} data   Submitted inspection data
 * @returns {Object}      Replacement map
 */
function buildReplacementMap(data) {
  const map = {};

  for (const [placeholder, dataKey] of Object.entries(PLACEHOLDER_MAP)) {
    map[`{{${placeholder}}}`] = resolveValue(data, dataKey);
  }

  // Auto-fill generated date (not from submitted data)
  map['{{GENERATED_DATE}}'] = todayFormatted();

  return map;
}

// ─── Drive Helpers ────────────────────────────────────────────────────────────

/**
 * Gets or creates a subfolder by name inside a parent folder.
 *
 * @param {DriveApp.Folder} parentFolder  Parent Drive folder object
 * @param {string}          name          Subfolder name to find or create
 * @returns {DriveApp.Folder}             The existing or newly created folder
 */
function getOrCreateFolder(parentFolder, name) {
  const existing = parentFolder.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parentFolder.createFolder(name);
}

/**
 * Sanitizes a string for use as a file or folder name.
 * Removes characters that are illegal in Drive names.
 *
 * @param {string} name   Raw name string
 * @returns {string}      Safe name string
 */
function sanitizeName(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, '-')  // Replace illegal chars with dash
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .trim()
    .substring(0, 100);              // Max 100 chars to be safe
}

// ─── Image Helpers ────────────────────────────────────────────────────────────

/**
 * Calculates scaled image dimensions that fit within the configured max bounds
 * while preserving the original aspect ratio.
 *
 * @param {number} originalWidth   Original image width in pixels
 * @param {number} originalHeight  Original image height in pixels
 * @returns {{ width: number, height: number }}  Scaled dimensions in points
 */
function scaleImageDimensions(originalWidth, originalHeight) {
  const maxW = MAX_IMAGE_WIDTH_PT;
  const maxH = MAX_IMAGE_HEIGHT_PT;

  if (originalWidth <= 0 || originalHeight <= 0) {
    return { width: maxW, height: maxH };
  }

  const widthRatio  = maxW / originalWidth;
  const heightRatio = maxH / originalHeight;
  const scale       = Math.min(widthRatio, heightRatio, 1); // Never upscale

  return {
    width : Math.round(originalWidth  * scale),
    height: Math.round(originalHeight * scale),
  };
}

// ─── Logging ─────────────────────────────────────────────────────────────────

/**
 * Appends a row to the inspection log Google Sheet (if LOG_SHEET_ID is set).
 * Fails silently so a sheet issue never breaks report generation.
 *
 * @param {Object} entry  Plain object with fields: inspectionId, property,
 *                        inspectorName, date, docUrl, pdfUrl, status
 */
function logToSheet(entry) {
  if (!LOG_SHEET_ID || LOG_SHEET_ID === 'REPLACE_WITH_LOG_SHEET_ID') return;

  try {
    const ss    = SpreadsheetApp.openById(LOG_SHEET_ID);
    const sheet = ss.getSheets()[0];

    // Write header row if this is the first entry
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Inspection ID', 'Property', 'Inspector', 'Date',
        'Doc URL', 'PDF URL', 'Status', 'Generated At',
      ]);
    }

    sheet.appendRow([
      entry.inspectionId  || '',
      entry.property      || '',
      entry.inspectorName || '',
      entry.date          || '',
      entry.docUrl        || '',
      entry.pdfUrl        || '',
      entry.status        || 'Complete',
      new Date().toISOString(),
    ]);
  } catch (err) {
    console.error('logToSheet error (non-fatal):', err.message);
  }
}

// ─── Error Response ───────────────────────────────────────────────────────────

/**
 * Builds a standardised error response object for doPost().
 *
 * @param {string}    message  Human-readable error message
 * @param {Error}     [err]    Optional caught error for stack trace logging
 * @returns {Object}           JSON-serialisable response object
 */
function errorResponse(message, err) {
  if (err) console.error(message, err);
  return { success: false, error: message };
}
