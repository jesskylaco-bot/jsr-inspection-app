/* =================================================================
   Johnson Signature Realty — Property Inspection Report
   script.js  —  vanilla ES6, no dependencies

   Photo upload architecture (scalable):
   - The instant an inspector picks photos for a category, each one
     is compressed client-side and uploaded to the backend ONE AT A
     TIME (small concurrency-limited queue), landing in a shared
     Temp Uploads folder in Drive. The browser only ever keeps the
     returned { fileId, url } plus a thumbnail preview — never a
     pile of base64 blobs waiting for Submit.
   - Submit sends form answers + the list of {fileId, name} per
     category. No image bytes travel in the submit request, so it
     stays small and fast no matter how many photos were taken.
   - Uploads can fail (flaky field connection); each photo tracks its
     own status and can be retried individually without restarting
     the inspection. Already-uploaded photos survive a page reload
     (persisted to localStorage) so a refresh doesn't lose progress.
   ================================================================= */
'use strict';

/* -----------------------------------------------------------------
   Tunables
   ----------------------------------------------------------------- */

const PHOTO_MAX_DIM  = 1600;   // px on the longest edge
const PHOTO_QUALITY  = 0.7;    // JPEG quality 0–1
const UPLOAD_CONCURRENCY = 2;  // simultaneous in-flight uploads

// Photo categories → must match the backend's CONFIG.CATEGORIES.
const PHOTO_CATEGORIES = ['exterior', 'kitchen', 'bathroom', 'utility', 'roof', 'general'];

const STORAGE_KEY = 'jsr_inspection_photos_v1';

const LOADING_MESSAGES = [
  'Submitting Inspection…',
  'Filing Photos…',
  'Generating PDF Report…',
  'Saving Report…',
  'Almost Done…',
];

/* -----------------------------------------------------------------
   App state
   ----------------------------------------------------------------- */
let allProperties    = [];
let selectedProperty = null;
let propertyLoadFailed = false;
let isSubmitting     = false;
let loadingTimer     = null;

/**
 * photos: one entry per picked file, independent of form submission.
 * { clientId, category, name, mimeType, previewUrl,
 *   status: 'uploading' | 'uploaded' | 'failed',
 *   fileId, driveUrl, error, file }   (file kept only for retry, never persisted)
 */
let photos = [];
let uploadQueue = [];
let activeUploads = 0;

/* -----------------------------------------------------------------
   Boot
   ----------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  initDateFields();
  initLogoFallback();
  initPropertyCombobox();
  restorePersistedPhotos();
  initPhotoUpload();
  initProgress();
  initValidationClearing();
  initSuccessButtons();
  initErrorToast();
  loadProperties();

  document.getElementById('inspectionForm')
    .addEventListener('submit', handleSubmit);
});

/* =================================================================
   Date + logo
   ================================================================= */

function initDateFields() {
  const now = new Date();
  document.getElementById('todayDate').textContent =
    now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const dateInput = document.getElementById('inspectionDate');
  if (!dateInput.value) dateInput.value = toLocalISODate(now);
}

