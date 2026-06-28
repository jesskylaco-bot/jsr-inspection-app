/* =================================================================
   Johnson Signature Realty — Property Inspection Report
   script.js  —  vanilla ES6, no dependencies
   Talks to the existing Google Apps Script backend (see config.js).
   ================================================================= */
'use strict';

/* -----------------------------------------------------------------
   Tunables
   ----------------------------------------------------------------- */

// The Master Property DB stores street / city / state / zip separately.
// The backend keys its folder lookup on the `property` column (the street),
// so we submit the street value by default. If a live submission ever saves
// the property blank or mismatched, flip this to true to send the full
// "Street, City STATE ZIP" string instead — that's the only change needed.
const SUBMIT_FULL_ADDRESS = false;

// Image compression targets (keeps uploads small + fast over field data).
const PHOTO_MAX_DIM  = 1600;   // px on the longest edge
const PHOTO_QUALITY  = 0.7;    // JPEG quality 0–1

// Photo categories → must match the backend buckets exactly.
const PHOTO_CATEGORIES = ['general', 'exterior', 'kitchen', 'bathroom', 'utility', 'roof'];

// Loading overlay message sequence.
const LOADING_MESSAGES = [
  'Submitting Inspection…',
  'Uploading Photos…',
  'Generating PDF Report…',
  'Saving Report…',
  'Almost Done…',
];

/* -----------------------------------------------------------------
   App state
   ----------------------------------------------------------------- */
let allProperties   = [];     // normalized [{ value, label, fullAddress, search }]
let selectedProperty = null;  // the chosen property object
let propertyLoadFailed = false;
let photos          = [];     // [{ id, name, mimeType, dataUrl }]
let isSubmitting    = false;
let loadingTimer    = null;

/* -----------------------------------------------------------------
   Boot
   ----------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  initDateFields();
  initLogoFallback();
  initPropertyCombobox();
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

/** Set the header date and default the Inspection Date to today (local). */
function initDateFields() {
  const now = new Date();
  document.getElementById('todayDate').textContent =
    now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const dateInput = document.getElementById('inspectionDate');
  if (!dateInput.value) dateInput.value = toLocalISODate(now);
}

/** YYYY-MM-DD in the user's local timezone (not UTC). */
function toLocalISODate(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/** If the logo image fails to load, swap in the text fallback. */
function initLogoFallback() {
  const logo = document.getElementById('brandLogo');
  const fallback = document.getElementById('brandLogoFallback');
  logo.addEventListener('error', () => {
    logo.hidden = true;
    fallback.hidden = false;
  });
}

/* =================================================================
   Properties — load + searchable combobox
   ================================================================= */

/** Fetch the property list from the backend and populate state. */
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
    // Graceful degradation: let the inspector type the address by hand.
    propertyLoadFailed = true;
    status.textContent = 'Could not load the property list — type the full property address manually.';
    status.style.color = 'var(--danger)';
  }
}

/** Normalize a backend property (object or plain string) into our shape. */
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

/** Wire up the searchable property combobox (input + filtered listbox). */
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

  /** Render filtered options. */
  const render = (query) => {
    const q = query.trim().toLowerCase();

    // Fallback mode: no list to filter — the typed text IS the value.
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

    matches.forEach((p, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.value = p.value;
      // street as the main line, city/zip as a sub-line
      const dashIdx = p.label.indexOf(' — ');
      if (dashIdx > -1) {
        li.innerHTML = `${escapeHtml(p.label.slice(0, dashIdx))}<small>${escapeHtml(p.label.slice(dashIdx + 3))}</small>`;
      } else {
        li.textContent = p.label;
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();           // keep focus, fire before blur
        choose(p);
      });
      list.appendChild(li);
    });
    activeIndex = -1;
    open();
  };

  /** Commit a selection. */
  const choose = (p) => {
    selectedProperty = p;
    input.value = p.label;
    hidden.value = p.value;
    clearFieldError(hidden);
    updateProgress();
    close();
  };

  // Typing filters the list and invalidates any prior selection.
  input.addEventListener('input', () => {
    if (!propertyLoadFailed) { hidden.value = ''; selectedProperty = null; }
    render(input.value);
  });

  input.addEventListener('focus', () => { if (!propertyLoadFailed) render(input.value); });

  // Keyboard navigation.
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

  // Close when focus leaves the combo.
  document.addEventListener('click', (e) => {
    if (!document.getElementById('propertyCombo').contains(e.target)) close();
  });
}

