/* =================================================================
   Johnson Signature Realty — Property Inspection Report
   script.js — Optimized for "Link-Only" Upload Strategy
   ================================================================= */
'use strict';

const PHOTO_FOLDER_URL = "https://drive.google.com/drive/folders/1yXXK8_rirl4DB2dN03chb4EPz55fHo3M?usp=sharing";

document.addEventListener('DOMContentLoaded', () => {
  initDateFields();
  initPropertyCombobox();
  initProgress();
  initValidationClearing();
  initSuccessButtons();
  initErrorToast();
  loadProperties();

  document.getElementById('inspectionForm').addEventListener('submit', handleSubmit);
});

/* =================================================================
   Form Submission (The Fixed Link-Only Version)
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
    
    // We send to your Web App URL (defined in your existing config)
    const res = await fetch(CONFIG.WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('Server returned an invalid response.'); }

    if (!res.ok || !data.success) {
      throw new Error(data?.error || 'Report generation failed.');
    }

    hideLoading();
    showSuccess(data);
    deliverPdf(data.pdfUrl);
  } catch (err) {
    hideLoading();
    showError(err.message);
  } finally {
    isSubmitting = false;
    btn.disabled = false;
  }
}

function collectFormData() {
  const form = document.getElementById('inspectionForm');
  const fd = new FormData(form);
  const data = {};

  for (const [key, val] of fd.entries()) {
    if (key === 'appliances') continue;
    data[key] = val;
  }

  data.appliances = fd.getAll('appliances').join(', ');
  // Inject the photo link into the data object instead of massive photo arrays
  data.photoFolderUrl = PHOTO_FOLDER_URL;

  return data;
}

/* =================================================================
   Retained Helpers (Properties, Progress, Validation)
   ================================================================= */

// ... [Keep your existing loadProperties, initPropertyCombobox, updateProgress, validateForm, etc.]
// NOTE: You can safely delete initPhotoUpload, handleFiles, compressImage, readAsDataURL, renderThumbs, and buildPhotoBuckets.

function showLoading() {
  const overlay = document.getElementById('loadingOverlay');
  overlay.hidden = false;
}

function hideLoading() {
  document.getElementById('loadingOverlay').hidden = true;
}

function showSuccess(data) {
  document.getElementById('successId').textContent = data.inspectionId || '—';
  document.getElementById('successProperty').textContent = data.property || '—';
  const openBtn = document.getElementById('openPdfBtn');
  if (data.pdfUrl) { openBtn.href = data.pdfUrl; openBtn.hidden = false; }
  document.getElementById('successOverlay').hidden = false;
}

function showError(message) {
  document.getElementById('errorToastMsg').textContent = message;
  document.getElementById('errorToast').hidden = false;
}

function deliverPdf(pdfUrl) {
  if (pdfUrl) window.open(pdfUrl, '_blank');
}

// Ensure you keep your existing init functions (initDateFields, initSuccessButtons, initErrorToast, etc.)
