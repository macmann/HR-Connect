const path = require('path');
const fs = require('fs');
const { init, getDatabase } = require('./db');
const { getUploadsRoot, getBrandingUploadDir } = require('./utils/uploadPaths');

const DEFAULT_BRANDING = {
  name: 'HR Connect',
  tagline: 'Modern, people-first HR experiences',
  logoPath: ''
};

const BRANDING_CACHE_MS = 60 * 1000;
let brandingCache = { value: null, loadedAt: 0 };

function sanitizeLogoPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/uploads/')) return trimmed;
  if (trimmed.startsWith('uploads/')) return '/' + trimmed;
  return '';
}

function normalizeBrandingSettings(raw = {}) {
  const source = raw && typeof raw.value === 'object' ? raw.value : raw;
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim()
    : DEFAULT_BRANDING.name;
  const tagline = typeof source.tagline === 'string' && source.tagline.trim()
    ? source.tagline.trim()
    : DEFAULT_BRANDING.tagline;
  const logoPath = sanitizeLogoPath(source.logoPath);
  return { name, tagline, logoPath };
}

async function loadBrandingSettings({ force = false } = {}) {
  const now = Date.now();
  if (!force && brandingCache.value && now - brandingCache.loadedAt < BRANDING_CACHE_MS) {
    return brandingCache.value;
  }

  await init();
  const database = getDatabase();
  const doc = await database.collection('settings').findOne({ _id: 'branding' });
  const normalized = normalizeBrandingSettings(doc || {});
  brandingCache = { value: normalized, loadedAt: now };
  return normalized;
}

async function saveBrandingSettings(settings = {}) {
  await init();
  const database = getDatabase();
  const normalized = normalizeBrandingSettings(settings);

  await database.collection('settings').updateOne(
    { _id: 'branding' },
    { $set: { value: normalized } },
    { upsert: true }
  );

  brandingCache = { value: normalized, loadedAt: Date.now() };
  return normalized;
}

function removeLogoFile(logoPath) {
  const sanitized = sanitizeLogoPath(logoPath);
  if (!sanitized) return;
  const uploadsRoot = getUploadsRoot();
  const absolutePath = path.join(uploadsRoot, sanitized.replace(/^\/uploads\//, ''));
  if (absolutePath.startsWith(getBrandingUploadDir()) && fs.existsSync(absolutePath)) {
    fs.unlink(absolutePath, () => {});
  }
}

module.exports = {
  DEFAULT_BRANDING,
  loadBrandingSettings,
  saveBrandingSettings,
  removeLogoFile,
  normalizeBrandingSettings
};
