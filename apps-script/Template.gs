/**
 * Template.gs
 * ===========
 * Handles copying the master Google Docs template and replacing all text
 * placeholders. Photos are linked via {{PHOTO_LINK}} (see Reports.gs /
 * Config.gs PLACEHOLDER_MAP) rather than embedded in the document, so the
 * PDF generates in constant time no matter how many photos an inspection
 * has.
 */

// ─── Document Copy ────────────────────────────────────────────────────────────

function copyTemplate(property, date, reportsFolder) {
  const templateFile = DriveApp.getFileById(TEMPLATE_DOC_ID);

  const safeProp = sanitizeName(property || 'Unknown Property');
  const docName = `${REPORT_NAME_PREFIX} - ${safeProp} - ${date}`;

  const copy = templateFile.makeCopy(docName, reportsFolder);
  console.log(`Template copied → "${docName}" (${copy.getId()})`);
  return copy;
}

// ─── Text Placeholder Replacement ────────────────────────────────────────────

function replacePlaceholders(doc, replacementMap) {
  const body = doc.getBody();

  for (const [placeholder, value] of Object.entries(replacementMap)) {
    const escaped = placeholder.replace(/[{}]/g, '\\$&');
    body.replaceText(escaped, value);
  }

  _replaceInSections(doc, replacementMap);

  console.log(`Replaced ${Object.keys(replacementMap).length} placeholders.`);
}

function _replaceInSections(doc, replacementMap) {
  try {
    const header = doc.getHeader();
    const footer = doc.getFooter();

    [header, footer].forEach(section => {
      if (!section) return;

      for (const [placeholder, value] of Object.entries(replacementMap)) {
        const escaped = placeholder.replace(/[{}]/g, '\\$&');
        section.replaceText(escaped, value);
      }
    });

  } catch (e) {
    console.warn('_replaceInSections:', e.message);
  }
}