function toLocalISODate(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function initLogoFallback() {
  const logo = document.getElementById('brandLogo');
  const fallback = document.getElementById('brandLogoFallback');
  if (!logo) return;
  logo.addEventListener('error', () => {
    logo.hidden = true;
    if (fallback) fallback.hidden = false;
  });
}

/* =================================================================
   Properties — load + searchable combobox
   ================================================================= */

async function loadProperties() {
  const status = document.getElementById('propertyStatus');
  try {
    const res = await fetch(`${CONFIG.WEB_APP_URL}?action=getProperties`, { method: 'GET' });
    const text = await res.text();
    const data = JSON.parse(text);

    const list = Array.isArray(data) ? data
               : Array.isArray(data.properties) ? data.properties
               : Array.isArray(data.data) ? data.data
               : null;

    if (!list) throw new Error('Unexpected response shape');

    allProperties = list.map(normalizeProperty).filter(p => p.value);
    if (allProperties.length === 0) throw new Error('Empty property list');

    status.textContent = `${allProperties.length} properties loaded — search by street, city, or ZIP.`;
  } catch (err) {
    propertyLoadFailed = true;
    status.textContent = 'Could not load the property list — type the full property address manually.';
    status.style.color = 'var(--danger)';
  }
}

function normalizeProperty(item) {
  if (typeof item === 'string') {
    return { value: item.trim(), label: item.trim(), fullAddress: item.trim(), search: item.toLowerCase() };
  }
  const street = String(item.property || item.address || item.name || '').trim();
  const city   = String(item.city  || '').trim();
  const state  = String(item.state || '').trim();
  const zip    = String(item.zip   || '').trim();

  const tail = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const label = tail ? `${street} — ${tail}` : street;
  const fullAddress = tail ? `${street}, ${tail}` : street;

  return {
    value: street,
    label,
    fullAddress,
    search: `${street} ${city} ${state} ${zip}`.toLowerCase(),
  };
}

function initPropertyCombobox() {
  const input = document.getElementById('propertySearch');
  const list  = document.getElementById('propertyList');
  const hidden = document.getElementById('property');
  let activeIndex = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  };

  const open = () => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const render = (query) => {
    const q = query.trim().toLowerCase();

    if (propertyLoadFailed) {
      hidden.value = input.value.trim();
      selectedProperty = hidden.value ? { value: hidden.value, fullAddress: hidden.value } : null;
      updateProgress();
      close();
      return;
    }

    const matches = q
      ? allProperties.filter(p => p.search.includes(q)).slice(0, 60)
      : allProperties.slice(0, 60);

    list.innerHTML = '';
    if (matches.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matching properties';
      list.appendChild(li);
      open();
      return;
    }

    matches.forEach((p) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.value = p.value;
      const dashIdx = p.label.indexOf(' — ');
      if (dashIdx > -1) {
        li.innerHTML = `${escapeHtml(p.label.slice(0, dashIdx))}<small>${escapeHtml(p.label.slice(dashIdx + 3))}</small>`;
      } else {
        li.textContent = p.label;
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(p);
      });
      list.appendChild(li);
    });
    activeIndex = -1;
    open();
  };

  const choose = (p) => {
    selectedProperty = p;
    input.value = p.label;
    hidden.value = p.value;
    clearFieldError(hidden);
    updateProgress();
    close();
  };

  input.addEventListener('input', () => {
    if (!propertyLoadFailed) { hidden.value = ''; selectedProperty = null; }
    render(input.value);
  });

  input.addEventListener('focus', () => { if (!propertyLoadFailed) render(input.value); });

  input.addEventListener('keydown', (e) => {
    const options = Array.from(list.querySelectorAll('li[role="option"]'));
    if (list.hidden || options.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = e.key === 'ArrowDown'
        ? Math.min(activeIndex + 1, options.length - 1)
        : Math.max(activeIndex - 1, 0);
      options.forEach((li, i) => li.setAttribute('aria-selected', i === activeIndex));
      options[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIndex > -1) {
      e.preventDefault();
      const val = options[activeIndex].dataset.value;
      const p = allProperties.find(x => x.value === val);
      if (p) choose(p);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('propertyCombo').contains(e.target)) close();
  });
}

/* =================================================================
   Photos — pick → compress → upload immediately → track status
   ================================================================= */

function initPhotoUpload() {
  PHOTO_CATEGORIES.forEach(category => {
    const input = document.getElementById(category + 'Photos');
    if (!input) return;
    input.addEventListener('change', () => {
      handleFilesPicked(category, input.files);
      input.value = '';
    });
  });

  // Retry / remove — event delegation, one listener per category thumb grid.
  PHOTO_CATEGORIES.forEach(category => {
    const thumbs = document.getElementById(category + 'Thumbs');
    if (!thumbs) return;
    thumbs.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.thumb-remove');
      const retryBtn  = e.target.closest('.thumb-retry');
      const id = (removeBtn || retryBtn)?.closest('.thumb')?.dataset.id;
      if (!id) return;

      if (removeBtn) removePhoto(id);
      else if (retryBtn) retryPhoto(id);
    });
  });
}

