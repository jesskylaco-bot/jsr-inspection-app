/**
 * Reports.gs
 * ============================================================================
 * Handles folder linking, report generation, and PDF export. Photos are
 * already sitting in their category folders by the time this runs
 * (PhotoUpload.gs's movePhotosForSubmission, called from doPost before
 * generateInspectionReport) — this file only ever links to that folder via
 * {{PHOTO_LINK}}, it never embeds or processes image bytes.
 */

function generateInspectionReport(data) {
  // 1. Data validation
  if (!data || !data.property) {
    throw new Error("Missing data: 'property' is required.");
  }

  // 2. Folder Setup
  const reportsFolder = getReportsFolder(data.property);

  // 3. Create Document
  const docFile = copyTemplate(data.property, data.inspectionDate, reportsFolder);

  // 4. Open Document - Ensure doc is defined here
  const doc = DocumentApp.openById(docFile.getId());

  if (!doc) {
    throw new Error("Failed to open document after creation.");
  }

  // 5. Build Map
  // (buildReplacementMap already resolves {{GENERAL_PHOTOS_LINK}} from
  // data.generalPhotosLink, set by movePhotosForSubmission in doPost.)
  const replacementMap = buildReplacementMap(data);
  replacementMap['{{PHOTO_LINK}}'] = data.photoFolderUrl || "https://drive.google.com/drive/folders/1yXXK8_rirl4DB2dN03chb4EPz55fHo3M?usp=sharing";

  // 6. Replace Placeholders
  replacePlaceholders(doc, replacementMap);
  doc.saveAndClose();

  // 7. Generate PDF
  const { pdfUrl } = generatePdf(docFile, reportsFolder);

  // 8. Cleanup
  docFile.setTrashed(true);

  return {
    success: true,
    pdfUrl: pdfUrl,
    inspectionId: data.inspectionId,
    property: data.property
  };
}

// ============================================================================
// Helpers
// ============================================================================

function getReportsFolder(property) {
  const propertiesFolder = DriveApp.getFolderById(PROPERTIES_FOLDER_ID);
  const safeName = sanitizeName(property || "Unknown Property");
  const propertyFolder = getOrCreateFolder(propertiesFolder, safeName);
  const reportsFolder = getOrCreateFolder(propertyFolder, "Reports");
  return reportsFolder;
}

function generatePdf(docFile, reportsFolder) {
  const exportUrl = `https://docs.google.com/document/d/${docFile.getId()}/export?format=pdf`;
  const response = UrlFetchApp.fetch(exportUrl, {
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }
  });

  const pdfBlob = response.getBlob().setName(docFile.getName() + ".pdf");
  const pdfFile = reportsFolder.createFile(pdfBlob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return { pdfFile, pdfUrl: pdfFile.getUrl() };
}
