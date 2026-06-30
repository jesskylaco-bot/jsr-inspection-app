/**
 * PhotoUpload.gs
 * ==============
 * Handles per-photo uploads to a shared temp scratch folder, and the
 * idempotent move of those files into the property's category folders
 * on submit. No image bytes are ever written into category folders
 * directly — they only ever land there via moveFileIntoFolder_.
 */

const PHOTO_CATEGORY_MAP = {
  exterior: 'Exterior',
  kitchen: 'Kitchen',
  bathroom: 'Bathroom',
  utility: 'Utility',
  roof: 'Roof',
  general: 'General',
};

const UPLOAD_DEDUPE_TTL_SECONDS = 6 * 60 * 60; // CacheService max

// ─── Temp Folder ──────────────────────────────────────────────────────────────

function getTempUploadsFolder_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  return getOrCreateFolder(root, TEMP_UPLOADS_FOLDER_NAME);
}

// ─── Upload / Delete ──────────────────────────────────────────────────────────

/**
 * Uploads a single photo into the shared temp folder. Idempotent per
 * clientId — a retried upload with the same clientId returns the
 * already-uploaded file instead of creating a duplicate.
 *
 * @param {Object} data  { clientId, category, name, mimeType, blob }
 * @returns {Object}      { success, fileId, url, category, clientId }
 */
function handleUploadPhoto(data) {
  const clientId = String(data.clientId || '').trim();
  const blobB64 = data.blob;
  const mimeType = data.mimeType || 'image/jpeg';
  const name = sanitizeName(data.name || 'photo.jpg');
  const category = String(data.category || 'general').trim() || 'general';

  if (!clientId) return errorResponse('Missing clientId (required for safe retries).');
  if (!blobB64) return errorResponse('Missing photo data.');

  const cache = CacheService.getScriptCache();
  const cacheKey = 'upload_' + clientId;
  const cached = cache.get(cacheKey);
  if (cached) {
    const prior = JSON.parse(cached);
    try {
      const f = DriveApp.getFileById(prior.fileId);
      return { success: true, fileId: f.getId(), url: f.getUrl(), category: prior.category, clientId, deduped: true };
    } catch (e) {
      // Cached file no longer exists — fall through and re-upload.
    }
  }

  let base64Data = blobB64;
  if (base64Data.indexOf('base64,') > -1) {
    base64Data = base64Data.split('base64,')[1];
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(base64Data);
  } catch (err) {
    return errorResponse('Could not decode photo data: ' + err.message);
  }

  const blob = Utilities.newBlob(bytes, mimeType, name);
  const tempFolder = getTempUploadsFolder_();
  blob.setName(category + '__' + clientId + '__' + name);
  const file = tempFolder.createFile(blob);

  cache.put(cacheKey, JSON.stringify({ fileId: file.getId(), category }), UPLOAD_DEDUPE_TTL_SECONDS);

  return { success: true, fileId: file.getId(), url: file.getUrl(), category, clientId };
}

/**
 * Trashes an uploaded photo (called when the inspector removes a thumb
 * before submitting). Best-effort — already-absent files are not an error.
 *
 * @param {Object} data  { fileId }
 * @returns {Object}      { success }
 */
function handleDeletePhoto(data) {
  const fileId = data.fileId;
  if (!fileId) return errorResponse('Missing fileId.');

  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    return { success: true };
  } catch (err) {
    return { success: true, note: 'File already absent: ' + err.message };
  }
}

// ─── Move on Submit ───────────────────────────────────────────────────────────

/**
 * Moves already-uploaded photos from the temp folder into the property's
 * Inspection Photos category subfolders. Idempotent — safe to call again
 * on a retried submit; files already in place are left untouched.
 *
 * @param {string} property  Property address
 * @param {Object} photos    { category: [{ fileId, name }] }
 * @returns {{ folderUrl: string, moveErrors: Array }}
 */
function movePhotosForSubmission(property, photos) {
  const propertiesFolder = DriveApp.getFolderById(PROPERTIES_FOLDER_ID);
  const propertyFolder = getOrCreateFolder(propertiesFolder, sanitizeName(property || 'Unknown Property'));
  const inspectionPhotosFolder = getOrCreateFolder(propertyFolder, INSPECTION_PHOTOS_FOLDER_NAME);

  const moveErrors = [];
  const categories = Object.keys(photos || {});

  categories.forEach(category => {
    const items = Array.isArray(photos[category]) ? photos[category] : [];
    if (!items.length) return;

    const displayName = PHOTO_CATEGORY_MAP[category] || (category.charAt(0).toUpperCase() + category.slice(1));
    const categoryFolder = getOrCreateFolder(inspectionPhotosFolder, displayName);

    items.forEach(item => {
      const fileId = item && item.fileId;
      if (!fileId) {
        moveErrors.push({ category, name: item && item.name, error: 'Missing fileId.' });
        return;
      }
      try {
        moveFileIntoFolder_(fileId, categoryFolder);
      } catch (err) {
        moveErrors.push({ category, fileId, name: item && item.name, error: String(err.message || err) });
      }
    });
  });

  return { folderUrl: inspectionPhotosFolder.getUrl(), moveErrors };
}

/**
 * Moves a file into targetFolder, removing it from all other parents.
 * No-op if the file is already only parented there.
 *
 * @param {string}          fileId       Drive file ID
 * @param {DriveApp.Folder} targetFolder Destination folder
 */
function moveFileIntoFolder_(fileId, targetFolder) {
  const file = DriveApp.getFileById(fileId);
  const parents = file.getParents();

  let alreadyThere = false;
  const oldParents = [];
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() === targetFolder.getId()) {
      alreadyThere = true;
    } else {
      oldParents.push(p);
    }
  }

  if (!alreadyThere) {
    targetFolder.addFile(file);
  }
  oldParents.forEach(p => p.removeFile(file));
}