/* =================================================================
   Photos — pick / drop / compress / preview
   ================================================================= */

function initPhotoUpload() {
  const dropzone = document.getElementById('dropzone');
  const input    = document.getElementById('photoInput');
  const thumbs   = document.getElementById('thumbs');

  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });

  // Keyboard activation of the dropzone.
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });

  // Drag & drop.
  ['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => { if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files); });

  // Remove + category change (event delegation).
  thumbs.addEventListener('click', (e) => {
    const btn = e.target.closest('.thumb-remove');
    if (!btn) return;
    const id = btn.closest('.thumb').dataset.id;
    photos = photos.filter(p => p.id !== id);
    renderThumbs();
  });
  thumbs.addEventListener('change', (e) => {
    const sel = e.target.closest('.thumb-cat');
    if (!sel) return;
    const id = sel.closest('.thumb').dataset.id;
    const p = photos.find(x => x.id === id);
    if (p) p.category = sel.value;
  });
}

/** Process a FileList: compress images, store, re-render. */
async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  for (const file of files) {
    try {
      const dataUrl = await compressImage(file);
      photos.push({
        id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: file.name || 'photo.jpg',
        mimeType: 'image/jpeg',
        dataUrl,
        category: 'general',
      });
    } catch (err) {
      // Compression failed (e.g. odd format) — fall back to the raw file.
      try {
        const dataUrl = await readAsDataURL(file);
        photos.push({
          id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: file.name || 'photo',
          mimeType: file.type || 'image/jpeg',
          dataUrl,
          category: 'general',
        });
      } catch (_) { /* skip this file */ }
    }
  }
  renderThumbs();
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

/** Read a file as a base64 data URL (fallback when compression can't run). */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

/** Render thumbnails with remove buttons and category selects. */
function renderThumbs() {
  const thumbs = document.getElementById('thumbs');
  thumbs.innerHTML = '';
  photos.forEach(p => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.dataset.id = p.id;

    const img = document.createElement('img');
    img.src = p.dataUrl;
    img.alt = p.name;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'thumb-remove';
    remove.setAttribute('aria-label', `Remove ${p.name}`);
    remove.textContent = '×';

    const cat = document.createElement('select');
    cat.className = 'thumb-cat';
    cat.setAttribute('aria-label', 'Photo category');
    PHOTO_CATEGORIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
      if (c === p.category) opt.selected = true;
      cat.appendChild(opt);
    });

    div.append(img, remove, cat);
    thumbs.appendChild(div);
  });
  document.getElementById('photoCount').textContent = String(photos.length);
}

