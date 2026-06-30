/**
 * Jobs.gs
 * =======
 * Submit is processed asynchronously: doPost writes a job file and returns
 * immediately, a time-based trigger does the actual photo move + PDF
 * generation, and the frontend polls ?action=checkStatus&inspectionId=...
 * for the result. This keeps the synchronous HTTP request (and the
 * Netlify proxy in front of it) fast regardless of how many photos an
 * inspection has — moving 50–200 Drive files one at a time can easily run
 * past a 60s request timeout.
 */

function getJobsFolder_() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  return getOrCreateFolder(root, JOBS_FOLDER_NAME);
}

function jobFileName_(inspectionId) {
  return `job-${inspectionId}.json`;
}

/**
 * Writes a new pending job file containing the full submission payload.
 *
 * @param {string} inspectionId
 * @param {Object} data  Full submission data (already has inspectionId,
 *                        photoFolderUrl set by the caller)
 */
function writeJob_(inspectionId, data) {
  const folder = getJobsFolder_();
  const name = jobFileName_(inspectionId);
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) existing.next().setTrashed(true);

  const job = { status: 'pending', inspectionId, data, createdAt: new Date().toISOString() };
  folder.createFile(name, JSON.stringify(job), MimeType.PLAIN_TEXT);
}

/**
 * Reads a job file's current state.
 *
 * @param {string} inspectionId
 * @returns {Object|null}  Parsed job object, or null if not found
 */
function readJob_(inspectionId) {
  const folder = getJobsFolder_();
  const files = folder.getFilesByName(jobFileName_(inspectionId));
  if (!files.hasNext()) return null;
  return JSON.parse(files.next().getBlob().getDataAsString());
}

function writeJobResult_(inspectionId, patch) {
  const folder = getJobsFolder_();
  const name = jobFileName_(inspectionId);
  const files = folder.getFilesByName(name);
  if (!files.hasNext()) return;

  const file = files.next();
  const job = Object.assign(JSON.parse(file.getBlob().getDataAsString()), patch, {
    updatedAt: new Date().toISOString(),
  });
  file.setContent(JSON.stringify(job));
}

/**
 * Schedules processPendingJobs() to run almost immediately. Safe to call
 * once per submit — each firing processes every pending job, not just the
 * one that scheduled it, so duplicate triggers just do redundant (cheap,
 * idempotent) work and self-delete.
 */
function scheduleJobProcessing_() {
  ScriptApp.newTrigger('processPendingJobs').timeBased().after(1000).create();
}

/**
 * Trigger entry point. Processes every pending job: moves its photos into
 * place and generates the PDF report, then writes the result back to the
 * job file. Deletes itself when done.
 */
function processPendingJobs() {
  try {
    const folder = getJobsFolder_();
    const files = folder.getFiles();

    while (files.hasNext()) {
      const file = files.next();
      let job;
      try {
        job = JSON.parse(file.getBlob().getDataAsString());
      } catch (e) {
        continue; // corrupt/unrelated file — skip
      }
      if (job.status !== 'pending') continue;

      processJob_(job.inspectionId, job.data);
    }
  } finally {
    _deleteTriggersFor_('processPendingJobs');
  }
}

function processJob_(inspectionId, data) {
  try {
    const photoResult = movePhotosForSubmission(data.property, data.photos || {});
    if (photoResult.moveErrors && photoResult.moveErrors.length) {
      writeJobResult_(inspectionId, {
        status: 'error',
        error: 'Some photos could not be filed into their category folders. Press Submit again to retry.',
        photoFolderUrl: photoResult.folderUrl,
        moveErrors: photoResult.moveErrors,
      });
      return;
    }
    data.photoFolderUrl = photoResult.folderUrl;

    const result = generateInspectionReport(data);

    logToSheet({
      inspectionId,
      property: data.property,
      inspectorName: data.inspectorName,
      date: data.inspectionDate,
      pdfUrl: result.pdfUrl,
      status: 'Complete',
    });

    writeJobResult_(inspectionId, {
      status: 'complete',
      result: Object.assign({}, result, {
        inspectionId,
        inspectionDate: data.inspectionDate,
        photoFolderUrl: photoResult.folderUrl,
      }),
    });
  } catch (err) {
    console.error('processJob_ error:', err);
    writeJobResult_(inspectionId, { status: 'error', error: String(err.message || err) });
  }
}

function _deleteTriggersFor_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/**
 * GET ?action=checkStatus&inspectionId=... handler. Returns the job's
 * current state so the frontend can poll until it's done.
 *
 * @param {string} inspectionId
 * @returns {Object}
 */
function checkJobStatus(inspectionId) {
  if (!inspectionId) return errorResponse('Missing inspectionId.');

  const job = readJob_(inspectionId);
  if (!job) return errorResponse('No submission found for that inspection ID.');

  if (job.status === 'complete') {
    return Object.assign({ success: true, status: 'complete' }, job.result);
  }
  if (job.status === 'error') {
    return {
      success: false,
      status: 'error',
      error: job.error,
      inspectionId,
      photoFolderUrl: job.photoFolderUrl,
      moveErrors: job.moveErrors,
    };
  }
  return { success: true, status: 'pending', inspectionId };
}
