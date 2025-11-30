const fs = require('fs');
const path = require('path');

/**
 * Returns the root directory for uploads, creating it if necessary.
 * Prefer an explicit env var so deployments can point to a persistent volume
 * instead of the ephemeral repo directory.
 */
function getUploadsRoot() {
  const root =
    process.env.UPLOADS_ROOT ||
    process.env.UPLOADS_DIR ||
    path.join(__dirname, '..', 'uploads');

  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Returns the directory for CV uploads (inside the uploads root), creating it
 * if necessary.
 */
function getCvUploadDir() {
  const cvDir = path.join(getUploadsRoot(), 'cv');
  fs.mkdirSync(cvDir, { recursive: true });
  return cvDir;
}

module.exports = { getUploadsRoot, getCvUploadDir };