/** Group photos into the backend bucket structure. */
function buildPhotoBuckets() {
  const buckets = { exterior: [], kitchen: [], bathroom: [], utility: [], roof: [], general: [] };
  photos.forEach(p => {
    const cat = buckets[p.category] ? p.category : 'general';
    buckets[cat].push({
      blob: p.dataUrl.split(',')[1] || '',  // raw base64 (no data: prefix)
      mimeType: p.mimeType,
      name: p.name,
    });
  });
  return buckets;
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

/** Percentage = filled tracked fields / total tracked fields. */
function updateProgress() {
  const form = document.getElementById('inspectionForm');
  const controls = form.querySelectorAll('input[name], select[name], textarea[name]');
  const groups = new Map(); // field name -> complete?

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

/** Validate required fields. Returns the first invalid control, or null. */
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

/** Clear a field's error as soon as the user starts fixing it. */
function initValidationClearing() {
  const form = document.getElementById('inspectionForm');
  form.addEventListener('input',  (e) => clearFieldError(e.target));
  form.addEventListener('change', (e) => clearFieldError(e.target));
}

/** Open the section containing the field, scroll to it, and focus it. */
function revealError(control) {
  const card = control.closest('details');
  if (card && !card.open) card.open = true;          // exclusive accordion closes the rest
  control.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => control.focus({ preventScroll: true }), 300);
}

/* =================================================================
   Submit
   ================================================================= */

async function handleSubmit(e) {
  e.preventDefault();
  if (isSubmitting) return;

  const firstInvalid = validateForm();
  if (firstInvalid) { revealError(firstInvalid); return; }

  isSubmitting = true;
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  showLoading();

  try {
    const payload = collectFormData();
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request (no CORS preflight);
      // Apps Script still reads it via e.postData.contents.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('The server returned an unexpected response.'); }

    if (!res.ok || !data.success) {
      throw new Error(data && data.error ? data.error : 'The report could not be generated. Please try again.');
    }

    hideLoading();
    showSuccess(data);
    deliverPdf(data.pdfUrl);
  } catch (err) {
    hideLoading();
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
    showError(offline ? 'You appear to be offline. Check your connection and retry.' : err.message);
  } finally {
    isSubmitting = false;
    btn.disabled = false;
  }
}

/** Build the JSON payload the backend expects. */
function collectFormData() {
  const form = document.getElementById('inspectionForm');
  const fd = new FormData(form);
  const data = {};

  for (const [key, val] of fd.entries()) {
    if (key === 'appliances') continue;   // handled below (multi-value)
    data[key] = val;
  }

  // Appliances: join the checked boxes into one string (matches backend).
  data.appliances = fd.getAll('appliances').join(', ');

  // Property: street value by default, full address if the flag is set.
  if (SUBMIT_FULL_ADDRESS && selectedProperty) {
    data.property = selectedProperty.fullAddress;
  }

  // Photos: grouped into the backend bucket structure.
  data.photos = buildPhotoBuckets();

  return data;
}

/* =================================================================
   PDF delivery
   ================================================================= */

/** Try to hand the inspector the PDF immediately; fall back to a new tab. */
function deliverPdf(pdfUrl) {
  if (!pdfUrl) return;
  // Drive URLs are cross-origin, so a forced download usually isn't possible;
  // opening in a new tab is the reliable path (and the Open PDF button remains).
  const win = window.open(pdfUrl, '_blank');
  if (!win) {
    // Popup blocked — the visible "Open PDF" button covers this case.
  }
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

function showSuccess(data) {
  document.getElementById('successId').textContent       = data.inspectionId || '—';
  document.getElementById('successProperty').textContent = data.property || document.getElementById('property').value || '—';
  document.getElementById('successDate').textContent     = data.inspectionDate || document.getElementById('inspectionDate').value || '—';

  const openBtn = document.getElementById('openPdfBtn');
  if (data.pdfUrl) { openBtn.href = data.pdfUrl; openBtn.hidden = false; }
  else { openBtn.hidden = true; }

  document.getElementById('successOverlay').hidden = false;
}

function initSuccessButtons() {
  document.getElementById('downloadAgainBtn').addEventListener('click', () => {
    const url = document.getElementById('openPdfBtn').href;
    if (url && url !== '#') window.open(url, '_blank');
  });
  document.getElementById('newInspectionBtn').addEventListener('click', resetForNewInspection);
}

/** Reset everything for a fresh inspection. */
function resetForNewInspection() {
  const form = document.getElementById('inspectionForm');
  form.reset();
  photos = [];
  selectedProperty = null;
  renderThumbs();

  document.getElementById('property').value = '';
  document.getElementById('propertySearch').value = '';
  initDateFields();
  updateProgress();

  // Clear any lingering error styling.
  form.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
  form.querySelectorAll('.field-error').forEach(e => { e.hidden = true; });

  // Re-open the first section only.
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