/** A new batch of files was picked for a category: preview + enqueue uploads. */
async function handleFilesPicked(category, fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));

  for (const file of files) {
    const clientId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let previewUrl;
    let uploadBlob;

    try {
      previewUrl = await compressImage(file);
      uploadBlob = previewUrl; // compressed JPEG data URL doubles as the upload payload
    } catch (err) {
      try {
        previewUrl = await readAsDataURL(file);
        uploadBlob = previewUrl;
      } catch (_) {
        continue; // unreadable file — skip it
      }
    }

    const photo = {
      clientId,
      category,
      name: file.name || 'photo.jpg',
      mimeType: 'image/jpeg',
      previewUrl,
      status: 'uploading',
      fileId: null,
      driveUrl: null,
      error: null,
      _blob: uploadBlob,
    };

    photos.push(photo);
    renderThumbs(category);
    queueUpload(photo);
  }
}

/** Concurrency-limited upload queue so a 50–200 photo inspection never floods the network. */
function queueUpload(photo) {
  uploadQueue.push(photo);
  drainUploadQueue();
}

function drainUploadQueue() {
  while (activeUploads < UPLOAD_CONCURRENCY && uploadQueue.length > 0) {
    const photo = uploadQueue.shift();
    activeUploads++;
    uploadPhoto(photo).finally(() => {
      activeUploads--;
      drainUploadQueue();
    });
  }
}

async function uploadPhoto(photo) {
  photo.status = 'uploading';
  photo.error = null;
  renderThumbs(photo.category);

  try {
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'uploadPhoto',
        clientId: photo.clientId,
        category: photo.category,
        name: photo.name,
        mimeType: photo.mimeType,
        blob: photo._blob.split(',')[1] || '',
      }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('Upload failed: invalid server response.'); }

    if (!res.ok || !data.success) {
      throw new Error(data?.error || 'Upload failed.');
    }

    photo.status = 'uploaded';
    photo.fileId = data.fileId;
    photo.driveUrl = data.url || null;
    photo.error = null;
  } catch (err) {
    photo.status = 'failed';
    photo.error = (typeof navigator !== 'undefined' && navigator.onLine === false)
      ? 'Offline — will need a retry.'
      : (err.message || 'Upload failed.');
  }

  persistPhotos();
  renderThumbs(photo.category);
}

function retryPhoto(clientId) {
  const photo = photos.find(p => p.clientId === clientId);
  if (!photo) return;
  queueUpload(photo);
}

function removePhoto(clientId) {
  const photo = photos.find(p => p.clientId === clientId);
  if (!photo) return;

  photos = photos.filter(p => p.clientId !== clientId);
  uploadQueue = uploadQueue.filter(p => p.clientId !== clientId);
  persistPhotos();
  renderThumbs(photo.category);

  // Best-effort cleanup of the temp file; the inspector doesn't need to wait on this.
  if (photo.fileId) {
    fetch(CONFIG.WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'deletePhoto', fileId: photo.fileId }),
    }).catch(() => {});
  }
}

/** Draw the image to a canvas, scaled down, and export as a JPEG data URL. */
function compressImage(file, maxDim = PHOTO_MAX_DIM, quality = PHOTO_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width >= height && width > maxDim) {
        height = Math.round(height * maxDim / width); width = maxDim;
      } else if (height > maxDim) {
        width = Math.round(width * maxDim / height); height = maxDim;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
    img.src = url;
  });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

/** Render thumbnails (with upload status) for one category. */
function renderThumbs(category) {
  const thumbs = document.getElementById(category + 'Thumbs');
  if (!thumbs) return;
  thumbs.innerHTML = '';

  const catPhotos = photos.filter(p => p.category === category);

  catPhotos.forEach(p => {
    const div = document.createElement('div');
    div.className = 'thumb thumb-' + p.status;
    div.dataset.id = p.clientId;

    const img = document.createElement('img');
    img.src = p.previewUrl || '';
    img.alt = p.name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'thumb-remove';
    remove.setAttribute('aria-label', `Remove ${p.name}`);
    remove.textContent = '×';

    div.append(img, remove);

    if (p.status === 'uploading') {
      const badge = document.createElement('div');
      badge.className = 'thumb-status thumb-status-uploading';
      badge.innerHTML = '<span class="thumb-spinner" aria-hidden="true"></span> Uploading…';
      div.appendChild(badge);
    } else if (p.status === 'uploaded') {
      const badge = document.createElement('div');
      badge.className = 'thumb-status thumb-status-uploaded';
      badge.textContent = '✓ Uploaded';
      div.appendChild(badge);
    } else if (p.status === 'failed') {
      const badge = document.createElement('div');
      badge.className = 'thumb-status thumb-status-failed';
      badge.textContent = p.error || 'Upload failed';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'thumb-retry';
      retry.textContent = 'Retry';
      div.append(badge, retry);
    }

    thumbs.appendChild(div);
  });

  updatePhotoSummary();
}

