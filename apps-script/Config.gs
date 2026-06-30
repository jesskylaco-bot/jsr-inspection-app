/**
 * Config.gs
 * =========
 * Central configuration for the JSR Property Inspection System.
 */

// ────────────────────────────────────────────────────────────────
// GOOGLE DRIVE
// ────────────────────────────────────────────────────────────────

/** Root folder: JSR Inspections */
const ROOT_FOLDER_ID = '1OYYPs8ePJIgVHUI38NdKzM71P2eyakbU';

/** Folder containing all property folders */
const PROPERTIES_FOLDER_ID = '1yXXK8_rirl4DB2dN03chb4EPz55fHo3M';

/** Google Docs inspection template */
const TEMPLATE_DOC_ID = '1gKTGKcUcEkykiEbbuw88gI59SlrjSnA1emI-mF2zTDc';

/** Inspection log sheet */
const LOG_SHEET_ID = '1x9dKrUadd4LGQghwADgpS7jJ8IYIbooXSYBUufAwsaI';

// ────────────────────────────────────────────────────────────────
// REPORT SETTINGS
// ────────────────────────────────────────────────────────────────

const REPORT_NAME_PREFIX = 'Inspection';

const DATE_FORMAT = 'yyyy-MM-dd';

const TIMEZONE = 'America/Detroit';

// ────────────────────────────────────────────────────────────────
// PHOTO SETTINGS
// ────────────────────────────────────────────────────────────────

const MAX_IMAGE_WIDTH_PT = 360;
const MAX_IMAGE_HEIGHT_PT = 270;

/**
 * Folder created inside every property folder, holding one subfolder
 * per category. Populated by moving files out of TEMP_UPLOADS_FOLDER_NAME
 * on submit — never written to directly during upload.
 *
 * Example
 *
 * Properties
 *    └── 123 Main St
 *          └── Inspection Photos
 *                ├── Exterior
 *                ├── Kitchen
 *                ├── Bathroom
 *                ├── Utility
 *                ├── Roof
 *                └── General
 */
const INSPECTION_PHOTOS_FOLDER_NAME = 'Inspection Photos';

/**
 * Single shared scratch folder (directly under ROOT_FOLDER_ID) that every
 * photo lands in immediately on upload, before its inspection/category is
 * known to be final. Drained into the property's Inspection Photos folder
 * on submit.
 */
const TEMP_UPLOADS_FOLDER_NAME = '_TempUploads';

// ────────────────────────────────────────────────────────────────
// TEMPLATE PLACEHOLDERS
// ────────────────────────────────────────────────────────────────

const PLACEHOLDER_MAP = {

  // Header
  INSPECTION_ID: 'inspectionId',
  GENERATED_DATE: 'generatedDate',

  // Property
  PROPERTY: 'property',
  INSPECTION_DATE: 'inspectionDate',
  INSPECTOR_NAME: 'inspectorName',
  INSPECTOR_PHONE: 'inspectorPhone',
  INSPECTOR_EMAIL: 'inspectorEmail',

  // Property Condition
  OCCUPANCY_STATUS: 'occupancyStatus',
  PROPERTY_SECURE: 'propertySecure',
  VIOLATION_NOTICE: 'violationNotice',

  // Doors & Windows
  FRONT_DOOR: 'frontDoor',
  REAR_DOOR: 'rearDoor',
  SIDE_DOOR: 'sideDoor',
  BROKEN_WINDOWS: 'brokenWindows',

  // Utilities
  ELECTRIC: 'electric',
  GAS: 'gas',
  WATER: 'water',

  // Roof
  ROOF_CONDITION: 'roofCondition',
  SHINGLE_TYPE: 'shingleType',
  ROOF_DAMAGE: 'roofDamage',
  GUTTERS_PRESENT: 'guttersPresent',
  GUTTER_DAMAGE: 'gutterDamage',

  // Damage
  FIRE_DAMAGE: 'fireDamage',
  WATER_DAMAGE: 'waterDamage',
  FREEZE_DAMAGE: 'freezeDamage',
  VANDALISM: 'vandalism',
  DAMAGE_DESCRIPTION: 'damageDescription',

  // Plumbing
  PLUMBING_DAMAGE: 'plumbingDamage',
  LEAKS: 'leaks',
  ELECTRICAL_DAMAGE: 'electricalDamage',
  ELECTRICIAN_NEEDED: 'electricianNeeded',
  SYSTEM_NOTES: 'systemNotes',

  // Mechanical
  FURNACE_CONDITION: 'furnaceCondition',
  FURNACE_AGE: 'furnaceAge',
  WATER_TANK_CONDITION: 'waterTankCondition',
  WATER_TANK_AGE: 'waterTankAge',
  APPLIANCES: 'appliances',

  // Kitchen
  KITCHEN_CONDITION: 'kitchenCondition',
  CABINETS: 'cabinets',
  COUNTERTOPS: 'countertops',
  KITCHEN_FLOORING: 'kitchenFlooring',
  KITCHEN_NOTES: 'kitchenNotes',

  // Bathroom
  BATHROOM_CONDITION: 'bathroomCondition',
  FIXTURES: 'fixtures',
  TILE_GROUT: 'tileGrout',
  VENTILATION: 'ventilation',
  BATHROOM_NOTES: 'bathroomNotes',

  // Additional
  ESTIMATED_VALUE: 'estimatedValue',
  ESTIMATED_RENT: 'estimatedRent',
  GENERAL_NOTES: 'generalNotes',

  // Photos
  GENERAL_PHOTOS_LINK: 'generalPhotosLink',

  // Footer
  SIGNATURE_DATE: 'inspectionDate'
};
