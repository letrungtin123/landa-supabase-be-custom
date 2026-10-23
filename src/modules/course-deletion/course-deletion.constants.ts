// Batch sizes shared by the course deletion job and its storage manifest
// discovery. Moved unchanged from course-deletion.service.ts.

export const DELETE_BATCH_SIZE = 500;
export const ASSET_BATCH_SIZE = 100;

/** Start of a keyset scan over UUID ids. */
export const FIRST_UUID = '00000000-0000-0000-0000-000000000000';