function updatePhotoSummary() {
  const el = document.getElementById('photoUploadSummary');
  if (!el) return;
  const total = photos.length;
  if (total === 0) { el.textContent = ''; return; }
  const uploaded = photos.filter(p => p.status === 'uploaded').length;
  const failed = photos.filter(p => p.status === 'failed').length;
  const uploading = photos.filter(p => p.status === 'uploading').length;

  let msg = `${uploaded} of ${total} photo${total === 1 ? '' : 's'} uploaded.`;
  if (uploading) msg += ` ${uploading} uploading…`;
  if (failed) msg += ` ${failed} failed — tap Retry on each.`;
  el.textContent = msg;
  el.classList.toggle('has-failures', failed > 0);
}

/** Group uploaded photos into the backend's {category: [{fileId,name}]} shape. */
function buildPhotoManifest() {
  const manifest = {};
  PHOTO_CATEGORIES.forEach(c => { manifest[c] = []; });
  photos.filter(p => p.status === 'uploaded').forEach(p => {
    if (!manifest[p.category]) manifest[p.category] = [];
    manifest[p.category].push({ fileId: p.fileId, name: p.name });
  });
  return manifest;
}

/* -----------------------------------------------------------------
   Persistence — survive a page reload mid-inspection without losing
   already-uploaded photos (their bytes are safely in Drive already;
   only the in-progress browser File objects can't survive a reload).
   ----------------------------------------------------------------- */

function persistPhotos() {
  try {
    const durable = photos
      .filter(p => p.status === 'uploaded')
      .map(p => ({ clientId: p.clientId, category: p.category, name: p.name, fileId: p.fileId, driveUrl: p.driveUrl }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(durable));
  } catch (_) { /* storage full/unavailable — non-fatal */ }
}

function restorePersistedPhotos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const durable = JSON.parse(raw);
    if (!Array.isArray(durable)) return;

    photos = durable.map(p => ({
      clientId: p.clientId,
      category: p.category,
      name: p.name,
      mimeType: 'image/jpeg',
      previewUrl: p.driveUrl || '',
      status: 'uploaded',
      fileId: p.fileId,
      driveUrl: p.driveUrl,
      error: null,
      _blob: null,
    }));

    PHOTO_CATEGORIES.forEach(renderThumbs);
  } catch (_) { /* corrupt storage — ignore and start fresh */ }
}

function clearPersistedPhotos() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
}

/* =================================================================
   Progress
   ================================================================= */

function initProgress() {
  const form = document.getElementById('inspectionForm');
  form.addEventListener('input', updateProgress);
  form.addEventListener('change', updateProgress);
  updateProgress();
}

function updateProgress() {
  const form = document.getElementById('inspectionForm');
  const controls = form.querySelectorAll('input[name], select[name], textarea[name]');
  const groups = new Map();

  controls.forEach(el => {
    const name = el.name;
    if (el.type === 'radio' || el.type === 'checkbox') {
      if (!groups.has(name)) groups.set(name, false);
      if (el.checked) groups.set(name, true);
    } else {
      groups.set(name, el.value.trim() !== '');
    }
  });

  const total = groups.size;
  let done = 0;
  groups.forEach(v => { if (v) done++; });
  const pct = total ? Math.round((done / total) * 100) : 0;

  const fill = document.getElementById('progressFill');
  fill.style.width = `${pct}%`;
  fill.setAttribute('aria-valuenow', String(pct));
  document.getElementById('progressPct').textContent = `${pct}%`;
}

/* =================================================================
   Validation
   ================================================================= */

const REQUIRED_FIELDS = [
  { id: 'property',        focus: 'propertySearch', msg: 'Please select a property.' },
  { id: 'inspectionDate',  msg: 'Inspection date is required.' },
  { id: 'inspectorName',   msg: 'Inspector name is required.' },
  { id: 'inspectorEmail',  msg: 'A valid email is required.' },
  { id: 'roofCondition',   msg: 'Roof condition is required.' },
];

function validateForm() {
  let firstInvalid = null;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  REQUIRED_FIELDS.forEach(rule => {
    const el = document.getElementById(rule.id);
    let invalid = !el.value || el.value.trim() === '';
    if (rule.id === 'inspectorEmail' && !invalid) invalid = !emailRe.test(el.value.trim());

    if (invalid) {
      setFieldError(el, rule.msg);
      if (!firstInvalid) firstInvalid = rule.focus ? document.getElementById(rule.focus) : el;
    } else {
      clearFieldError(el);
    }
  });

  return firstInvalid;
}

/** Photos must all have finished uploading (or been removed) before submit. */
function validatePhotosReady() {
  if (photos.some(p => p.status === 'uploading')) {
    return 'Photos are still uploading — please wait a moment and try again.';
  }
  if (photos.some(p => p.status === 'failed')) {
    return 'Some photos failed to upload. Retry or remove them before submitting.';
  }
  return null;
}

function setFieldError(el, message) {
  const field = el.closest('.field');
  if (field) field.classList.add('invalid');
  const err = document.getElementById(`${el.id}-error`);
  if (err) { err.textContent = message; err.hidden = false; }
}

function clearFieldError(el) {
  const field = el.closest('.field');
  if (field && field.classList.contains('invalid')) {
    field.classList.remove('invalid');
    const err = field.querySelector('.field-error');
    if (err) err.hidden = true;
  }
}

function initValidationClearing() {
  const form = document.getElementById('inspectionForm');
  form.addEventListener('input',  (e) => clearFieldError(e.target));
  form.addEventListener('change', (e) => clearFieldError(e.target));
}

function revealError(control) {
  const card = control.closest('details');
  if (card && !card.open) card.open = true;
  control.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => control.focus({ preventScroll: true }), 300);
}

/* =================================================================
   Submit  —  metadata only; photos already live in Drive.
   ================================================================= */

async function handleSubmit(e) {
  e.preventDefault();
  if (isSubmitting) return;

  const firstInvalid = validateForm();
  if (firstInvalid) { revealError(firstInvalid); return; }

  const photoIssue = validatePhotosReady();
  if (photoIssue) { showError(photoIssue); return; }

  isSubmitting = true;
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  showLoading();

  try {
    const payload = collectFormData();
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('The server returned an unexpected response.'); }

    if (!data.success) {
      throw new Error(data && data.error ? data.error : 'The report could not be generated. Please try again.');
    }

    // Submit hands off to async processing on the backend (moving photos +
    // generating the PDF can take longer than the proxy's request timeout
    // for large photo counts), so poll until the job finishes.
    const finalData = data.status === 'processing'
      ? await pollSubmissionStatus(data.inspectionId)
      : data;

    hideLoading();
    clearPersistedPhotos();
    showSuccess(finalData);
    deliverPdf(finalData.pdfUrl);
  } catch (err) {
    hideLoading();
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
    // Submission is safe to retry: photos already in Drive are never re-uploaded,
    // and the backend re-files idempotently on a repeat Submit.
    showError(offline ? 'You appear to be offline. Check your connection and press Submit again.' : err.message);
  } finally {
    isSubmitting = false;
    btn.disabled = false;
  }
}

/**
 * Polls ?action=checkStatus&inspectionId=... until the backend job
 * finishes (status flips from "pending" to "complete"/"error").
 *
 * @param {string} inspectionId
 * @returns {Promise<Object>}  The final job result (success/error shape)
 */
async function pollSubmissionStatus(inspectionId) {
  const POLL_INTERVAL_MS = 3000;
  const MAX_ATTEMPTS = 100; // ~5 minutes

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const res = await fetch(
      `${CONFIG.WEB_APP_URL}?action=checkStatus&inspectionId=${encodeURIComponent(inspectionId)}`,
      { method: 'GET' }
    );
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { continue; } // transient bad response — keep polling

    if (data.status === 'pending') continue;

    if (!data.success) {
      throw new Error(data.error || 'The report could not be generated. Please try again.');
    }
    return data;
  }

  throw new Error('Still processing — this is taking longer than usual. Check back in a minute; your submission was not lost.');
}

/** Build the JSON payload the backend expects — answers + photo metadata only. */
function collectFormData() {
  const form = document.getElementById('inspectionForm');
  const fd = new FormData(form);
  const data = { action: 'submit' };

  for (const [key, val] of fd.entries()) {
    if (key === 'appliances') continue;
    data[key] = val;
  }

  data.appliances = fd.getAll('appliances').join(', ');
  data.photos = buildPhotoManifest();

  return data;
}

/* =================================================================
   PDF delivery
   ================================================================= */

function deliverPdf(pdfUrl) {
  if (!pdfUrl) return;
  window.open(pdfUrl, '_blank');
}

/* =================================================================
   Loading overlay
   ================================================================= */

function showLoading() {
  const overlay = document.getElementById('loadingOverlay');
  const msg = document.getElementById('loadingMsg');
  let i = 0;
  msg.textContent = LOADING_MESSAGES[0];
  overlay.hidden = false;
  loadingTimer = setInterval(() => {
    i = Math.min(i + 1, LOADING_MESSAGES.length - 1);
    msg.textContent = LOADING_MESSAGES[i];
  }, 1800);
}

function hideLoading() {
  clearInterval(loadingTimer);
  document.getElementById('loadingOverlay').hidden = true;
}

/* =================================================================
   Success screen
   ================================================================= */

let lastPdfUrl = null;

function showSuccess(data) {
  document.getElementById('successId').textContent       = data.inspectionId || '—';
  document.getElementById('successProperty').textContent = data.property || document.getElementById('property').value || '—';
  document.getElementById('successDate').textContent     = data.inspectionDate || document.getElementById('inspectionDate').value || '—';

  lastPdfUrl = data.pdfUrl || null;

  const downloadAgainBtn = document.getElementById('downloadAgainBtn');
  downloadAgainBtn.hidden = !lastPdfUrl;

  document.getElementById('successOverlay').hidden = false;
}

function initSuccessButtons() {
  document.getElementById('downloadAgainBtn').addEventListener('click', () => {
    if (lastPdfUrl) window.open(lastPdfUrl, '_blank');
  });
  document.getElementById('newInspectionBtn').addEventListener('click', resetForNewInspection);
}

function resetForNewInspection() {
  const form = document.getElementById('inspectionForm');
  form.reset();
  photos = [];
  uploadQueue = [];
  clearPersistedPhotos();
  PHOTO_CATEGORIES.forEach(renderThumbs);
  selectedProperty = null;

  document.getElementById('property').value = '';
  document.getElementById('propertySearch').value = '';
  initDateFields();
  updateProgress();

  form.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
  form.querySelectorAll('.field-error').forEach(e => { e.hidden = true; });

  const cards = form.querySelectorAll('details.card');
  cards.forEach((c, i) => { c.open = (i === 0); });

  document.getElementById('successOverlay').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =================================================================
   Error toast
   ================================================================= */

function initErrorToast() {
  document.getElementById('errorCloseBtn').addEventListener('click', hideError);
  document.getElementById('errorRetryBtn').addEventListener('click', () => {
    hideError();
    document.getElementById('inspectionForm')
      .dispatchEvent(new Event('submit', { cancelable: true }));
  });
}

function showError(message) {
  document.getElementById('errorToastMsg').textContent = message || 'Something went wrong. Please try again.';
  document.getElementById('errorToast').hidden = false;
}

function hideError() {
  document.getElementById('errorToast').hidden = true;
}

/* =================================================================
   Utils
   ================================================================= */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
