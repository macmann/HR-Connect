// server.js

const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const nodemailer = require('nodemailer');
const https = require('https');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { db, init, getDatabase } = require('./db');
const {
  DEFAULT_LEAVE_BALANCES,
  SUPPORTED_LEAVE_TYPES,
  cloneDefaultLeaveBalances,
  roundToOneDecimal,
  recalculateLeaveBalancesForCycle,
  getCurrentCycleRange,
  buildEmployeeLeaveState
} = require('./services/leaveAccrualService');
const { parse } = require('csv-parse/sync');
const {
  ensureIndexes: ensurePairingIndexes,
  createPairingRequest,
  leasePendingRequest,
  claimRequest: claimPairingRequest,
  getRequestById: getPairRequestById
} = require('./pairingStore');
const {
  DEFAULT_AI_SETTINGS,
  getAiModelOptions,
  loadAiSettings,
  saveAiSettings
} = require('./aiSettings');
const recruitmentOpenApiSpec = require('./api/recruitmentopenAI');
const hrPositionsRoutes = require('./api/hrPositions');
const hrAiInterviewRoutes = require('./api/hrAiInterview');
const hrApplicationsRoutes = require('./api/hrApplications');
const publicCareersRoutes = require('./api/publicCareers');
const publicAiInterviewRoutes = require('./api/publicAiInterview');
const { getUploadsRoot } = require('./utils/uploadPaths');
const {
  computeAllLeaveBalances,
  getCurrentLeaveCycle: getCurrentLeaveCycleInfo,
  DEFAULT_ENTITLEMENTS
} = require('./utils/leaveAccrual');

if (process.env.NODE_ENV !== 'production' || !global.__monthlyLeaveCronInitialized) {
  require('./cron/monthlyLeaveCron');
  if (process.env.NODE_ENV === 'production') {
    global.__monthlyLeaveCronInitialized = true;
  }
}

if (process.env.NODE_ENV !== 'production' || !global.__resetLeaveCycleCronInitialized) {
  require('./cron/resetLeaveCycle');
  if (process.env.NODE_ENV === 'production') {
    global.__resetLeaveCycleCronInitialized = true;
  }
}

const app = express();

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'session_token';
const SESSION_COOKIE_MAX_AGE = Number(
  process.env.SESSION_COOKIE_MAX_AGE || 7 * 24 * 60 * 60 * 1000
);
const SESSION_COOKIE_SAMESITE = (process.env.SESSION_COOKIE_SAMESITE || 'lax').toLowerCase();
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin, origins) {
  if (!origins.length || origins.includes('*')) {
    return true;
  }

  return origins.some(allowed => {
    if (!allowed) return false;

    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(1);
      return origin.endsWith(domain);
    }

    return allowed === origin;
  });
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin || isOriginAllowed(origin, allowedOrigins)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length']
};

app.use(cors(corsOptions));
app.options(
  /.*/,
  cors(corsOptions),
  (req, res) => res.sendStatus(204)
);

// Default leave balance values assigned to new employees are provided by the leaveAccrualService.

// Payload limit for incoming requests (default 3 MB to accommodate CV uploads)
const BODY_LIMIT = process.env.BODY_LIMIT || '3mb';

// Default admin credentials (can be overridden with env vars)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@brillar.io';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const MANAGER_ROLES = new Set(['manager', 'superadmin']);
const INACTIVE_EMPLOYEE_STATUSES = new Set([
  'inactive',
  'deactivated',
  'disabled',
  'terminated'
]);

function normalizeRole(role) {
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function isManagerRole(role) {
  return MANAGER_ROLES.has(normalizeRole(role));
}

function isSuperAdminRole(role) {
  return normalizeRole(role) === 'superadmin';
}

function isActiveEmployeeStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!normalized) return true;
  return !INACTIVE_EMPLOYEE_STATUSES.has(normalized);
}

function isEmployeeActive(employee) {
  if (!employee) return false;
  return isActiveEmployeeStatus(employee.status);
}

// ---- PAIRING CONFIG ----
const PAIR_REQUEST_TTL_MIN_SECONDS = Math.max(
  60,
  Number(process.env.PAIR_REQUEST_TTL_MIN_SECONDS || 60)
);
const PAIR_REQUEST_TTL_MAX_SECONDS = Math.max(
  PAIR_REQUEST_TTL_MIN_SECONDS,
  Number(process.env.PAIR_REQUEST_TTL_MAX_SECONDS || 120)
);
const PAIR_POLL_LEASE_SECONDS = Math.max(
  5,
  Number(process.env.PAIR_POLL_LEASE_SECONDS || 20)
);
const PAIR_AGENT_ID = process.env.PAIR_AGENT_ID || 'default-agent';
const PAIR_AGENT_SECRET = process.env.PAIR_AGENT_SECRET || '';
const PAIR_AGENT_SIGNATURE_TOLERANCE_MS = Number(
  process.env.PAIR_AGENT_SIGNATURE_TOLERANCE_MS || 2 * 60 * 1000
);
const PAIR_AGENT_REPLAY_WINDOW_MS = Number(
  process.env.PAIR_AGENT_REPLAY_WINDOW_MS || 5 * 60 * 1000
);
const PAIR_TOKEN_SCOPE = process.env.PAIR_TOKEN_SCOPE || 'pair:connect';
const PAIR_TOKEN_ISSUER = process.env.PAIR_TOKEN_ISSUER || 'brillar-hr-portal';
const PAIR_TOKEN_AUDIENCE = process.env.PAIR_TOKEN_AUDIENCE || 'agent-clients';
const PAIR_TOKEN_SECRET = process.env.PAIR_TOKEN_SECRET || '';
const PAIR_TOKEN_TTL_SECONDS = Math.max(
  60,
  Number(process.env.PAIR_TOKEN_TTL_SECONDS || 5 * 60)
);
const PAIR_TOKEN_ALGORITHM = process.env.PAIR_TOKEN_ALGORITHM || 'HS256';
const PAIR_INIT_RATE_LIMIT = Number(process.env.PAIR_INIT_RATE_LIMIT || 10);
const PAIR_INIT_RATE_WINDOW_MS = Number(
  process.env.PAIR_INIT_RATE_WINDOW_MS || 60 * 1000
);
const PAIR_POLL_RATE_LIMIT = Number(process.env.PAIR_POLL_RATE_LIMIT || 30);
const PAIR_POLL_RATE_WINDOW_MS = Number(
  process.env.PAIR_POLL_RATE_WINDOW_MS || 60 * 1000
);
const PAIR_CLAIM_RATE_LIMIT = Number(process.env.PAIR_CLAIM_RATE_LIMIT || 60);
const PAIR_CLAIM_RATE_WINDOW_MS = Number(
  process.env.PAIR_CLAIM_RATE_WINDOW_MS || 60 * 1000
);

// ---- MICROSOFT SSO CONFIG ----
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
const MS_TENANT = process.env.MS_TENANT || 'common';
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI ||
  'http://localhost:3000/auth/microsoft/callback';
// ---- EMAIL SETUP ----
const EMAIL_SETTINGS_CACHE_MS = 60 * 1000;
const DEFAULT_OAUTH_SCOPE = 'https://outlook.office365.com/.default';
const DEFAULT_LEAVE_EMAIL_TEMPLATES = {
  requestSubject: 'Leave request from {name}',
  requestBody: '{name} applied for {type} leave from {from} to {to}.',
  approveSubject: 'Leave approved',
  approveBody: '{name}, your leave from {from} to {to} has been approved.',
  rejectSubject: 'Leave rejected',
  rejectBody: '{name}, your leave from {from} to {to} has been rejected.',
  cancelSubject: 'Leave cancelled',
  cancelBody: '{name}, your leave from {from} to {to} has been cancelled.'
};

function getEnvEmailSettings() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || user;
  const replyTo = process.env.SMTP_REPLY_TO || '';
  const recipientsEnv = process.env.SMTP_RECIPIENTS || '';
  const authType = (process.env.SMTP_AUTH_TYPE || 'basic').trim().toLowerCase();
  const oauthTenant = process.env.SMTP_OAUTH_TENANT || '';
  const oauthClientId = process.env.SMTP_OAUTH_CLIENT_ID || '';
  const oauthClientSecret = process.env.SMTP_OAUTH_CLIENT_SECRET || '';
  const oauthScope = process.env.SMTP_OAUTH_SCOPE || '';
  const oauthRefreshToken = process.env.SMTP_OAUTH_REFRESH_TOKEN || '';
  const oauthGrantType = (process.env.SMTP_OAUTH_GRANT_TYPE || '').trim().toLowerCase();
  const recipients = recipientsEnv
    ? recipientsEnv
        .split(/[,;]+/)
        .map(value => value && value.trim())
        .filter(Boolean)
    : [];
  return {
    enabled: Boolean(host),
    provider: host === 'smtp.office365.com' ? 'office365' : 'custom',
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure,
    user,
    pass,
    from,
    replyTo,
    recipients,
    authType,
    oauthTenant,
    oauthClientId,
    oauthClientSecret,
    oauthScope,
    oauthRefreshToken,
    oauthGrantType
  };
}

function normalizeEmailSettings(raw) {
  const defaults = {
    enabled: false,
    provider: 'custom',
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '',
    replyTo: '',
    recipients: [],
    authType: 'basic',
    oauthTenant: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScope: DEFAULT_OAUTH_SCOPE,
    oauthRefreshToken: '',
    oauthGrantType: 'client_credentials',
    templates: { ...DEFAULT_LEAVE_EMAIL_TEMPLATES }
  };
  const envSettings = getEnvEmailSettings();
  const result = { ...defaults, ...envSettings };
  if (raw && typeof raw === 'object') {
    Object.entries(raw).forEach(([key, value]) => {
      if (value === undefined) return;
      result[key] = value;
    });
  }
  result.enabled = Boolean(result.enabled && result.host);
  result.host = typeof result.host === 'string' ? result.host.trim() : '';
  const numericPort = Number(result.port);
  result.port = Number.isFinite(numericPort) && numericPort > 0 ? numericPort : 587;
  result.secure = result.secure === true || result.secure === 'true';
  result.user = typeof result.user === 'string' ? result.user.trim() : '';
  result.from = typeof result.from === 'string' && result.from.trim()
    ? result.from.trim()
    : result.user || '';
  result.replyTo = typeof result.replyTo === 'string' ? result.replyTo.trim() : '';
  const authType = typeof result.authType === 'string' ? result.authType.trim().toLowerCase() : 'basic';
  result.authType = authType === 'oauth2' ? 'oauth2' : 'basic';
  result.oauthTenant = typeof result.oauthTenant === 'string' ? result.oauthTenant.trim() : '';
  result.oauthClientId = typeof result.oauthClientId === 'string' ? result.oauthClientId.trim() : '';
  result.oauthClientSecret = typeof result.oauthClientSecret === 'string'
    ? result.oauthClientSecret
    : '';
  result.oauthScope = typeof result.oauthScope === 'string' && result.oauthScope.trim()
    ? result.oauthScope.trim()
    : DEFAULT_OAUTH_SCOPE;
  result.oauthRefreshToken = typeof result.oauthRefreshToken === 'string'
    ? result.oauthRefreshToken
    : '';
  const grantType = typeof result.oauthGrantType === 'string'
    ? result.oauthGrantType.trim().toLowerCase()
    : 'client_credentials';
  if (grantType === 'refresh_token') {
    result.oauthGrantType = 'refresh_token';
  } else {
    result.oauthGrantType = 'client_credentials';
  }
  const recipientValues = Array.isArray(result.recipients)
    ? result.recipients
    : typeof result.recipients === 'string'
      ? result.recipients.split(/[,;]+/)
      : [];
  const recipientMap = new Map();
  recipientValues.forEach(value => {
    if (value === undefined || value === null) return;
    const trimmed = typeof value === 'string' ? value.trim() : String(value || '').trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (!recipientMap.has(lower)) {
      recipientMap.set(lower, trimmed);
    }
  });
  result.recipients = Array.from(recipientMap.values());
  if (!result.host) {
    result.enabled = false;
  }
  if (result.host === 'smtp.office365.com') {
    result.provider = 'office365';
  } else if (!result.provider) {
    result.provider = 'custom';
  }
  result.templates = normalizeEmailTemplates(raw?.templates || result.templates);
  return result;
}

function normalizeEmailTemplates(raw) {
  const templates = { ...DEFAULT_LEAVE_EMAIL_TEMPLATES };
  if (raw && typeof raw === 'object') {
    Object.entries(templates).forEach(([key]) => {
      const value = raw[key];
      if (typeof value === 'string' && value.trim()) {
        templates[key] = value.trim();
      }
    });
  }
  return templates;
}

let emailSettingsCache = { config: null, loadedAt: 0 };
let emailTransporterCache = { transporter: null, signature: null };
const emailOAuthTokenCache = new Map();

async function loadEmailSettings({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    emailSettingsCache.config &&
    now - emailSettingsCache.loadedAt < EMAIL_SETTINGS_CACHE_MS
  ) {
    return emailSettingsCache.config;
  }

  await init();
  const database = getDatabase();
  const doc = await database.collection('settings').findOne({ _id: 'email' });
  const stored = doc && doc.value && typeof doc.value === 'object' ? doc.value : null;
  const config = normalizeEmailSettings(stored);
  emailSettingsCache = { config, loadedAt: now };
  if (force) {
    emailOAuthTokenCache.clear();
  }
  return config;
}

function transporterSignature(config) {
  if (!config) return '';
  return [
    config.host,
    config.port,
    config.secure,
    config.user,
    config.authType,
    Boolean(config.pass),
    Boolean(config.oauthClientSecret),
    Boolean(config.oauthRefreshToken),
    config.oauthTenant,
    config.oauthClientId,
    config.oauthScope,
    config.oauthGrantType
  ].join('|');
}

async function getMailTransporter({
  config: providedConfig,
  forceReload = false,
  oauthAccessToken = null
} = {}) {
  const config = providedConfig || (await loadEmailSettings({ force: forceReload }));
  if (!config.enabled || !config.host) {
    return null;
  }
  const useCache = config.authType !== 'oauth2';
  const signature = transporterSignature(config);
  if (
    useCache &&
    !forceReload &&
    emailTransporterCache.signature === signature &&
    emailTransporterCache.transporter
  ) {
    return emailTransporterCache.transporter;
  }
  const transporterOptions = {
    host: config.host,
    port: config.port,
    secure: Boolean(config.secure)
  };
  if (config.provider === 'office365') {
    transporterOptions.requireTLS = true;
    transporterOptions.tls = { ciphers: 'TLSv1.2' };
  }
  if (config.authType === 'oauth2') {
    transporterOptions.authMethod = 'XOAUTH2';
    if (oauthAccessToken && oauthAccessToken.accessToken) {
      transporterOptions.auth = {
        type: 'OAuth2',
        user: config.user || config.from,
        accessToken: oauthAccessToken.accessToken
      };
      if (oauthAccessToken.expiresAt) {
        transporterOptions.auth.expires = new Date(oauthAccessToken.expiresAt);
      }
    }
  } else if (config.user) {
    transporterOptions.auth = {
      user: config.user,
      pass: config.pass
    };
  }
  const transporter = nodemailer.createTransport(transporterOptions);
  if (useCache) {
    emailTransporterCache = { transporter, signature };
  }
  return transporter;
}

async function getOAuthAccessToken(config) {
  if (!config) return null;
  const cacheKey = [
    config.host,
    config.user,
    config.oauthTenant,
    config.oauthClientId,
    config.oauthScope,
    config.oauthGrantType
  ].join('|');
  const cached = emailOAuthTokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt - now > 60 * 1000) {
    return cached.token;
  }
  const tenant = config.oauthTenant || 'common';
  const clientId = config.oauthClientId;
  const clientSecret = config.oauthClientSecret;
  if (!tenant || !clientId || !clientSecret) {
    throw new Error('OAuth credentials are incomplete. Provide tenant ID, client ID, and client secret.');
  }
  const scope = config.oauthScope || DEFAULT_OAUTH_SCOPE;
  const grantType = config.oauthGrantType === 'refresh_token' && config.oauthRefreshToken
    ? 'refresh_token'
    : 'client_credentials';
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', scope);
  if (grantType === 'refresh_token') {
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', config.oauthRefreshToken);
  } else {
    params.append('grant_type', 'client_credentials');
  }
  const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = params.toString();
  const requestResult = await new Promise((resolve, reject) => {
    const url = new URL(tokenEndpoint);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search || ''}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let responseBody = '';
      res.on('data', chunk => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          statusMessage: res.statusMessage || '',
          body: responseBody
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (requestResult.statusCode < 200 || requestResult.statusCode >= 300) {
    throw new Error(
      `OAuth token request failed (${requestResult.statusCode} ${requestResult.statusMessage}): ${requestResult.body}`
    );
  }
  let data;
  try {
    data = JSON.parse(requestResult.body);
  } catch (err) {
    throw new Error(`OAuth token response was not valid JSON: ${err.message}`);
  }
  const accessToken = data?.access_token;
  if (!accessToken) {
    throw new Error('OAuth token response did not include an access token.');
  }
  const expiresIn = Number(data.expires_in) || 3600;
  const expiresAt = now + Math.max(expiresIn - 60, 60) * 1000;
  const tokenData = { accessToken, expiresAt };
  emailOAuthTokenCache.set(cacheKey, { token: tokenData, expiresAt });
  return tokenData;
}

async function sendEmail(to, subject, text) {
  const recipientValues = Array.isArray(to)
    ? to
    : typeof to === 'string'
      ? to.split(/[,;]+/)
      : to
        ? [to]
        : [];
  const recipientMap = new Map();
  recipientValues.forEach(value => {
    if (value === undefined || value === null) return;
    const trimmed = typeof value === 'string' ? value.trim() : String(value || '').trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (!recipientMap.has(lower)) {
      recipientMap.set(lower, trimmed);
    }
  });
  if (!recipientMap.size) return;
  try {
    const config = await loadEmailSettings();
    if (!config.enabled || !config.host) return;
    let oauthTokenData = null;
    if (config.authType === 'oauth2') {
      oauthTokenData = await getOAuthAccessToken(config);
      if (!oauthTokenData || !oauthTokenData.accessToken) {
        throw new Error('Unable to acquire OAuth access token for SMTP.');
      }
    }
    const transporter = await getMailTransporter({
      config,
      oauthAccessToken: oauthTokenData
    });
    if (!transporter) return;
    const message = {
      from: config.from || config.user,
      to: Array.from(recipientMap.values()).join(', '),
      subject,
      text
    };
    if (config.replyTo) {
      message.replyTo = config.replyTo;
    }
    if (config.authType === 'oauth2') {
      message.auth = {
        type: 'OAuth2',
        user: config.user || config.from,
        accessToken: oauthTokenData.accessToken
      };
      if (oauthTokenData.expiresAt) {
        message.auth.expires = new Date(oauthTokenData.expiresAt);
      }
    }
    await transporter.sendMail(message);
  } catch (err) {
    console.error('Failed to send email', err);
  }
}

function renderTemplate(template, variables = {}) {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{\{?\s*(\w+)\s*\}?}/g, (_, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

app.locals.sendEmail = sendEmail;

function findEmployeeKey(emp, matcher) {
  if (!emp || typeof emp !== 'object') return null;
  return Object.keys(emp).find(key => {
    if (typeof key !== 'string') return false;
    const normalized = key.toLowerCase();
    return matcher(normalized);
  }) || null;
}

function normalizeEmployeeEmail(emp) {
  if (!emp || typeof emp !== 'object') return false;
  let updated = false;
  const emailKeys = Object.keys(emp).filter(key => {
    if (typeof key !== 'string') return false;
    const normalized = key.toLowerCase();
    return normalized === 'email' || normalized.replace(/\s+/g, '') === 'email' || normalized.includes('email');
  });
  let canonical = '';
  emailKeys.forEach(key => {
    const raw = emp[key];
    if (raw === undefined || raw === null) return;
    const trimmed = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    if (typeof raw === 'string' && raw !== trimmed) {
      emp[key] = trimmed;
      updated = true;
    } else if (typeof raw !== 'string' && emp[key] !== trimmed) {
      emp[key] = trimmed;
      updated = true;
    }
    if (!canonical && trimmed) {
      canonical = trimmed;
    }
  });
  return updated;
}

function getEmpEmail(emp) {
  if (!emp) return '';
  normalizeEmployeeEmail(emp);
  const key = findEmployeeKey(emp, normalized =>
    normalized === 'email' || normalized.replace(/\s+/g, '') === 'email' || normalized.includes('email')
  );
  if (!key) return '';
  const value = emp[key];
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function getEmpRole(emp) {
  if (!emp) return 'employee';
  const key = findEmployeeKey(emp, normalized => normalized === 'role' || normalized.includes('role'));
  const value = key ? String(emp[key] || '').trim().toLowerCase() : '';
  return value === 'manager' ? 'manager' : 'employee';
}

function buildRecipientOptions(data, extras = []) {
  const options = new Map();
  const employees = Array.isArray(data?.employees) ? data.employees : [];
  const users = Array.isArray(data?.users) ? data.users : [];

  const addOption = (email, name = '', employeeId = null) => {
    if (!email) return;
    const trimmedEmail = typeof email === 'string' ? email.trim() : String(email || '').trim();
    if (!trimmedEmail) return;
    const lower = trimmedEmail.toLowerCase();
    const existing = options.get(lower);
    if (existing) {
      if (!existing.name && name) {
        existing.name = name;
      }
      if (!existing.employeeId && employeeId) {
        existing.employeeId = employeeId;
      }
      return;
    }
    options.set(lower, { email: trimmedEmail, name: name || '', employeeId: employeeId ?? null });
  };

  users
    .filter(user => user && isManagerRole(user.role))
    .forEach(user => {
      const email = user?.email ? String(user.email).trim() : '';
      if (!email) return;
      let name = '';
      if (user.employeeId) {
        const emp = employees.find(e => e && e.id == user.employeeId);
        if (emp && emp.name) {
          name = String(emp.name).trim();
        }
      }
      addOption(email, name, user.employeeId || null);
    });

  employees
    .filter(emp => isManagerRole(getEmpRole(emp)))
    .forEach(emp => {
      const email = getEmpEmail(emp);
      const name = emp?.name ? String(emp.name).trim() : '';
      addOption(email, name, emp?.id ?? null);
    });

  const extraList = Array.isArray(extras) ? extras : [];
  extraList.forEach(extra => {
    if (!extra) return;
    if (typeof extra === 'string') {
      addOption(extra);
      return;
    }
    addOption(extra.email, extra.name, extra.employeeId);
  });

  if (ADMIN_EMAIL) {
    addOption(ADMIN_EMAIL, 'Administrator');
  }

  return Array.from(options.values()).sort((a, b) => {
    const nameA = a.name ? a.name.toLowerCase() : '';
    const nameB = b.name ? b.name.toLowerCase() : '';
    if (nameA && nameB) {
      const nameCompare = nameA.localeCompare(nameB);
      if (nameCompare !== 0) return nameCompare;
    } else if (nameA) {
      return -1;
    } else if (nameB) {
      return 1;
    }
    return a.email.toLowerCase().localeCompare(b.email.toLowerCase());
  });
}

function resolveEmployeeManagers(employee, data = {}) {
  const employees = Array.isArray(data?.employees) ? data.employees : [];
  const users = Array.isArray(data?.users) ? data.users : [];
  const recipients = new Map();

  const addRecipient = (email, name = '', employeeId = null) => {
    if (!email) return;
    const trimmedEmail = typeof email === 'string' ? email.trim() : String(email || '').trim();
    if (!trimmedEmail) return;
    const lower = trimmedEmail.toLowerCase();
    if (recipients.has(lower)) {
      const existing = recipients.get(lower);
      if (!existing.name && name) {
        existing.name = name;
      }
      if (!existing.employeeId && employeeId) {
        existing.employeeId = employeeId;
      }
      return;
    }
    recipients.set(lower, { email: trimmedEmail, name: name || '', employeeId: employeeId ?? null });
  };

  const rawManager = findValueByKeywords(employee, [
    'appraiser',
    'appariser',
    'manager',
    'supervisor',
    'reporting'
  ]);

  const managerCandidates = rawManager
    ? rawManager
        .split(/[\\/,&;]+/)
        .map(value => (value && typeof value === 'string' ? value.trim() : String(value || '').trim()))
        .filter(Boolean)
    : [];

  const addFromEmployeeRecord = emp => {
    if (!emp) return;
    const email = getEmpEmail(emp);
    if (!email) return;
    const userMatch = users.find(user => user && user.employeeId == emp.id) || null;
    const name = emp?.name ? String(emp.name).trim() : '';
    addRecipient(email, name, emp?.id ?? userMatch?.employeeId ?? null);
  };

  managerCandidates.forEach(candidate => {
    if (!candidate) return;
    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate.includes('@')) {
      const userMatch = users.find(user => typeof user?.email === 'string' && user.email.toLowerCase() === lowerCandidate);
      const employeeMatch = employees.find(emp => getEmpEmail(emp).toLowerCase() === lowerCandidate);
      const name = employeeMatch?.name || userMatch?.name || candidate;
      const employeeId = userMatch?.employeeId || employeeMatch?.id || null;
      addRecipient(candidate, name, employeeId);
      return;
    }

    const matchedEmployee = employees.find(emp =>
      typeof emp?.name === 'string' && emp.name.trim().toLowerCase() === lowerCandidate
    );
    if (matchedEmployee) {
      addFromEmployeeRecord(matchedEmployee);
    }
  });

  return Array.from(recipients.values());
}

function normalizeNumberKey(key = '') {
  if (typeof key !== 'string') return '';
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function findEmployeeNumberKey(emp) {
  if (!emp || typeof emp !== 'object') return null;
  return Object.keys(emp).find(key => normalizeNumberKey(key) === 'no') || null;
}

function getNextEmployeeNumber(employees = []) {
  if (!Array.isArray(employees) || !employees.length) return 1;
  let max = 0;
  employees.forEach(emp => {
    const numberKey = findEmployeeNumberKey(emp);
    if (!numberKey) return;
    const raw = emp[numberKey];
    const value = Number(raw);
    if (!Number.isNaN(value)) {
      max = Math.max(max, value);
    }
  });
  return max + 1;
}

function assignEmployeeNumber(employee, employees = []) {
  if (!employee || typeof employee !== 'object') return;
  let preferredKey = null;
  if (Array.isArray(employees)) {
    for (const existing of employees) {
      const key = findEmployeeNumberKey(existing);
      if (key) {
        preferredKey = key;
        break;
      }
    }
  }
  if (!preferredKey) {
    preferredKey = findEmployeeNumberKey(employee) || 'No';
  }
  const nextNumber = getNextEmployeeNumber(employees);
  employee[preferredKey] = nextNumber;
}

function normalizeLeaveBalanceEntry(entry, defaults) {
  const baseDefaults =
    defaults || { balance: 0, yearlyAllocation: 0, monthlyAccrual: 0, accrued: 0, taken: 0 };
  const balanceValue = Number(
    typeof entry === 'object' && entry !== null && 'balance' in entry
      ? entry.balance
      : entry
  );

  const yearlyAllocation = Number(
    typeof entry === 'object' && entry !== null && 'yearlyAllocation' in entry
      ? entry.yearlyAllocation
      : baseDefaults.yearlyAllocation
  );

  const monthlyAccrual = Number(
    typeof entry === 'object' && entry !== null && 'monthlyAccrual' in entry
      ? entry.monthlyAccrual
      : baseDefaults.monthlyAccrual
  );

  const accrued = Number(
    typeof entry === 'object' && entry !== null && 'accrued' in entry
      ? entry.accrued
      : baseDefaults.accrued
  );

  const taken = Number(
    typeof entry === 'object' && entry !== null && 'taken' in entry ? entry.taken : baseDefaults.taken
  );

  const clampToAllocation = value => {
    if (!Number.isFinite(value)) return value;
    return Number.isFinite(yearlyAllocation) ? Math.min(value, yearlyAllocation) : value;
  };

  return {
    balance: roundToOneDecimal(
      clampToAllocation(Number.isFinite(balanceValue) ? balanceValue : baseDefaults.balance)
    ),
    yearlyAllocation: Number.isFinite(yearlyAllocation)
      ? yearlyAllocation
      : baseDefaults.yearlyAllocation,
    monthlyAccrual: Number.isFinite(monthlyAccrual)
      ? monthlyAccrual
      : baseDefaults.monthlyAccrual,
    accrued: roundToOneDecimal(
      clampToAllocation(Number.isFinite(accrued) ? accrued : baseDefaults.accrued)
    ),
    taken: roundToOneDecimal(Number.isFinite(taken) ? taken : baseDefaults.taken)
  };
}

function getLeaveBalanceValue(leaveBalances, type) {
  if (!leaveBalances || typeof leaveBalances !== 'object') return 0;
  const entry = leaveBalances[type];
  if (entry && typeof entry === 'object') {
    return roundToOneDecimal(entry.balance);
  }
  return roundToOneDecimal(entry);
}

function setLeaveBalanceValue(leaveBalances, type, value) {
  if (!leaveBalances || typeof leaveBalances !== 'object') return;
  const defaults = DEFAULT_LEAVE_BALANCES[type] || { balance: 0, yearlyAllocation: 0, monthlyAccrual: 0 };
  const normalized = normalizeLeaveBalanceEntry(
    typeof value === 'object' && value !== null ? value.balance ?? value : value,
    defaults
  );
  if (!leaveBalances[type] || typeof leaveBalances[type] !== 'object') {
    leaveBalances[type] = { ...defaults, ...normalized };
    return;
  }
  leaveBalances[type] = { ...leaveBalances[type], ...normalized };
}

function ensureLeaveBalances(emp, options = {}) {
  if (!emp) return false;
  if (!emp.leaveBalances || typeof emp.leaveBalances !== 'object') {
    emp.leaveBalances = cloneDefaultLeaveBalances();
  }

  let updated = false;
  const cycle = getCurrentCycleRange(options.now instanceof Date ? options.now : new Date());

  SUPPORTED_LEAVE_TYPES.forEach(type => {
    const defaults = DEFAULT_LEAVE_BALANCES[type];
    const current = emp.leaveBalances[type];
    const normalized = normalizeLeaveBalanceEntry(current, defaults);
    const merged = { ...defaults, ...normalized };
    if (JSON.stringify(current || {}) !== JSON.stringify(merged)) {
      emp.leaveBalances[type] = merged;
      updated = true;
    }
  });

  if (!emp.leaveBalances.cycleStart) {
    emp.leaveBalances.cycleStart = cycle.start;
    updated = true;
  }
  if (!emp.leaveBalances.cycleEnd) {
    emp.leaveBalances.cycleEnd = cycle.end;
    updated = true;
  }
  if (!('lastAccrualRun' in emp.leaveBalances)) {
    emp.leaveBalances.lastAccrualRun = null;
    updated = true;
  }

  return updated;
}

function refreshEmployeeLeaveBalances(employee, data, options = {}) {
  if (!employee || typeof employee !== 'object') {
    return { updated: false, balances: null };
  }

  const asOfDate = options.asOfDate instanceof Date ? options.asOfDate : new Date();
  const cycleRange = options.cycleRange || getCurrentCycleRange(asOfDate);
  const applications = Array.isArray(data?.applications) ? data.applications : [];
  const holidays = Array.isArray(data?.holidays) ? data.holidays : [];

  const { balances } = buildEmployeeLeaveState(employee, applications, {
    asOfDate,
    cycleRange,
    holidays
  });

  const current = employee.leaveBalances || {};
  const hasChanged = JSON.stringify(current) !== JSON.stringify(balances);
  if (hasChanged) {
    employee.leaveBalances = balances;
  }

  return { updated: hasChanged, balances: employee.leaveBalances };
}

function formatLeaveBalancesForResponse(balances, { dateNow = new Date() } = {}) {
  const cycle = getCurrentLeaveCycleInfo(dateNow);
  const toEntry = (entry = {}, defaultEntitlement = 0) => ({
    entitlement: Number.isFinite(entry?.entitlement) ? entry.entitlement : defaultEntitlement,
    earned: roundToOneDecimal(entry?.earned || 0),
    taken: roundToOneDecimal(entry?.taken || 0),
    balance: roundToOneDecimal(entry?.balance || 0)
  });

  return {
    annual: toEntry(balances?.annual, DEFAULT_ENTITLEMENTS.annual),
    casual: toEntry(balances?.casual, DEFAULT_ENTITLEMENTS.casual),
    medical: toEntry(balances?.medical, DEFAULT_ENTITLEMENTS.medical),
    cycleStart: cycle.cycleStart,
    cycleEnd: cycle.cycleEnd,
    yearLabel: cycle.yearLabel
  };
}

async function getComputedLeaveBalances(employee, options = {}) {
  if (!employee) return { raw: null, formatted: null };
  const dateNow = options.dateNow instanceof Date ? options.dateNow : new Date();
  const balances = await computeAllLeaveBalances(employee, {
    dateNow,
    applications: options.applications || (db.data && db.data.applications),
    holidays: options.holidays || (db.data && db.data.holidays)
  });

  return { raw: balances, formatted: formatLeaveBalancesForResponse(balances, { dateNow }) };
}

function normalizeBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return defaultValue;
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
  }
  return Boolean(value);
}

function ensureInternFlag(emp) {
  if (!emp || typeof emp !== 'object') return false;
  const normalized = normalizeBooleanFlag(emp.internFlag, false);
  if (emp.internFlag !== normalized) {
    emp.internFlag = normalized;
    return true;
  }
  return false;
}

const PROFILE_SECTIONS = [
  {
    id: 'personal',
    title: 'Personal Information',
    keywords: ['personal', 'dob', 'date of birth', 'birth', 'birthday', 'nationality', 'citizen', 'address', 'city', 'state', 'country', 'postal', 'zip', 'marital', 'gender'],
    editable: true
  },
  {
    id: 'contact',
    title: 'Contact Information',
    keywords: ['contact', 'phone', 'mobile', 'whatsapp', 'telegram', 'skype', 'linkedin', 'email'],
    editable: true
  },
  {
    id: 'emergency',
    title: 'Emergency Contacts',
    keywords: ['emergency', 'next of kin', 'next-of-kin', 'kin', 'guardian'],
    editable: true
  },
  {
    id: 'employment',
    title: 'Employment History & Position',
    keywords: ['start', 'end', 'tenure', 'history', 'promotion', 'internship', 'probation', 'experience', 'full time', 'contract'],
    editable: false
  },
  {
    id: 'department',
    title: 'Department & Role Assignment',
    keywords: ['department', 'project', 'role', 'title', 'manager', 'supervisor', 'appraiser', 'reporting', 'team', 'current', 'position', 'status'],
    editable: false
  }
];

const PROFILE_EDITABLE_KEYWORDS = {
  personal: ['dob', 'date of birth', 'birth', 'birthday', 'nationality', 'citizen', 'address', 'city', 'state', 'country', 'postal', 'zip', 'marital', 'gender'],
  contact: ['contact', 'phone', 'mobile', 'whatsapp', 'telegram', 'skype', 'linkedin'],
  emergency: ['emergency', 'kin', 'guardian']
};

const PROFILE_EXCLUDED_KEYS = new Set(['id', '_id', 'leaveBalances']);

function normalizeProfileKey(key) {
  return typeof key === 'string' ? key.trim().toLowerCase() : '';
}

function formatProfileLabel(key) {
  if (!key) return 'Field';
  return String(key)
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)([a-z])/g, (_, space, char) => space + char.toUpperCase());
}

function determineProfileInputType(normalizedKey) {
  if (!normalizedKey) return 'text';
  if (normalizedKey.includes('address') || normalizedKey.includes('remarks')) return 'textarea';
  if (normalizedKey.includes('date')) return 'date';
  if (normalizedKey.includes('phone') || normalizedKey.includes('mobile') || normalizedKey.includes('contact')) return 'tel';
  return 'text';
}

function findValueByKeywords(employee, keywords = []) {
  if (!employee || typeof employee !== 'object') return '';
  const lowerKeywords = keywords.map(word => word.toLowerCase());
  return Object.entries(employee).reduce((acc, [key, value]) => {
    if (acc) return acc;
    const normalized = normalizeProfileKey(key);
    if (lowerKeywords.some(keyword => normalized.includes(keyword))) {
      if (value !== undefined && value !== null && value !== '') {
        return typeof value === 'string' ? value : String(value);
      }
    }
    return acc;
  }, '');
}

function buildEmployeeProfile(employee, options = {}) {
  const sectionMap = new Map(
    PROFILE_SECTIONS.map(section => [section.id, { id: section.id, title: section.title, editable: section.editable, fields: [] }])
  );

  Object.entries(employee || {}).forEach(([key, value]) => {
    if (PROFILE_EXCLUDED_KEYS.has(key)) return;
    const normalizedKey = normalizeProfileKey(key);
    const sectionDef = PROFILE_SECTIONS.find(section =>
      section.keywords.some(keyword => normalizedKey.includes(keyword))
    ) || PROFILE_SECTIONS[0];
    const section = sectionMap.get(sectionDef.id);
    if (!section) return;
    const editableKeywords = PROFILE_EDITABLE_KEYWORDS[sectionDef.id] || [];
    const editable = sectionDef.editable && editableKeywords.some(keyword => normalizedKey.includes(keyword));
    const fieldValue = value === null || typeof value === 'undefined' ? '' : value;
    const inputType = determineProfileInputType(normalizedKey);
    section.fields.push({
      key,
      label: formatProfileLabel(key),
      value: typeof fieldValue === 'string' ? fieldValue : String(fieldValue),
      editable,
      type: inputType
    });
  });

  const sections = Array.from(sectionMap.values())
    .filter(section => section.fields.length > 0)
    .map(section => ({ id: section.id, title: section.title, fields: section.fields }));

  const providedLeaveBalances =
    options.leaveBalances && typeof options.leaveBalances === 'object'
      ? options.leaveBalances
      : null;

  return {
    employeeId: employee?.id || null,
    name: employee?.name || '',
    email: getEmpEmail(employee),
    leaveBalances: (() => {
      if (providedLeaveBalances) return providedLeaveBalances;
      if (employee?.leaveBalances && typeof employee.leaveBalances === 'object') {
        return employee.leaveBalances;
      }
      const wrapper = { leaveBalances: cloneDefaultLeaveBalances() };
      ensureLeaveBalances(wrapper);
      return wrapper.leaveBalances;
    })(),
    summary: {
      title: findValueByKeywords(employee, ['title', 'position']),
      department: findValueByKeywords(employee, ['department', 'project']),
      manager: findValueByKeywords(employee, ['appraiser', 'manager', 'supervisor', 'reporting']),
      status:
        typeof employee?.status === 'string' && employee.status
          ? employee.status
          : findValueByKeywords(employee, ['status'])
    },
    sections
  };
}

function buildUserInfoOpenApiPath() {
  return {
    get: {
      summary: 'Retrieve detailed user information',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string' },
          description: 'Unique identifier of the user or employee.'
        }
      ],
      responses: {
        200: {
          description: 'User information payload',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UserInformationResponse' }
            }
          }
        },
        403: { description: 'Forbidden' },
        404: { description: 'User not found' }
      }
    }
  };
}

function buildUserInfoLookupOpenApiPath() {
  return {
    post: {
      summary: 'Retrieve detailed user information by employee ID',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UserInformationLookupRequest' }
          }
        }
      },
      responses: {
        200: {
          description: 'User information payload',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UserInformationResponse' }
            }
          }
        },
        400: { description: 'Employee ID is required' },
        403: { description: 'Forbidden' },
        404: { description: 'User not found' }
      }
    }
  };
}

function buildLeaveApplicationSchemas() {
  const leaveTypes = SUPPORTED_LEAVE_TYPES;
  return {
    EmployeeScopedRequest: {
      type: 'object',
      properties: {
        employeeId: {
          type: 'string',
          description:
            'Optional employee identifier. Required when acting on behalf of another employee.'
        }
      }
    },
    LeaveApplicationSummary: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'] },
        employeeId: { type: 'string' },
        type: { type: 'string', enum: leaveTypes },
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
        status: { type: 'string' },
        reason: { type: 'string' },
        halfDay: { type: 'boolean' },
        halfDayType: { type: ['string', 'null'] },
        days: { type: 'number', format: 'float' },
        allowNegativeBalance: { type: 'boolean' },
        approvedBy: { type: 'string' },
        approverRemark: { type: 'string' },
        approvedAt: { type: 'string', format: 'date-time' },
        cancelledAt: { type: 'string', format: 'date-time' }
      }
    },
    LeaveUsageResponse: {
      type: 'object',
      properties: {
        employeeId: { type: 'string' },
        totalApprovedDays: { type: 'number', format: 'float' },
        applications: {
          type: 'array',
          items: { $ref: '#/components/schemas/LeaveApplicationSummary' }
        }
      }
    },
    PendingLeaveResponse: {
      type: 'object',
      properties: {
        employeeId: { type: 'string' },
        totalPendingDays: { type: 'number', format: 'float' },
        pendingApplications: {
          type: 'array',
          items: { $ref: '#/components/schemas/LeaveApplicationSummary' }
        }
      }
    },
    LeaveBalanceResponse: {
      type: 'object',
      properties: {
        employeeId: { type: 'string' },
        leaveBalances: {
          type: 'object',
          additionalProperties: { type: 'number', format: 'float' }
        }
      }
    },
    LeaveApplicationRequest: {
      type: 'object',
      required: ['employeeId', 'type', 'from', 'to'],
      properties: {
        employeeId: { type: 'string' },
        type: {
          type: 'string',
          enum: leaveTypes
        },
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
        reason: { type: 'string' },
        halfDay: { type: 'boolean' },
        halfDayType: { type: 'string' }
      }
    },
    LeaveApplicationResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        application: {
          $ref: '#/components/schemas/LeaveApplicationSummary'
        }
      }
    }
  };
}

function buildLeaveApplicationPaths() {
  return {
    '/api/leave/existing-days': {
      post: {
        summary: 'Retrieve approved leave usage by employee',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EmployeeScopedRequest' }
            }
          }
        },
        responses: {
          200: {
            description: 'Approved leave totals for the employee',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LeaveUsageResponse' }
              }
            }
          },
          400: { description: 'Employee ID missing' },
          403: { description: 'Forbidden' },
          404: { description: 'Employee not found' }
        }
      }
    },
    '/api/leave/pending': {
      post: {
        summary: 'Retrieve pending leave applications for an employee',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EmployeeScopedRequest' }
            }
          }
        },
        responses: {
          200: {
            description: 'Pending leave applications and totals',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PendingLeaveResponse' }
              }
            }
          },
          400: { description: 'Employee ID missing' },
          403: { description: 'Forbidden' },
          404: { description: 'Employee not found' }
        }
      }
    },
    '/api/leave/balance': {
      post: {
        summary: 'Retrieve current leave balances for an employee',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EmployeeScopedRequest' }
            }
          }
        },
        responses: {
          200: {
            description: 'Leave balance details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LeaveBalanceResponse' }
              }
            }
          },
          400: { description: 'Employee ID missing' },
          403: { description: 'Forbidden' },
          404: { description: 'Employee not found' }
        }
      }
    },
    '/api/leave/submit': {
      post: {
        summary: 'Submit a leave application',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LeaveApplicationRequest' }
            }
          }
        },
        responses: {
          201: {
            description: 'Leave application created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LeaveApplicationResponse' }
              }
            }
          },
          400: { description: 'Validation error' },
          403: { description: 'Forbidden' }
        }
      }
    }
  };
}

function buildLeaveApplicationOpenApiSpec() {
  const schemas = buildLeaveApplicationSchemas();
  return {
    openapi: '3.0.0',
    info: {
      title: 'Leave Application API',
      version: '1.0.0',
      description: 'API specification for leave application utilities.'
    },
    servers: [{ url: 'http://localhost:3000' }],
    paths: buildLeaveApplicationPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas
    }
  };
}

function buildUserInfoOpenApiSchemas() {
  return {
    ManagerInformation: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string' },
        employeeId: { type: ['string', 'null'] },
        email: { type: ['string', 'null'], format: 'email' }
      }
    },
    UserInformationResponse: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        employeeId: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
        email: { type: ['string', 'null'], format: 'email' },
        role: { type: 'string' },
        title: { type: ['string', 'null'] },
        department: { type: ['string', 'null'] },
        manager: { $ref: '#/components/schemas/ManagerInformation' }
      }
    },
    UserInformationLookupRequest: {
      type: 'object',
      required: ['employeeId'],
      properties: {
        employeeId: {
          type: 'string',
          description: 'Employee identifier used for lookup.'
        }
      }
    }
  };
}

function upsertUserForEmployee(emp) {
  if (!emp) return false;
  normalizeEmployeeEmail(emp);
  const email = (getEmpEmail(emp) || '').trim();
  if (!email) return false;
  db.data.users = db.data.users || [];
  const normalizedEmail = email.toLowerCase();
  const existing = db.data.users.find(
    u => u.employeeId == emp.id || (u.email && u.email.toLowerCase() === normalizedEmail)
  );
  const role = getEmpRole(emp);
  if (existing) {
    let changed = false;
    if (existing.email !== email) {
      existing.email = email;
      changed = true;
    }
    if (existing.employeeId !== emp.id) {
      existing.employeeId = emp.id;
      changed = true;
    }
    if (existing.role !== role) {
      existing.role = role;
      changed = true;
    }
    if (!existing.password) {
      existing.password = 'brillar';
      changed = true;
    }
    return changed;
  }

  db.data.users.push({
    id: emp.id,
    email,
    password: 'brillar',
    role,
    employeeId: emp.id
  });
  return true;
}

const SESSION_TOKENS = {}; // token: userId
const WIDGET_JWT_SECRET = process.env.WIDGET_JWT_SECRET || process.env.JWT_SECRET || 'brillar-widget-secret';
const WIDGET_JWT_EXPIRES_IN = Number(process.env.WIDGET_JWT_EXPIRES_IN || 300);

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now();
}

const CANDIDATE_STATUSES = [
  'New',
  'Selected for Interview',
  'Interview Completed',
  'Rejected',
  'Hired'
];
const POSITION_STATUSES = ['Open', 'Closed'];

function parsePositionStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!normalized || normalized === 'open') return 'Open';
  if (normalized === 'closed') return 'Closed';
  return null;
}

function normalizeAiInterviewQuestions(aiInterviewQuestions) {
  return Array.isArray(aiInterviewQuestions)
    ? aiInterviewQuestions
        .filter(q => q && typeof q.text === 'string' && q.text.trim().length > 0)
        .map((q, index) => ({
          id: q.id || `q${index + 1}`,
          text: q.text.trim()
        }))
    : [];
}

function normalizePositionsData(dbInstance) {
  if (!dbInstance || !dbInstance.data) return;
  dbInstance.data.positions = dbInstance.data.positions || [];
  dbInstance.data.positions.forEach(position => {
    if ((position.id === undefined || position.id === null) && position._id) {
      const derivedId = position._id?.getTimestamp?.()?.getTime?.();
      position.id = derivedId || Date.now();
    }
    if (!position.createdAt) {
      const createdAt = position._id?.getTimestamp?.();
      if (createdAt instanceof Date) {
        position.createdAt = createdAt.toISOString();
      }
    }
    position.isPublished = Boolean(position.isPublished);
    position.location = position.location || '';
    position.employmentType = position.employmentType || '';
    position.description = position.description || '';
    position.requirements = position.requirements || '';
    position.status = parsePositionStatus(position.status) || 'Open';
    position.aiInterviewQuestions = normalizeAiInterviewQuestions(position.aiInterviewQuestions);
  });
}

function buildPositionTitleMap(positions = []) {
  return new Map(
    positions.map(pos => [String(pos.id ?? pos._id), pos.title || null])
  );
}

function resolveCandidateId(candidate) {
  if (!candidate) return null;
  if (candidate.id !== undefined && candidate.id !== null) {
    return candidate.id;
  }
  if (candidate._id) return candidate._id.toString();
  return null;
}

function buildCandidateCvSummary(candidate) {
  if (!candidate) return null;
  if (candidate.cv && candidate.cv.data) {
    return {
      filename: candidate.cv.filename,
      contentType: candidate.cv.contentType || 'application/octet-stream'
    };
  }

  if (candidate.cvFilePath) {
    const filename =
      candidate.cvFilename || candidate.cv?.filename || 'CV Document';
    const contentType =
      candidate.cvContentType || candidate.cv?.contentType || 'application/octet-stream';
    return { filename, contentType, filePath: candidate.cvFilePath };
  }

  return null;
}

function buildCandidateSummary(candidate, positionMap = new Map()) {
  if (!candidate) return null;
  const id = resolveCandidateId(candidate);
  const commentCount = Array.isArray(candidate.comments)
    ? candidate.comments.length
    : 0;
  const cv = buildCandidateCvSummary(candidate);
  const positionKey = candidate.positionId ?? candidate.positionLegacyId;
  const contact = candidate.contact || candidate.email || candidate.phone || '';

  return {
    id,
    name: candidate.name || '',
    contact,
    email: candidate.email || null,
    source: candidate.source || null,
    status: candidate.status || null,
    notes: candidate.notes || null,
    positionId: positionKey,
    positionTitle: positionMap.get(String(positionKey)) || null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    commentCount,
    hasCv: Boolean(cv),
    cvFilename: cv?.filename || null,
    cvContentType: cv?.contentType || null,
    cv
  };
}

function computePairRequestTtlSeconds() {
  const span = PAIR_REQUEST_TTL_MAX_SECONDS - PAIR_REQUEST_TTL_MIN_SECONDS;
  if (span <= 0) {
    return PAIR_REQUEST_TTL_MIN_SECONDS;
  }
  return (
    PAIR_REQUEST_TTL_MIN_SECONDS + Math.floor(Math.random() * (span + 1))
  );
}

function generatePairRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return crypto.randomBytes(16).toString('hex');
}

function pruneExpiredEntries(map, now, windowMs) {
  for (const [key, entry] of map.entries()) {
    if (now - entry.windowStart >= windowMs) {
      map.delete(key);
    }
  }
}

function checkRateLimit(map, key, limit, windowMs) {
  if (!limit || limit <= 0) return true;
  const now = Date.now();
  const existing = map.get(key);
  if (!existing || now - existing.windowStart >= windowMs) {
    map.set(key, { count: 1, windowStart: now });
    pruneExpiredEntries(map, now, windowMs * 5);
    return true;
  }
  if (existing.count < limit) {
    existing.count += 1;
    return true;
  }
  return false;
}

const initRateLimiter = new Map();
const pollRateLimiter = new Map();
const claimRateLimiter = new Map();

const agentSignatureCache = new Map();

function verifyAgentRequest(req) {
  if (!PAIR_AGENT_SECRET) {
    return {
      ok: false,
      status: 503,
      error: 'Agent authentication is not configured'
    };
  }

  const signatureHeader = (req.get('x-agent-signature') || '').trim().toLowerCase();
  const timestampHeader = (req.get('x-agent-timestamp') || '').trim();
  const agentIdHeader = (req.get('x-agent-id') || PAIR_AGENT_ID).trim();

  if (!signatureHeader || !timestampHeader) {
    return { ok: false, status: 401, error: 'Missing agent authentication headers' };
  }

  if (!/^[a-f0-9]+$/.test(signatureHeader)) {
    return { ok: false, status: 401, error: 'Invalid agent signature format' };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, status: 401, error: 'Invalid agent timestamp' };
  }

  const nowMs = Date.now();
  if (Math.abs(nowMs - timestamp) > PAIR_AGENT_SIGNATURE_TOLERANCE_MS) {
    return { ok: false, status: 401, error: 'Agent signature timestamp out of range' };
  }

  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
  const baseString = `${agentIdHeader}:${timestamp}:${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', PAIR_AGENT_SECRET)
    .update(baseString)
    .digest('hex');

  const providedBuffer = Buffer.from(signatureHeader, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false, status: 401, error: 'Agent signature mismatch' };
  }

  for (const [cacheKey, seenAt] of agentSignatureCache.entries()) {
    if (nowMs - seenAt > PAIR_AGENT_REPLAY_WINDOW_MS) {
      agentSignatureCache.delete(cacheKey);
    }
  }

  const replayKey = `${agentIdHeader}:${timestamp}:${expectedSignature}`;
  if (agentSignatureCache.has(replayKey)) {
    return { ok: false, status: 401, error: 'Replay detected' };
  }

  agentSignatureCache.set(replayKey, nowMs);

  return { ok: true, agentId: agentIdHeader, timestamp };
}

function requireAgentAuth(req, res, next) {
  const verification = verifyAgentRequest(req);
  if (!verification.ok) {
    const status = verification.status || 401;
    return res.status(status).json({ error: verification.error || 'Unauthorized' });
  }
  req.agentAuth = {
    agentId: verification.agentId,
    timestamp: verification.timestamp
  };
  next();
}

function sanitizeComment(comment, currentUser) {
  if (!comment) return null;
  return {
    id: comment.id,
    text: comment.text,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: {
      id: comment.userId,
      email: comment.userEmail
    },
    canEdit: Boolean(currentUser && comment.userId === currentUser.id)
  };
}

function generateCommentId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const rawBodySaver = (req, res, buf) => {
  req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
};

app.use(bodyParser.json({ limit: BODY_LIMIT, verify: rawBodySaver }));
app.use(bodyParser.urlencoded({ limit: BODY_LIMIT, extended: true, verify: rawBodySaver }));
app.use((req, res, next) => {
  if (typeof req.rawBody !== 'string') {
    req.rawBody = '';
  }
  next();
});
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(getUploadsRoot()));
app.use('/api/hr', hrPositionsRoutes);
app.use('/api/hr', hrAiInterviewRoutes);
app.use('/api/hr', hrApplicationsRoutes);
app.use('/api/public', publicCareersRoutes);
app.use('/api/public', publicAiInterviewRoutes);

app.get('/careers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'careers.html'));
});

app.get('/ai-interview/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ai-interview.html'));
});

function resolveToken(req) {
  const headerToken = req.headers.authorization?.split(' ')[1];
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  return headerToken || cookieToken || null;
}

async function resolveUserFromSession(token) {
  if (!token || !SESSION_TOKENS[token]) {
    return null;
  }
  const userId = SESSION_TOKENS[token];
  await db.read();
  let user = db.data.users?.find(u => u.id === userId);
  if (!user && userId === 'admin') {
    user = { id: 'admin', email: ADMIN_EMAIL, role: 'superadmin', employeeId: null };
  }
  if (!user) {
    delete SESSION_TOKENS[token];
    return null;
  }
  return user;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  const sameSite = ['lax', 'strict', 'none'].includes(SESSION_COOKIE_SAMESITE)
    ? SESSION_COOKIE_SAMESITE
    : 'lax';
  const cookieOptions = {
    httpOnly: true,
    secure: sameSite === 'none' ? true : secure,
    sameSite,
    maxAge: Number.isFinite(SESSION_COOKIE_MAX_AGE) && SESSION_COOKIE_MAX_AGE > 0
      ? SESSION_COOKIE_MAX_AGE
      : undefined
  };
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  const sameSite = ['lax', 'strict', 'none'].includes(SESSION_COOKIE_SAMESITE)
    ? SESSION_COOKIE_SAMESITE
    : 'lax';
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: sameSite === 'none' ? true : secure,
    sameSite
  });
}

// ---- AUTH ----
async function authRequired(req, res, next) {
  const token = resolveToken(req);
  const user = await resolveUserFromSession(token);
  if (user) {
    if (!isManagerRole(user.role)) {
      const employees = Array.isArray(db.data.employees) ? db.data.employees : [];
      const emp = employees.find(e => e.id == user.employeeId);
      if (!isEmployeeActive(emp)) {
        delete SESSION_TOKENS[token];
        if (req.cookies?.[SESSION_COOKIE_NAME]) {
          clearSessionCookie(res);
        }
        return res.status(403).json({ error: 'Employee account is inactive' });
      }
    }
    req.user = user;
    return next();
  }

  if (req.cookies?.[SESSION_COOKIE_NAME]) {
    clearSessionCookie(res);
  }

  req.user = {
    id: 'public-admin',
    email: ADMIN_EMAIL || 'public@brillar.io',
    role: 'manager',
    employeeId: null
  };

  next();
}

function managerOnly(req, res, next) {
  if (!req.user || !isManagerRole(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

function superadminOnly(req, res, next) {
  if (!req.user || !isSuperAdminRole(req.user.role)) {
    return res.status(403).json({ error: 'Superadmin access required.' });
  }
  next();
}

async function ensureUsersForExistingEmployees() {
  await db.read();
  db.data.employees = db.data.employees || [];
  db.data.users = db.data.users || [];
  if (!Array.isArray(db.data.holidays)) {
    db.data.holidays = [];
  }
  if (!Array.isArray(db.data.salaries)) {
    db.data.salaries = [];
  }
  let changed = false;
  db.data.employees.forEach(emp => {
    if (normalizeEmployeeEmail(emp)) changed = true;
    if (ensureLeaveBalances(emp)) changed = true;
    if (upsertUserForEmployee(emp)) changed = true;
  });
  if (changed) {
    await db.write();
  }
}

init().then(async () => {
  await ensureUsersForExistingEmployees();
  await ensurePairingIndexes();
  // ========== MICROSOFT SSO ==========
  const oauthStates = new Set();

  app.get('/auth/microsoft', (req, res) => {
    if (!MS_CLIENT_ID) return res.status(500).send('SSO not configured');
    const state = genToken();
    oauthStates.add(state);
    const authUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize` +
      `?client_id=${encodeURIComponent(MS_CLIENT_ID)}` +
      `&response_type=code` +
      `&response_mode=query` +
      `&redirect_uri=${encodeURIComponent(MS_REDIRECT_URI)}` +
      `&scope=openid%20profile%20email` +
      `&state=${state}`;
    res.redirect(authUrl);
  });

  app.get('/auth/microsoft/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) {
      return res.status(400).send('Invalid auth response');
    }
    oauthStates.delete(state);
    try {
      const tokenRes = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: MS_CLIENT_ID,
          client_secret: MS_CLIENT_SECRET,
          code,
          redirect_uri: MS_REDIRECT_URI,
          grant_type: 'authorization_code',
          scope: 'openid profile email'
        })
      });
      const tokenData = await tokenRes.json();
      const idToken = tokenData.id_token;
      if (!idToken) throw new Error('No id_token');
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
      const email = payload.preferred_username || payload.email || payload.upn;
      await db.read();
      let user = db.data.users?.find(u => u.email === email);
      let userObj;
      if (user) {
        userObj = { id: user.id, email: user.email, role: user.role, employeeId: user.employeeId };
      } else if (email === ADMIN_EMAIL) {
        userObj = { id: 'admin', email: ADMIN_EMAIL, role: 'superadmin', employeeId: null };
      } else {
        return res.status(401).send('User not found');
      }
      const token = genToken();
      SESSION_TOKENS[token] = userObj.id;
      setSessionCookie(res, token);
      const redirect = `/?token=${token}&user=${encodeURIComponent(JSON.stringify(userObj))}`;
      res.redirect(redirect);
    } catch (err) {
      console.error('Microsoft auth failed', err);
      res.status(500).send('Authentication failed');
    }
  });

  // ========== PAIRING ENDPOINTS ==========
  app.post('/pair/init', authRequired, async (req, res) => {
    const { client_id: rawClientId, tab_id: rawTabId } = req.body || {};
    const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
    if (!clientId) {
      return res.status(400).json({ error: 'client_id is required' });
    }

    const tabId =
      rawTabId === undefined || rawTabId === null
        ? null
        : String(rawTabId).trim() || null;

    const rateKey = `${req.user.id}:${clientId}`;
    if (
      !checkRateLimit(
        initRateLimiter,
        rateKey,
        PAIR_INIT_RATE_LIMIT,
        PAIR_INIT_RATE_WINDOW_MS
      )
    ) {
      return res.status(429).json({ error: 'Too many pairing attempts' });
    }

    const ttlSeconds = computePairRequestTtlSeconds();

    let created;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const requestId = generatePairRequestId();
      try {
        created = await createPairingRequest({
          requestId,
          userId: req.user.id,
          clientId,
          tabId,
          scope: PAIR_TOKEN_SCOPE,
          ttlSeconds
        });
        break;
      } catch (err) {
        if (err && err.code === 11000) {
          continue;
        }
        console.error('Failed to create pairing request', err);
        return res.status(500).json({ error: 'Failed to create pairing request' });
      }
    }

    if (!created) {
      return res.status(500).json({ error: 'Failed to create pairing request' });
    }

    res.status(201).json({
      request_id: created.requestId,
      client_id: created.clientId,
      tab_id: created.tabId,
      scope: created.scope,
      ttl_seconds: created.ttlSeconds,
      expires_at: created.expiresAt.toISOString()
    });
  });

  app.post('/pair/poll', requireAgentAuth, async (req, res) => {
    const { client_id: rawClientId, client_instance_id: rawInstanceId } = req.body || {};
    const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
    if (!clientId) {
      return res.status(400).json({ error: 'client_id is required' });
    }

    const clientInstanceId =
      rawInstanceId === undefined || rawInstanceId === null
        ? null
        : String(rawInstanceId).trim() || null;

    const rateKey = `${clientId}:${clientInstanceId || 'default'}`;
    if (
      !checkRateLimit(
        pollRateLimiter,
        rateKey,
        PAIR_POLL_RATE_LIMIT,
        PAIR_POLL_RATE_WINDOW_MS
      )
    ) {
      return res.status(429).json({ error: 'Polling rate limit exceeded' });
    }

    try {
      const leased = await leasePendingRequest({
        clientId,
        agentId: req.agentAuth.agentId,
        clientInstanceId,
        leaseDurationMs: PAIR_POLL_LEASE_SECONDS * 1000
      });

      if (!leased) {
        return res.status(204).end();
      }

      return res.json({
        request_id: leased.requestId,
        claim_token: leased.claimToken,
        user_id: leased.userId,
        client_id: leased.clientId,
        tab_id: leased.tabId,
        scope: leased.scope,
        expires_at: leased.expiresAt.toISOString(),
        lease_expires_at: leased.leaseExpiresAt.toISOString()
      });
    } catch (err) {
      console.error('Failed to poll pairing requests', err);
      return res.status(500).json({ error: 'Failed to poll pairing requests' });
    }
  });

  app.post('/pair/claim', requireAgentAuth, async (req, res) => {
    const {
      request_id: rawRequestId,
      claim_token: rawClaimToken,
      client_instance_id: rawInstanceId
    } = req.body || {};

    const requestId = typeof rawRequestId === 'string' ? rawRequestId.trim() : '';
    const claimToken =
      typeof rawClaimToken === 'string' ? rawClaimToken.trim().toLowerCase() : '';

    if (!requestId) {
      return res.status(400).json({ error: 'request_id is required' });
    }
    if (!claimToken) {
      return res.status(400).json({ error: 'claim_token is required' });
    }

    const clientInstanceId =
      rawInstanceId === undefined || rawInstanceId === null
        ? null
        : String(rawInstanceId).trim() || null;

    const rateKey = `${req.agentAuth.agentId}:${requestId}`;
    if (
      !checkRateLimit(
        claimRateLimiter,
        rateKey,
        PAIR_CLAIM_RATE_LIMIT,
        PAIR_CLAIM_RATE_WINDOW_MS
      )
    ) {
      return res.status(429).json({ error: 'Claim rate limit exceeded' });
    }

    try {
      const claimed = await claimPairingRequest({
        requestId,
        claimToken,
        agentId: req.agentAuth.agentId,
        clientInstanceId
      });

      if (!claimed) {
        const existing = await getPairRequestById(requestId);
        if (!existing) {
          return res.status(404).json({ error: 'Pairing request not found' });
        }
        const expiration =
          existing.expiresAt instanceof Date
            ? existing.expiresAt
            : existing.expiresAt
              ? new Date(existing.expiresAt)
              : null;
        if (!expiration || expiration <= new Date()) {
          return res.status(410).json({ error: 'Pairing request expired' });
        }
        if (existing.status === 'claimed') {
          return res.status(410).json({ error: 'Pairing request already claimed' });
        }
        return res.status(410).json({ error: 'Pairing request lease expired' });
      }

      if (!PAIR_TOKEN_SECRET) {
        return res.status(503).json({ error: 'Pairing token signer not configured' });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiresAtSeconds = nowSeconds + PAIR_TOKEN_TTL_SECONDS;
      const scope = claimed.scope || PAIR_TOKEN_SCOPE;
      const payload = {
        sub: String(claimed.userId),
        user_id: claimed.userId,
        aud: PAIR_TOKEN_AUDIENCE,
        iss: PAIR_TOKEN_ISSUER,
        jti: generatePairRequestId(),
        scope,
        iat: nowSeconds,
        exp: expiresAtSeconds
      };

      const token = jwt.sign(payload, PAIR_TOKEN_SECRET, {
        algorithm: PAIR_TOKEN_ALGORITHM
      });

      return res.json({
        token,
        token_type: 'Bearer',
        scope,
        expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
        request: {
          request_id: claimed.requestId,
          client_id: claimed.clientId,
          tab_id: claimed.tabId
        },
        user: {
          id: claimed.userId
        }
      });
    } catch (err) {
      console.error('Failed to claim pairing request', err);
      return res.status(500).json({ error: 'Failed to claim pairing request' });
    }
  });

  // ========== LOGIN ==========
  app.post('/login', async (req, res) => {
    await db.read();
    const { email, password } = req.body;
    const user = db.data.users?.find(u => u.email === email && u.password === password);

    let userObj;
    if (user) {
      if (!isManagerRole(user.role)) {
        const employees = Array.isArray(db.data.employees) ? db.data.employees : [];
        const emp = employees.find(e => e.id == user.employeeId);
        if (!isEmployeeActive(emp)) {
          return res.status(403).json({ error: 'Employee account is inactive' });
        }
      }
      userObj = {
        id: user.id,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId
      };
    } else if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      userObj = {
        id: 'admin',
        email: ADMIN_EMAIL,
        role: 'superadmin',
        employeeId: null
      };
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = genToken();
    SESSION_TOKENS[token] = userObj.id;
    setSessionCookie(res, token);
    res.json({ token, user: userObj });
  });

  app.get('/api/widget/token', async (req, res) => {
    const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = await resolveUserFromSession(sessionToken);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!isManagerRole(user.role)) {
      const employees = Array.isArray(db.data.employees) ? db.data.employees : [];
      const emp = employees.find(e => e.id == user.employeeId);
      if (!isEmployeeActive(emp)) {
        delete SESSION_TOKENS[sessionToken];
        clearSessionCookie(res);
        return res.status(403).json({ error: 'Employee account is inactive' });
      }
    }

    const expiresIn = Number.isFinite(WIDGET_JWT_EXPIRES_IN) && WIDGET_JWT_EXPIRES_IN > 0
      ? WIDGET_JWT_EXPIRES_IN
      : 300;
    const payload = {
      sub: user.id,
      role: user.role,
      email: user.email,
      employeeId: user.employeeId ?? null,
      aud: 'brillar-widget',
      iss: 'brillar-hr-portal'
    };
    const token = jwt.sign(payload, WIDGET_JWT_SECRET, { expiresIn });
    res.set('Cache-Control', 'no-store');
    res.json({ token, expires_in: expiresIn });
  });

  // ========== CHANGE PASSWORD ==========
  app.post('/change-password', authRequired, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    await db.read();
    const user = db.data.users?.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.password !== currentPassword) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    user.password = newPassword;
    await db.write();
    res.json({ success: true });
  });

  // ========== MY PROFILE ==========
  app.get('/api/my-profile', authRequired, async (req, res) => {
    if (!req.user.employeeId) {
      return res.status(404).json({ error: 'Employee profile not linked to this account.' });
    }
    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    const employee = db.data.employees.find(emp => emp.id == req.user.employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee profile not found.' });
    }
    const { formatted } = await getComputedLeaveBalances(employee, { dateNow: new Date() });
    res.json(buildEmployeeProfile(employee, { leaveBalances: formatted }));
  });

  app.put('/api/my-profile', authRequired, async (req, res) => {
    if (!req.user.employeeId) {
      return res.status(404).json({ error: 'Employee profile not linked to this account.' });
    }
    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    const employee = db.data.employees.find(emp => emp.id == req.user.employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee profile not found.' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = payload.updates && typeof payload.updates === 'object'
      ? payload.updates
      : payload;

    const profileView = buildEmployeeProfile(employee);
    const editableKeys = new Set();
    profileView.sections.forEach(section => {
      section.fields.forEach(field => {
        if (field.editable) editableKeys.add(field.key);
      });
    });

    let applied = 0;
    let changed = false;
    Object.entries(updates || {}).forEach(([key, value]) => {
      if (!editableKeys.has(key)) return;
      applied += 1;
      const normalizedValue = value === null || typeof value === 'undefined'
        ? ''
        : typeof value === 'string'
          ? value.trim()
          : String(value);
      const currentValue = employee[key];
      const normalizedCurrent = currentValue === null || typeof currentValue === 'undefined'
        ? ''
        : typeof currentValue === 'string'
          ? currentValue
          : String(currentValue);
      if (normalizedCurrent !== normalizedValue) {
        employee[key] = normalizedValue;
        changed = true;
      }
    });

    if (changed) {
      await db.write();
    }

    const { formatted } = await getComputedLeaveBalances(employee, { dateNow: new Date() });
    const response = buildEmployeeProfile(employee, { leaveBalances: formatted });
    if (applied === 0) {
      response.message = 'No editable fields were updated.';
      response.messageType = 'info';
    } else if (!changed) {
      response.message = 'No changes detected.';
      response.messageType = 'info';
    } else {
      response.message = 'Profile updated successfully.';
      response.messageType = 'success';
    }
    res.json(response);
  });

  // ========== EMPLOYEES ==========
  app.get('/employees', authRequired, async (req, res) => {
    await db.read();
    let emps = db.data.employees || [];
    let internFlagUpdated = false;
    emps.forEach(emp => {
      if (ensureInternFlag(emp)) {
        internFlagUpdated = true;
      }
    });
    if (!isManagerRole(req.user.role)) {
      emps = emps.filter(e => e.id == req.user.employeeId);
    }
    if (internFlagUpdated) {
      await db.write();
    }
    const dateNow = new Date();
    const enrichedEmployees = await Promise.all(
      emps.map(async emp => {
        const { formatted } = await getComputedLeaveBalances(emp, {
          dateNow,
          applications: db.data.applications,
          holidays: db.data.holidays
        });
        return { ...emp, leaveBalances: formatted };
      })
    );
    res.json(enrichedEmployees);
  });

  app.post('/employees', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const id = Date.now();
    const payload = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    delete payload._id;
    if (!Array.isArray(db.data.employees)) {
      db.data.employees = [];
    }
    const employee = { id, ...payload };
    delete employee._id;
    assignEmployeeNumber(employee, db.data.employees);
    ensureLeaveBalances(employee);
    ensureInternFlag(employee);
    normalizeEmployeeEmail(employee);
    const email = getEmpEmail(employee);
    if (!email) {
      return res.status(400).json({ error: 'Employee email is required to create login credentials.' });
    }
    db.data.employees.push(employee);
    if (upsertUserForEmployee(employee)) {
      // When upsert adds a new user, db.data.users is already updated.
    }
    await db.write();
    res.status(201).json(employee);
  });

  // ---- BULK CSV UPLOAD ----
  app.post('/employees/bulk', authRequired, managerOnly, express.text({ type: '*/*' }), async (req, res) => {
    await db.read();
    try {
      const rows = parse(req.body, { columns: true, skip_empty_lines: true });
      const start = Date.now();
      rows.forEach((row, idx) => {
        const id = start + idx;
        const nameKey = Object.keys(row).find(k => k.toLowerCase() === 'name');
        const statusKey = Object.keys(row).find(k => k.toLowerCase() === 'status');
        const annualKey = Object.keys(row).find(k => k.toLowerCase().includes('annual'));
        const casualKey = Object.keys(row).find(k => k.toLowerCase().includes('casual'));
        const medicalKey = Object.keys(row).find(k => k.toLowerCase().includes('medical'));
        const emailKey = Object.keys(row).find(k => k.toLowerCase() === 'email');
        const roleKey = Object.keys(row).find(k => k.toLowerCase() === 'role');
        const emp = {
          id,
          name: row[nameKey] || '',
          status: row[statusKey]?.toLowerCase() === 'inactive' ? 'inactive' : 'active',
          leaveBalances: {
            annual: Number(row[annualKey] ?? 10),
            casual: Number(row[casualKey] ?? 5),
            medical: Number(row[medicalKey] ?? 14)
          },
          ...row
        };
        delete emp._id;
        ensureLeaveBalances(emp);
        ensureInternFlag(emp);
        normalizeEmployeeEmail(emp);
        db.data.employees.push(emp);
        upsertUserForEmployee(emp);
      });
      await db.write();
      res.status(201).json({ added: rows.length });
    } catch (err) {
      console.error('CSV parse failed', err);
      res.status(400).json({ error: 'Invalid CSV' });
    }
  });

  app.put('/employees/:id', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const emp = db.data.employees.find(e => e.id == req.params.id);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    const updates = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    delete updates._id;
    Object.assign(emp, updates);
    normalizeEmployeeEmail(emp);
    ensureLeaveBalances(emp);
    ensureInternFlag(emp);
    upsertUserForEmployee(emp);
    await db.write();
    res.json(emp);
  });

  app.patch('/employees/:id/status', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const emp = db.data.employees.find(e => e.id == req.params.id);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    emp.status = req.body.status;
    await db.write();
    res.json(emp);
  });

  app.delete('/employees/:id', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const idx = db.data.employees.findIndex(e => e.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const [removed] = db.data.employees.splice(idx, 1);
    if (removed) {
      db.data.users = db.data.users || [];
      const userIdx = db.data.users.findIndex(u => u.employeeId == removed.id);
      if (userIdx !== -1) {
        db.data.users.splice(userIdx, 1);
      }
    }
    await db.write();
    res.status(204).end();
  });

  // ========== RECRUITMENT PIPELINE ==========
  app.post('/api/recruitment/roles', authRequired, managerOnly, async (req, res) => {
    await db.read();
    normalizePositionsData(db);
    const title = (req.body.title || '').trim();
    const department = (req.body.department || '').trim();
    const description = (req.body.description || '').trim();
    const aiInterviewQuestions = normalizeAiInterviewQuestions(req.body.aiInterviewQuestions);
    const providedStatus = parsePositionStatus(req.body.status);
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (req.body.status !== undefined && providedStatus === null) {
      return res.status(400).json({ error: 'Status must be Open or Closed' });
    }
    const id = Date.now();
    const timestamp = new Date().toISOString();
    const role = {
      id,
      title,
      department,
      description,
      aiInterviewQuestions,
      status: providedStatus || 'Open',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.data.positions.push(role);
    await db.write();
    res.status(201).json(role);
  });

  app.post('/api/recruitment/candidates', authRequired, managerOnly, async (req, res) => {
    await db.read();
    normalizePositionsData(db);
    db.data.positions = db.data.positions || [];
    db.data.candidates = db.data.candidates || [];
    const resolvedRoleId = Number(req.body.roleId || req.body.positionId);
    if (!resolvedRoleId || Number.isNaN(resolvedRoleId)) {
      return res.status(400).json({ error: 'Valid role is required' });
    }
    const roleExists = db.data.positions.some(position => position.id == resolvedRoleId);
    if (!roleExists) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const name = (req.body.name || '').trim();
    const contact = (req.body.contact || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!contact) {
      return res.status(400).json({ error: 'Contact is required' });
    }
    const email = (req.body.email || '').trim();
    const notes = (req.body.notes || '').trim();
    const status = CANDIDATE_STATUSES.includes(req.body.status)
      ? req.body.status
      : 'New';
    const id = Date.now();
    const timestamp = new Date().toISOString();
    const candidate = {
      id,
      positionId: resolvedRoleId,
      name,
      contact,
      email: email || null,
      notes: notes || null,
      status,
      comments: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (req.body.cv && req.body.cv.data && req.body.cv.filename) {
      candidate.cv = {
        filename: req.body.cv.filename,
        contentType: req.body.cv.contentType || 'application/octet-stream',
        data: req.body.cv.data
      };
    }
    db.data.candidates.push(candidate);
    await db.write();
    const positionMap = buildPositionTitleMap(db.data.positions);
    res.status(201).json(buildCandidateSummary(candidate, positionMap));
  });

  app.get(
    '/api/recruitment/candidates/by-role',
    authRequired,
    managerOnly,
    async (req, res) => {
      await db.read();
      db.data.positions = db.data.positions || [];
      db.data.candidates = db.data.candidates || [];
      const roleId = Number(req.query.roleId || req.query.positionId);
      if (!roleId || Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'Role identifier is required' });
      }
      const roleExists = db.data.positions.some(position => position.id == roleId);
      if (!roleExists) {
        return res.status(404).json({ error: 'Role not found' });
      }
      const positionMap = buildPositionTitleMap(db.data.positions);
      const result = db.data.candidates
        .filter(candidate => candidate.positionId == roleId)
        .map(candidate => buildCandidateSummary(candidate, positionMap));
      res.json(result);
    }
  );

  app.get(
    '/api/recruitment/candidates/by-name',
    authRequired,
    managerOnly,
    async (req, res) => {
      await db.read();
      db.data.positions = db.data.positions || [];
      db.data.candidates = db.data.candidates || [];
      const rawQuery = (req.query.name || req.query.q || '').toString().trim();
      if (!rawQuery) {
        return res.status(400).json({ error: 'Name query is required' });
      }
      const query = rawQuery.toLowerCase();
      const positionMap = buildPositionTitleMap(db.data.positions);
      const matches = db.data.candidates
        .filter(candidate => (candidate.name || '').toLowerCase().includes(query))
        .sort(
          (a, b) =>
            new Date(b.updatedAt || b.createdAt || 0) -
            new Date(a.updatedAt || a.createdAt || 0)
        )
        .slice(0, 50)
        .map(candidate => buildCandidateSummary(candidate, positionMap));
      res.json(matches);
    }
  );

  app.get('/recruitment/positions', authRequired, managerOnly, async (req, res) => {
    await db.read();
    normalizePositionsData(db);
    res.json(db.data.positions);
  });

  app.post('/recruitment/positions', authRequired, managerOnly, async (req, res) => {
    await db.read();
    normalizePositionsData(db);
    const title = (req.body.title || '').trim();
    const department = (req.body.department || '').trim();
    const description = (req.body.description || '').trim();
    const aiInterviewQuestions = normalizeAiInterviewQuestions(req.body.aiInterviewQuestions);
    const providedStatus = parsePositionStatus(req.body.status);
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (req.body.status !== undefined && providedStatus === null) {
      return res.status(400).json({ error: 'Status must be Open or Closed' });
    }
    db.data.positions = db.data.positions || [];
    const id = Date.now();
    const newPosition = {
      id,
      title,
      department,
      description,
      aiInterviewQuestions,
      status: providedStatus || 'Open',
      createdAt: new Date().toISOString()
    };
    db.data.positions.push(newPosition);
    await db.write();
    res.status(201).json(newPosition);
  });

  app.patch('/recruitment/positions/:id', authRequired, managerOnly, async (req, res) => {
    await db.read();
    normalizePositionsData(db);
    const position = db.data.positions.find(p => p.id == req.params.id);
    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }
    const titleProvided = Object.prototype.hasOwnProperty.call(req.body, 'title');
    const departmentProvided = Object.prototype.hasOwnProperty.call(req.body, 'department');
    const descriptionProvided = Object.prototype.hasOwnProperty.call(req.body, 'description');
    const statusProvided = Object.prototype.hasOwnProperty.call(req.body, 'status');
    const aiInterviewQuestionsProvided = Object.prototype.hasOwnProperty.call(
      req.body,
      'aiInterviewQuestions'
    );
    const nextTitle = titleProvided ? String(req.body.title || '').trim() : position.title;
    if (!nextTitle) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const nextStatus = statusProvided ? parsePositionStatus(req.body.status) : parsePositionStatus(position.status);
    if (statusProvided && nextStatus === null) {
      return res.status(400).json({ error: 'Status must be Open or Closed' });
    }
    position.title = nextTitle;
    if (departmentProvided) {
      position.department = String(req.body.department || '').trim();
    }
    if (descriptionProvided) {
      position.description = String(req.body.description || '').trim();
    }
    if (aiInterviewQuestionsProvided) {
      position.aiInterviewQuestions = normalizeAiInterviewQuestions(req.body.aiInterviewQuestions);
    }
    position.status = nextStatus || 'Open';
    position.updatedAt = new Date().toISOString();
    await db.write();
    res.json(position);
  });

  app.get('/recruitment/candidates', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const { positionId } = req.query;
    db.data.candidates = db.data.candidates || [];
    const recruitmentApplications = Array.isArray(db.data.recruitmentApplications)
      ? db.data.recruitmentApplications
      : [];
    let list = db.data.candidates;
    if (positionId) {
      list = list.filter(
        c =>
          c.positionId == positionId ||
          c.positionLegacyId == positionId ||
          c.positionObjectId?.toString?.() === positionId
      );
    }
    const sanitized = list.map(c => {
      const { comments = [], ...rest } = c;
      const cv = buildCandidateCvSummary(c);
      const id = resolveCandidateId(c);
      const contact = c.contact || c.email || c.phone || '';
      const application = recruitmentApplications.find(app => {
        const appCandidateId = app?.candidateId?.toString?.();
        const appLegacyId = app?.candidateLegacyId;
        const matchesCandidate =
          (appCandidateId && c?._id && appCandidateId === c._id.toString()) ||
          (appLegacyId != null && c?.id != null && String(appLegacyId) === String(c.id));
        if (!matchesCandidate) return false;

        if (!positionId) return true;

        const appPositionId = app?.positionId?.toString?.();
        const appLegacyPositionId = app?.positionLegacyId;
        return (
          (appPositionId && appPositionId === positionId) ||
          (appLegacyPositionId != null && String(appLegacyPositionId) === String(positionId))
        );
      });
      const applicationId = application?._id?.toString?.();
      const applicationData = application
        ? {
            id: applicationId,
            _id: applicationId,
            status: application?.status || null,
            createdAt: application?.createdAt || null,
            aiScreeningResult: application?.aiScreeningResult || null,
            aiScreeningAt: application?.aiScreeningAt || null,
            aiScreeningManualTriggered: Boolean(application?.aiScreeningManualTriggered)
          }
        : null;
      return {
        ...rest,
        id,
        contact,
        commentCount: comments.length,
        cv: cv ? { filename: cv.filename, contentType: cv.contentType } : null,
        source: c.source || null,
        applicationId,
        application: applicationData,
        applicationStatus: application?.status || null,
        applicationCreatedAt: application?.createdAt || null
      };
    });
    res.json(sanitized);
  });

  app.post('/recruitment/candidates', authRequired, managerOnly, async (req, res) => {
    await db.read();
    normalizePositionsData(db);
    const { positionId, name, contact, cv } = req.body;
    const status = CANDIDATE_STATUSES.includes(req.body.status) ? req.body.status : 'New';
    if (!positionId) return res.status(400).json({ error: 'Position is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!contact || !contact.trim()) return res.status(400).json({ error: 'Contact is required' });
    if (!cv || !cv.data || !cv.filename) {
      return res.status(400).json({ error: 'CV upload is required' });
    }
    db.data.positions = db.data.positions || [];
    const positionExists = db.data.positions.some(p => p.id == positionId);
    if (!positionExists) {
      return res.status(404).json({ error: 'Position not found' });
    }
    db.data.candidates = db.data.candidates || [];
    const id = Date.now();
    const now = new Date().toISOString();
    const candidate = {
      id,
      positionId: Number(positionId),
      name: name.trim(),
      contact: (contact || '').trim(),
      status,
      source: req.body.source || 'internal',
      cv: {
        filename: cv.filename,
        contentType: cv.contentType || 'application/octet-stream',
        data: cv.data
      },
      comments: [],
      createdAt: now,
      updatedAt: now
    };
    db.data.candidates.push(candidate);
    await db.write();
    const { cv: storedCv, comments = [], ...rest } = candidate;
    res.status(201).json({
      ...rest,
      commentCount: comments.length,
      cv: { filename: storedCv.filename, contentType: storedCv.contentType }
    });
  });

  app.patch('/recruitment/candidates/:id', authRequired, managerOnly, async (req, res) => {
    await db.read();
    db.data.candidates = db.data.candidates || [];
    const candidate = db.data.candidates.find(c => c.id == req.params.id);
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'positionId')) {
      const newPositionId = Number(req.body.positionId);
      if (!newPositionId || Number.isNaN(newPositionId)) {
        return res.status(400).json({ error: 'Valid position is required' });
      }
      db.data.positions = db.data.positions || [];
      const positionExists = db.data.positions.some(p => p.id == newPositionId);
      if (!positionExists) {
        return res.status(404).json({ error: 'Position not found' });
      }
      candidate.positionId = Number(newPositionId);
      updates.positionId = candidate.positionId;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
      const newName = String(req.body.name || '').trim();
      if (!newName) {
        return res.status(400).json({ error: 'Name is required' });
      }
      candidate.name = newName;
      updates.name = candidate.name;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'contact')) {
      const newContact = String(req.body.contact || '').trim();
      if (!newContact) {
        return res.status(400).json({ error: 'Contact is required' });
      }
      candidate.contact = newContact;
      updates.contact = candidate.contact;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
      const nextStatus = String(req.body.status || '');
      if (!CANDIDATE_STATUSES.includes(nextStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      candidate.status = nextStatus;
      updates.status = candidate.status;
    }
    if (req.body.cv && req.body.cv.data && req.body.cv.filename) {
      candidate.cv = {
        filename: req.body.cv.filename,
        contentType: req.body.cv.contentType || 'application/octet-stream',
        data: req.body.cv.data
      };
      updates.cv = candidate.cv;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No changes provided' });
    }
    candidate.updatedAt = new Date().toISOString();
    await db.write();
    const { cv, comments = [], ...rest } = candidate;
    res.json({
      ...rest,
      commentCount: comments.length,
      cv: cv ? { filename: cv.filename, contentType: cv.contentType } : null
    });
  });

  app.delete('/recruitment/candidates/:id', authRequired, managerOnly, async (req, res) => {
    await db.read();
    db.data.candidates = db.data.candidates || [];
    const idx = db.data.candidates.findIndex(c => c.id == req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    db.data.candidates.splice(idx, 1);
    await db.write();
    res.status(204).end();
  });

  app.patch('/recruitment/candidates/:id/status', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const { status } = req.body;
    if (!CANDIDATE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    db.data.candidates = db.data.candidates || [];
    const candidate = db.data.candidates.find(c => c.id == req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    candidate.status = status;
    candidate.updatedAt = new Date().toISOString();
    await db.write();
    const { cv, comments = [], ...rest } = candidate;
    res.json({
      ...rest,
      commentCount: comments.length,
      cv: cv ? { filename: cv.filename, contentType: cv.contentType } : null
    });
  });

  async function streamCandidateCv(req, res) {
    const candidateId = req.params.id;
    await db.read();
    db.data.candidates = db.data.candidates || [];
    const candidate = db.data.candidates.find(c =>
      c.id == candidateId || (c._id && c._id.toString() === candidateId)
    );
    const candidateMongoId = candidate?._id ? candidate._id.toString() : null;
    const candidateLegacyId = candidate?.id ?? null;
    const recruitmentApplications = Array.isArray(db.data.recruitmentApplications)
      ? db.data.recruitmentApplications
      : [];

    const findApplicationDate = app => {
      if (!app) return null;
      if (app.createdAt) {
        const created = new Date(app.createdAt);
        if (!Number.isNaN(created.getTime())) return created;
      }
      if (app._id?.getTimestamp) {
        const ts = app._id.getTimestamp();
        if (ts instanceof Date && !Number.isNaN(ts.getTime())) return ts;
      }
      return null;
    };

    const applications = recruitmentApplications
      .filter(app => {
        if (!app) return false;
        const appCandidateId = app.candidateId?.toString?.() ?? app.candidateId;
        const appLegacyId = app.candidateLegacyId ?? appCandidateId;
        const matchesMongo = candidateMongoId && appCandidateId && appCandidateId.toString() === candidateMongoId;
        const matchesLegacy = candidateLegacyId != null && appLegacyId != null && appLegacyId == candidateLegacyId;
        return matchesMongo || matchesLegacy;
      })
      .sort((a, b) => {
        const aDate = findApplicationDate(a)?.getTime() || 0;
        const bDate = findApplicationDate(b)?.getTime() || 0;
        return bDate - aDate;
      });

    const application = applications[0] || null;
    const cvFilePath = application?.cvFilePath || candidate?.cvFilePath || null;
    const filename = (application?.cvFilename || candidate?.cvFilename || candidate?.cv?.filename || 'cv').replace(/"/g, '');
    const contentType =
      application?.cvContentType ||
      candidate?.cvContentType ||
      candidate?.cv?.contentType ||
      'application/octet-stream';

    const filePath = cvFilePath
      ? cvFilePath.startsWith('/uploads/') || cvFilePath.startsWith('uploads/')
        ? path.join(__dirname, cvFilePath.replace(/^[/\\]+/, ''))
        : path.isAbsolute(cvFilePath)
          ? cvFilePath
          : path.join(__dirname, cvFilePath.replace(/^[/\\]+/, ''))
      : null;
    const hasFile = filePath && fs.existsSync(filePath);

    if (hasFile) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return fs.createReadStream(filePath).pipe(res);
    }

    const cvData = application?.cv?.data || candidate?.cv?.data;
    const inlineContentType = application?.cv?.contentType || contentType;

    if (!candidate || (!cvData && !candidate?.cv?.data)) {
      return res.status(404).json({ error: 'CV not found' });
    }

    if (cvData) {
      const buffer = Buffer.from(cvData, 'base64');
      res.setHeader('Content-Type', inlineContentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }

    return res.status(404).json({ error: 'CV not found' });
  }

  app.get('/recruitment/candidates/:id/cv', authRequired, managerOnly, streamCandidateCv);

  app.get(
    '/api/recruitment/candidates/:id/cv',
    authRequired,
    managerOnly,
    streamCandidateCv
  );

  app.get('/recruitment/candidates/search', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const term = (req.query.q || '').toString().trim();
    if (!term) {
      return res.json([]);
    }
    const query = term.toLowerCase();
    db.data.candidates = db.data.candidates || [];
    db.data.positions = db.data.positions || [];
    const positionMap = new Map(db.data.positions.map(pos => [String(pos.id), pos.title]));
    const matches = db.data.candidates
      .filter(candidate => {
        const name = (candidate.name || '').toString().toLowerCase();
        const contact = (candidate.contact || '').toString().toLowerCase();
        return name.includes(query) || contact.includes(query);
      })
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 20)
      .map(candidate => {
        const cv = buildCandidateCvSummary(candidate);
        const id = resolveCandidateId(candidate);
        const contact = candidate.contact || candidate.email || candidate.phone || '';
        return {
          id,
          name: candidate.name,
          contact,
          status: candidate.status,
          positionId: candidate.positionId,
          positionTitle: positionMap.get(String(candidate.positionId)) || null,
          createdAt: candidate.createdAt,
          updatedAt: candidate.updatedAt,
          hasCv: Boolean(cv),
          cvFilename: cv?.filename || null,
          cvContentType: cv?.contentType || null,
          source: candidate.source || null
        };
      });
    res.json(matches);
  });

  app.get('/recruitment/candidates/:id/comments', authRequired, managerOnly, async (req, res) => {
    await db.read();
    db.data.candidates = db.data.candidates || [];
    const candidate = db.data.candidates.find(c => c.id == req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    candidate.comments = candidate.comments || [];
    const comments = candidate.comments.map(comment => sanitizeComment(comment, req.user));
    res.json(comments);
  });

  app.post('/recruitment/candidates/:id/comments', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const text = (req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Comment text is required' });
    }
    db.data.candidates = db.data.candidates || [];
    const candidate = db.data.candidates.find(c => c.id == req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    candidate.comments = candidate.comments || [];
    const now = new Date().toISOString();
    const comment = {
      id: generateCommentId(),
      text,
      userId: req.user.id,
      userEmail: req.user.email,
      createdAt: now,
      updatedAt: now
    };
    candidate.comments.push(comment);
    candidate.updatedAt = now;
    await db.write();
    res.status(201).json({
      comment: sanitizeComment(comment, req.user),
      commentCount: candidate.comments.length
    });
  });

  app.patch('/recruitment/candidates/:candidateId/comments/:commentId', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const text = (req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Comment text is required' });
    }
    db.data.candidates = db.data.candidates || [];
    const candidate = db.data.candidates.find(c => c.id == req.params.candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    candidate.comments = candidate.comments || [];
    const comment = candidate.comments.find(c => c.id == req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.userId !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own comments' });
    }
    comment.text = text;
    comment.updatedAt = new Date().toISOString();
    candidate.updatedAt = comment.updatedAt;
    await db.write();
    res.json({
      comment: sanitizeComment(comment, req.user),
      commentCount: candidate.comments.length
    });
  });

  // ========== APPLICATIONS ==========
  app.get('/applications', authRequired, async (req, res) => {
    await db.read();
    let apps = db.data.applications || [];
    if (!isManagerRole(req.user.role)) {
      apps = apps.filter(a => a.employeeId == req.user.employeeId);
    } else {
      if (req.query.employeeId) {
        apps = apps.filter(a => a.employeeId == req.query.employeeId);
      }
      if (req.query.status) {
        apps = apps.filter(a => a.status === req.query.status);
      }
    }
    res.json(apps);
  });

  // ---- BULK LEAVE IMPORT ----
  app.post(
    '/applications/bulk-import',
    authRequired,
    managerOnly,
    express.text({ type: '*/*' }),
    async (req, res) => {
      await db.read();
      db.data.applications = db.data.applications || [];
      db.data.employees = db.data.employees || [];

      const rawCsv = (req.body || '').trim();
      if (!rawCsv) {
        return res.status(400).json({ error: 'CSV file is empty.' });
      }

      try {
        const rows = parse(rawCsv, {
          columns: true,
          skip_empty_lines: true,
          trim: true
        });

        if (!Array.isArray(rows) || !rows.length) {
          return res.status(400).json({ error: 'No rows found in CSV file.' });
        }

        const normalizeKey = key =>
          key
            .toString()
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        function getColumnValue(row, candidates) {
          const entries = Object.entries(row || {});
          for (const candidate of candidates) {
            const normalizedCandidate = normalizeKey(candidate);
            for (const [key, value] of entries) {
              const normalizedKey = normalizeKey(key);
              if (
                normalizedKey === normalizedCandidate ||
                normalizedKey.includes(normalizedCandidate)
              ) {
                return typeof value === 'string' ? value.trim() : value;
              }
            }
          }
          return undefined;
        }

        function normalizeType(value) {
          if (!value) return null;
          const cleaned = value.toString().trim().toLowerCase();
          const map = {
            annual: 'annual',
            casual: 'casual',
            medical: 'medical',
            sick: 'medical',
            sickleave: 'medical',
            medicalleave: 'medical',
            annualleave: 'annual',
            casualleave: 'casual'
          };
          const normalized = cleaned.replace(/\s+/g, '');
          if (map[cleaned]) return map[cleaned];
          if (map[normalized]) return map[normalized];
          return ['annual', 'casual', 'medical'].find(type =>
            normalized.includes(type)
          );
        }

        function normalizeDate(value) {
          if (!value) return null;

          const toIso = (year, month, day) => {
            if (
              !Number.isInteger(year) ||
              !Number.isInteger(month) ||
              !Number.isInteger(day)
            ) {
              return null;
            }
            const date = new Date(Date.UTC(year, month - 1, day));
            if (
              date.getUTCFullYear() !== year ||
              date.getUTCMonth() !== month - 1 ||
              date.getUTCDate() !== day
            ) {
              return null;
            }
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          };

          if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return toIso(
              value.getUTCFullYear(),
              value.getUTCMonth() + 1,
              value.getUTCDate()
            );
          }

          const str = value.toString().trim();
          if (!str) return null;

          const isoMatch = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
          if (isoMatch) {
            const year = Number(isoMatch[1]);
            const month = Number(isoMatch[2]);
            const day = Number(isoMatch[3]);
            return toIso(year, month, day);
          }

          const altMatch = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
          if (altMatch) {
            let month = Number(altMatch[1]);
            let day = Number(altMatch[2]);
            let year = Number(altMatch[3]);
            if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) {
              return null;
            }
            if (year < 100) {
              year += 2000;
            }
            if (month > 12 && day <= 12) {
              [month, day] = [day, month];
            }
            return toIso(year, month, day);
          }

          const parsed = new Date(str);
          if (Number.isNaN(parsed.getTime())) return null;
          return toIso(
            parsed.getUTCFullYear(),
            parsed.getUTCMonth() + 1,
            parsed.getUTCDate()
          );
        }

        const employeesByName = new Map();
        db.data.employees.forEach(emp => {
          const name = (emp.name || '').toString().trim().toLowerCase();
          if (name && !employeesByName.has(name)) {
            employeesByName.set(name, emp);
          }
        });

        const existingKeys = new Set(
          db.data.applications
            .filter(app => app && app.employeeId && app.from && app.to && app.type)
            .map(
              app =>
                `${app.employeeId}__${app.from}__${app.to}__${String(app.type).toLowerCase()}`
            )
        );

        const now = Date.now();
        let added = 0;
        let skipped = 0;
        const errors = [];

        rows.forEach((row, index) => {
          const nameValue = getColumnValue(row, ['name', 'employee name']);
          const dateValue = getColumnValue(row, ['date', 'leave date']);
          const typeValue = getColumnValue(row, ['type', 'leave type', 'type name']);
          const reasonValue =
            getColumnValue(row, ['reason', 'remarks', 'remark']) || 'Imported via CSV upload';

          if (!nameValue || !dateValue || !typeValue) {
            skipped += 1;
            errors.push(
              `Row ${index + 1}: Missing ${
                !nameValue ? 'name' : !dateValue ? 'date' : 'type'
              }.`
            );
            return;
          }

          const employee = employeesByName.get(nameValue.toLowerCase());
          if (!employee) {
            skipped += 1;
            errors.push(`Row ${index + 1}: Employee "${nameValue}" not found.`);
            return;
          }

          const normalizedType = normalizeType(typeValue);
          if (!normalizedType) {
            skipped += 1;
            errors.push(`Row ${index + 1}: Unsupported leave type "${typeValue}".`);
            return;
          }

          const isoDate = normalizeDate(dateValue);
          if (!isoDate) {
            skipped += 1;
            errors.push(`Row ${index + 1}: Invalid date "${dateValue}".`);
            return;
          }

          const key = `${employee.id}__${isoDate}__${isoDate}__${normalizedType}`;
          if (existingKeys.has(key)) {
            skipped += 1;
            errors.push(
              `Row ${index + 1}: Duplicate leave entry for ${nameValue} on ${isoDate}.`
            );
            return;
          }

          const record = {
            id: now + index,
            employeeId: employee.id,
            type: normalizedType,
            from: isoDate,
            to: isoDate,
            reason: reasonValue,
            status: 'approved',
            approvedBy: req.user?.email || 'CSV Import',
            approvedAt: new Date().toISOString(),
            approverRemark: 'Imported via CSV upload',
            source: 'csv-import',
            skipBalanceDeduction: true
          };

          db.data.applications.push(record);
          existingKeys.add(key);
          added += 1;
        });

        if (added) {
          await db.write();
        }

        return res
          .status(added ? 201 : 200)
          .json({ added, skipped, errors });
      } catch (err) {
        console.error('Leave CSV import failed', err);
        return res.status(400).json({ error: 'Invalid CSV file.' });
      }
    }
  );

  // ---- EMAIL SETTINGS ----
  app.get('/settings/email', authRequired, managerOnly, async (req, res) => {
    try {
      const config = await loadEmailSettings({ force: true });
      const {
        pass,
        oauthClientSecret,
        oauthRefreshToken,
        ...rest
      } = config;
      await db.read();
      const recipientOptions = buildRecipientOptions(db.data, rest.recipients);
      res.json({
        ...rest,
        hasPassword: Boolean(pass),
        hasClientSecret: Boolean(oauthClientSecret),
        hasRefreshToken: Boolean(oauthRefreshToken),
        recipientOptions
      });
    } catch (err) {
      console.error('Failed to load email settings', err);
      res.status(500).json({ error: 'Unable to load email settings.' });
    }
  });

  app.put('/settings/email', authRequired, managerOnly, async (req, res) => {
    try {
      const payload = req.body || {};
      const providerRaw = typeof payload.provider === 'string' ? payload.provider.trim().toLowerCase() : 'custom';
      const provider = providerRaw === 'office365' ? 'office365' : 'custom';
      let host = typeof payload.host === 'string' ? payload.host.trim() : '';
      let secure = payload.secure === true || payload.secure === 'true';
      let port = Number(payload.port);
      const enabled = payload.enabled !== false;
      const authTypeRaw = typeof payload.authType === 'string' ? payload.authType.trim().toLowerCase() : 'basic';
      let authType = authTypeRaw === 'oauth2' ? 'oauth2' : 'basic';
      if (provider === 'office365') {
        host = 'smtp.office365.com';
        port = 587;
        secure = false;
      }
      if (!Number.isFinite(port) || port <= 0) {
        port = secure ? 465 : 587;
      }
      if (enabled && !host) {
        return res.status(400).json({ error: 'SMTP host is required when email notifications are enabled.' });
      }
      const user = typeof payload.user === 'string' ? payload.user.trim() : '';
      const from = typeof payload.from === 'string' ? payload.from.trim() : '';
      const replyTo = typeof payload.replyTo === 'string' ? payload.replyTo.trim() : '';
      const oauthTenant = typeof payload.oauthTenant === 'string' ? payload.oauthTenant.trim() : '';
      const oauthClientId = typeof payload.oauthClientId === 'string' ? payload.oauthClientId.trim() : '';
      const oauthScope = typeof payload.oauthScope === 'string' ? payload.oauthScope.trim() : '';
      const updateClientSecret = payload.updateClientSecret === true;
      const oauthClientSecret = typeof payload.oauthClientSecret === 'string' ? payload.oauthClientSecret : '';
      const updateRefreshToken = payload.updateRefreshToken === true;
      const oauthRefreshToken = typeof payload.oauthRefreshToken === 'string' ? payload.oauthRefreshToken : '';
      const oauthGrantTypeRaw = typeof payload.oauthGrantType === 'string'
        ? payload.oauthGrantType.trim().toLowerCase()
        : '';
      const oauthGrantType = oauthGrantTypeRaw === 'refresh_token' ? 'refresh_token' : 'client_credentials';
      const templates = normalizeEmailTemplates(payload.templates);
      const recipientsRaw = Array.isArray(payload.recipients)
        ? payload.recipients
        : typeof payload.recipients === 'string'
          ? payload.recipients.split(/[,;]+/)
          : [];
      const recipientMap = new Map();
      recipientsRaw.forEach(value => {
        if (value === undefined || value === null) return;
        const trimmed = typeof value === 'string' ? value.trim() : String(value || '').trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        if (!recipientMap.has(lower)) {
          recipientMap.set(lower, trimmed);
        }
      });
      const recipients = Array.from(recipientMap.values());
      const updatePassword = payload.updatePassword === true;
      const incomingPassword = typeof payload.password === 'string' ? payload.password : '';

      await db.read();
      db.data.settings = db.data.settings && typeof db.data.settings === 'object' ? db.data.settings : {};
      const existing = db.data.settings.email && typeof db.data.settings.email === 'object'
        ? db.data.settings.email
        : {};
      let pass = existing.pass || '';
      if (updatePassword) {
        pass = incomingPassword;
      }
      let storedClientSecret = existing.oauthClientSecret || '';
      if (updateClientSecret) {
        storedClientSecret = oauthClientSecret;
      }
      let storedRefreshToken = existing.oauthRefreshToken || '';
      if (updateRefreshToken) {
        storedRefreshToken = oauthRefreshToken;
      }

      const storedConfig = {
        enabled: Boolean(enabled && host),
        provider,
        host,
        port,
        secure: Boolean(secure),
        user,
        pass,
        from: from || user,
        replyTo,
        recipients,
        authType,
        oauthTenant,
        oauthClientId,
        oauthClientSecret: storedClientSecret,
        oauthScope,
        oauthRefreshToken: storedRefreshToken,
        oauthGrantType,
        templates
      };

      db.data.settings.email = storedConfig;
      await db.write();

      const normalized = normalizeEmailSettings(storedConfig);
      emailSettingsCache = { config: normalized, loadedAt: Date.now() };
      emailTransporterCache = { transporter: null, signature: null };

      const {
        pass: _pass,
        oauthClientSecret: _secret,
        oauthRefreshToken: _refresh,
        ...safe
      } = normalized;
      const recipientOptions = buildRecipientOptions(db.data, safe.recipients);
      res.json({
        ...safe,
        hasPassword: Boolean(storedConfig.pass),
        hasClientSecret: Boolean(storedClientSecret),
        hasRefreshToken: Boolean(storedRefreshToken),
        recipientOptions
      });
    } catch (err) {
      console.error('Failed to save email settings', err);
      res.status(500).json({ error: 'Unable to save email settings.' });
    }
  });

  // ---- AI SETTINGS ----
  app.get('/settings/ai', authRequired, managerOnly, async (req, res) => {
    try {
      const settings = await loadAiSettings({ force: true });
      res.json({
        settings,
        defaults: DEFAULT_AI_SETTINGS,
        modelOptions: getAiModelOptions()
      });
    } catch (err) {
      console.error('Failed to load AI settings', err);
      res.status(500).json({ error: 'Unable to load AI settings.' });
    }
  });

  app.put('/settings/ai', authRequired, managerOnly, async (req, res) => {
    try {
      const payload = req.body || {};
      const allowedModels = new Set(getAiModelOptions().map(option => option.value));
      const model = typeof payload.model === 'string' && allowedModels.has(payload.model)
        ? payload.model
        : DEFAULT_AI_SETTINGS.model;
      const questionPrompt = typeof payload.questionPrompt === 'string' ? payload.questionPrompt : undefined;
      const screeningPrompt = typeof payload.screeningPrompt === 'string' ? payload.screeningPrompt : undefined;

      const saved = await saveAiSettings({ model, questionPrompt, screeningPrompt });
      res.json({ settings: saved, modelOptions: getAiModelOptions() });
    } catch (err) {
      console.error('Failed to save AI settings', err);
      res.status(500).json({ error: 'Unable to save AI settings.' });
    }
  });

  // ---- HOLIDAY CONFIGURATION ----
  app.get('/holidays', authRequired, async (req, res) => {
    await db.read();
    const holidays = Array.isArray(db.data.holidays) ? db.data.holidays : [];
    const sorted = [...holidays].sort((a, b) => a.date.localeCompare(b.date));
    res.json(sorted);
  });

  app.post('/holidays', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const dateValue = typeof req.body?.date === 'string' ? req.body.date.trim() : '';
    const nameValue = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!dateValue) {
      return res.status(400).json({ error: 'Holiday date is required.' });
    }
    if (!nameValue) {
      return res.status(400).json({ error: 'Holiday name is required.' });
    }

    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'Invalid holiday date.' });
    }
    const isoDate = parsed.toISOString().split('T')[0];

    db.data.holidays = Array.isArray(db.data.holidays) ? db.data.holidays : [];
    if (db.data.holidays.some(h => h.date === isoDate)) {
      return res.status(400).json({ error: 'A holiday already exists on this date.' });
    }

    const holiday = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      date: isoDate,
      name: nameValue
    };
    db.data.holidays.push(holiday);
    await db.write();
    res.status(201).json(holiday);
  });

  app.delete('/holidays/:id', authRequired, managerOnly, async (req, res) => {
    await db.read();
    db.data.holidays = Array.isArray(db.data.holidays) ? db.data.holidays : [];
    const index = db.data.holidays.findIndex(h => h.id === req.params.id);
    if (index < 0) {
      return res.status(404).json({ error: 'Holiday not found.' });
    }
    db.data.holidays.splice(index, 1);
    await db.write();
    res.json({ success: true });
  });

  // ---- LEAVE REPORT ----
  app.get('/leave-report', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const { start, end } = req.query;
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    const emps = db.data.employees || [];
    const apps = db.data.applications || [];

    const report = emps.map(emp => {
      let empApps = apps.filter(a => a.employeeId == emp.id && a.status === 'approved');
      if (startDate || endDate) {
        empApps = empApps.filter(a => {
          const from = new Date(a.from);
          const to = new Date(a.to);
          if (startDate && to < startDate) return false;
          if (endDate && from > endDate) return false;
          return true;
        });
      }
      const totals = {};
      let totalDays = 0;
      empApps.forEach(a => {
        const days = startDate || endDate ? getLeaveDaysInRange(a, startDate, endDate) : getLeaveDays(a);
        if (days <= 0) return;
        totals[a.type] = (totals[a.type] || 0) + days;
        totalDays += days;
      });
      return {
        id: emp.id,
        name: emp.name || '',
        title: emp.Title || emp.title || '',
        location: emp['Country / City'] || emp.location || emp['country/city'] || '',
        totalDays,
        leaves: totals
      };
    }).filter(r => r.totalDays > 0);

    report.sort((a, b) => b.totalDays - a.totalDays);
    res.json(report);
  });

  // ---- LEAVE REPORT CSV EXPORT ----
  app.get('/leave-report/export', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const emps = db.data.employees || [];
    const apps = (db.data.applications || []).filter(a => a.status === 'approved');

    function escapeCsv(value) {
      if (!value) return '';
      const str = String(value);
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    }

    const rows = [];
    for (const app of apps) {
      const emp = emps.find(e => e.id == app.employeeId) || {};
      const name = emp.name || '';
      const start = new Date(app.from);
      const end = new Date(app.to);
      if (app.halfDay) {
        const dateStr = start.toISOString().split('T')[0];
        const period = app.halfDayType || app.halfDayPeriod || '';
        const type = `${app.type} (Half Day${period ? ' ' + period : ''})`;
        rows.push({ name, date: dateStr, type });
      } else {
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          rows.push({ name, date: dateStr, type: app.type });
        }
      }
    }

    const csv = ['Name,Date,Type']
      .concat(rows.map(r => `${escapeCsv(r.name)},${escapeCsv(r.date)},${escapeCsv(r.type)}`))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leave-report.csv"');
    res.send(csv);
  });

  // ---- LEAVE CALENDAR DATA ----
  app.get('/leave-calendar', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const { start, end } = req.query;
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    const emps = db.data.employees || [];
    const apps = (db.data.applications || []).filter(a => a.status === 'approved');
    const map = {};
    for (const app of apps) {
      const emp = emps.find(e => e.id == app.employeeId) || {};
      const name = emp.name || '';
      const startD = new Date(app.from);
      const endD = new Date(app.to);
      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        if (startDate && d < startDate) continue;
        if (endDate && d > endDate) continue;
        const dateStr = d.toISOString().split('T')[0];
        if (!map[dateStr]) map[dateStr] = [];
        map[dateStr].push({ name, type: app.type });
      }
    }
    const result = Object.entries(map).map(([date, entries]) => ({ date, entries }));
    res.json(result);
  });

  // ========== LEAVE LOGIC ==========

  // Helper: Holiday lookup
  function getHolidaySet() {
    const holidays = Array.isArray(db.data?.holidays) ? db.data.holidays : [];
    return new Set(holidays.map(h => h.date));
  }

  // Helper: Get leave days (with half day support)
  function getLeaveDays(app) {
    const from = new Date(app.from);
    const to = new Date(app.to);
    const holidaySet = getHolidaySet();
    if (app.halfDay) {
      const day = from.getDay();
      const iso = from.toISOString().split('T')[0];
      return day === 0 || day === 6 || holidaySet.has(iso) ? 0 : 0.5;
    }
    let days = 0;
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      const iso = d.toISOString().split('T')[0];
      if (day !== 0 && day !== 6 && !holidaySet.has(iso)) days++;
    }
    return days;
  }

  function getLeaveDaysInRange(app, startDate, endDate) {
    if (!startDate && !endDate) return getLeaveDays(app);
    const from = new Date(app.from);
    const to = new Date(app.to);
    const holidaySet = getHolidaySet();
    const start = startDate && from < startDate ? new Date(startDate) : from;
    const end = endDate && to > endDate ? new Date(endDate) : to;
    if (app.halfDay) {
      if (startDate && from < startDate) return 0;
      if (endDate && from > endDate) return 0;
      const day = from.getDay();
      const iso = from.toISOString().split('T')[0];
      return day === 0 || day === 6 || holidaySet.has(iso) ? 0 : 0.5;
    }
    if (end < start) return 0;
    let days = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      const iso = d.toISOString().split('T')[0];
      if (day !== 0 && day !== 6 && !holidaySet.has(iso)) days++;
    }
    return days;
  }

  function normalizeEmployeeId(value) {
    if (value === undefined || value === null) return null;
    const normalized = typeof value === 'string' ? value : String(value);
    const trimmed = normalized.trim();
    return trimmed ? trimmed : null;
  }

  function normalizePayrollMonth(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    if (!str) return null;
    const match = str.match(/^\s*(\d{4})-(\d{1,2})\s*$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isFinite(year) || year < 1900 || year > 9999) {
      return null;
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      return null;
    }
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  }

  function isWorkingDay(date) {
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }

  function countWorkingDaysInRange(startDate, endDate) {
    if (!startDate || !endDate) return 0;
    let count = 0;
    const current = new Date(startDate.getTime());

    while (current <= endDate) {
      if (isWorkingDay(current)) count += 1;
      current.setDate(current.getDate() + 1);
    }

    return count;
  }

  function getWorkingDaysInMonth(year, month /* 1-12 */) {
    const first = new Date(year, month - 1, 1);
    const last = new Date(year, month, 0);
    return countWorkingDaysInRange(first, last);
  }

  const MONTH_LOOKUP = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    sept: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };

  function parseEmployeeDate(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

    const str = String(value).trim();
    if (!str) return null;
    const lowered = str.toLowerCase();
    if (['current', 'present', 'n/a', 'na', 'yes', 'no'].includes(lowered)) return null;

    const dashMatch = str.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
    if (dashMatch) {
      const day = Number(dashMatch[1]);
      const monthKey = dashMatch[2].slice(0, 3).toLowerCase();
      const monthIndex = MONTH_LOOKUP[monthKey];
      const rawYear = Number(dashMatch[3]);
      const year = rawYear < 100 ? 2000 + rawYear : rawYear;
      if (Number.isInteger(day) && Number.isInteger(monthIndex) && Number.isInteger(year)) {
        const parsed = new Date(year, monthIndex, day);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
    }

    const parsed = new Date(str);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function getEmployeeDateValue(employee, keys = []) {
    if (!employee || typeof employee !== 'object') return null;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(employee, key)) {
        const parsed = parseEmployeeDate(employee[key]);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  function buildEmployeeDateContext(employee) {
    const internshipStart = getEmployeeDateValue(employee, ['Start Date - Internship or Probation']);
    const internshipEndDate = getEmployeeDateValue(employee, ['End Date - Internship or Probation']);
    const fullTimeStartDate = getEmployeeDateValue(employee, ['Start Date - Full Time']);
    const fullTimeEndDate = getEmployeeDateValue(employee, ['End Date - Full Time']);

    const startDate = internshipStart || fullTimeStartDate || null;
    const endDate = fullTimeEndDate || (!fullTimeStartDate && internshipEndDate ? internshipEndDate : null);

    return {
      startDate,
      endDate,
      internshipEndDate,
      fullTimeStartDate
    };
  }

  function calculateMonthlyPayForEmployee(employee, payrollYear, payrollMonth) {
    const workingDaysInMonth = getWorkingDaysInMonth(payrollYear, payrollMonth);
    if (!workingDaysInMonth) return 0;

    const monthStart = new Date(payrollYear, payrollMonth - 1, 1);
    const monthEnd = new Date(payrollYear, payrollMonth, 0);

    const employeeStart = employee.startDate ? new Date(employee.startDate) : null;
    const employeeEnd = employee.endDate ? new Date(employee.endDate) : null;

    const activeStart = employeeStart && employeeStart > monthStart ? employeeStart : monthStart;
    const activeEnd = employeeEnd && employeeEnd < monthEnd ? employeeEnd : monthEnd;

    if (activeStart > activeEnd) return 0;

    const internshipEndDate = employee.internshipEndDate ? new Date(employee.internshipEndDate) : null;
    const fullTimeStartDate = employee.fullTimeStartDate ? new Date(employee.fullTimeStartDate) : null;

    const hasInternshipSplitThisMonth =
      internshipEndDate &&
      fullTimeStartDate &&
      internshipEndDate <= monthEnd &&
      internshipEndDate >= monthStart &&
      fullTimeStartDate <= monthEnd &&
      fullTimeStartDate >= monthStart;

    if (hasInternshipSplitThisMonth) {
      const internSegmentStart = activeStart;
      const internSegmentEnd = internshipEndDate < activeEnd ? internshipEndDate : activeEnd;

      const fullSegmentStart = fullTimeStartDate > activeStart ? fullTimeStartDate : activeStart;
      const fullSegmentEnd = activeEnd;

      let totalPay = 0;

      if (internSegmentStart <= internSegmentEnd) {
        const internWorkingDays = countWorkingDaysInRange(internSegmentStart, internSegmentEnd);
        const internMonthlySalary =
          typeof employee.internshipMonthlySalary === 'number'
          && Number.isFinite(employee.internshipMonthlySalary)
            ? employee.internshipMonthlySalary
            : 300000;
        const internDailyRate = internMonthlySalary / workingDaysInMonth;
        totalPay += internDailyRate * internWorkingDays;
      }

      if (fullSegmentStart <= fullSegmentEnd) {
        const fullWorkingDays = countWorkingDaysInRange(fullSegmentStart, fullSegmentEnd);
        const fullMonthlySalary = Number.isFinite(employee.monthlySalary) ? employee.monthlySalary : 0;
        const fullDailyRate = fullMonthlySalary / workingDaysInMonth;
        totalPay += fullDailyRate * fullWorkingDays;
      }

      return Math.round(totalPay);
    }

    const isFullTimeThisMonth = fullTimeStartDate && fullTimeStartDate <= activeEnd;
    const monthlySalaryToUse = isFullTimeThisMonth
      ? Number.isFinite(employee.monthlySalary) ? employee.monthlySalary : 0
      : (Number.isFinite(employee.internshipMonthlySalary) ? employee.internshipMonthlySalary : 300000);

    const segmentWorkingDays = countWorkingDaysInRange(activeStart, activeEnd);
    const dailyRate = monthlySalaryToUse / workingDaysInMonth;
    const pay = dailyRate * segmentWorkingDays;

    return Math.round(pay);
  }

  function currentPayrollMonth() {
    const now = new Date();
    return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Quick sanity checks (not executed automatically):
  // - calculateMonthlyPayForEmployee({ startDate: new Date(2024, 4, 15), monthlySalary: 1000000 }, 2024, 5);
  // - calculateMonthlyPayForEmployee({ startDate: new Date(2024, 4, 1), endDate: new Date(2024, 4, 20), monthlySalary: 1000000 }, 2024, 5);
  // - calculateMonthlyPayForEmployee({ startDate: new Date(2024, 4, 1), internshipEndDate: new Date(2024, 4, 15), fullTimeStartDate: new Date(2024, 4, 16), monthlySalary: 1200000 }, 2024, 5);
  // - calculateMonthlyPayForEmployee({ startDate: new Date(2024, 4, 1), internshipEndDate: new Date(2024, 3, 30), fullTimeStartDate: new Date(2024, 4, 1), monthlySalary: 1200000 }, 2024, 5);

  function resolvePayrollYearMonth(monthValue) {
    const normalized = normalizePayrollMonth(monthValue);
    if (!normalized) return null;
    const [yearStr, monthStr] = normalized.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
    return { year, month };
  }

  function pickSalaryRecord(records = [], targetMonth = null) {
    if (!Array.isArray(records) || !records.length) return null;
    const normalizedTarget = normalizePayrollMonth(targetMonth);
    const sorted = [...records].sort((a, b) => {
      const aTime = a?.updatedAt ? Date.parse(a.updatedAt) : -Infinity;
      const bTime = b?.updatedAt ? Date.parse(b.updatedAt) : -Infinity;
      return bTime - aTime;
    });
    if (normalizedTarget) {
      const match = sorted.find(entry => normalizePayrollMonth(entry.month) === normalizedTarget);
      if (match) return match;
    }
    return sorted[0];
  }

  function buildPayrollSummaryEntry(rawEmployee, employeeSummary, salaryRecord, payrollMonthValue) {
    const payrollDate = resolvePayrollYearMonth(payrollMonthValue) || {};
    const { year: payrollYear, month: payrollMonthNumber } = payrollDate;
    const dateContext = buildEmployeeDateContext(rawEmployee || {});

    const grossPay = payrollYear && payrollMonthNumber
      ? calculateMonthlyPayForEmployee(
          {
            ...dateContext,
            monthlySalary: Number.isFinite(salaryRecord?.amount) ? salaryRecord.amount : 0,
            internshipMonthlySalary: rawEmployee?.internshipMonthlySalary
          },
          payrollYear,
          payrollMonthNumber
        )
      : 0;

    return {
      employeeId: employeeSummary.employeeId,
      name: employeeSummary.name || '',
      month: payrollMonthValue,
      salary: salaryRecord || null,
      grossPay,
      bankAccountName: employeeSummary.bankAccountName || '',
      bankAccountNumber: employeeSummary.bankAccountNumber || ''
    };
  }

  function resolveEmployeeScope(req, providedId) {
    const requestedId = normalizeEmployeeId(providedId);
    const currentUserId = normalizeEmployeeId(req.user?.employeeId);
    const employeeId = requestedId || currentUserId;

    if (!employeeId) {
      return { status: 400, error: 'Employee ID is required.' };
    }

    const currentRole = req.user?.role;
    if (req.user && !isManagerRole(currentRole) && employeeId !== currentUserId) {
      return {
        status: 403,
        error: 'Cannot access leave information for another employee.'
      };
    }

    return { employeeId };
  }

  async function resolveManagerAccess(employeeId) {
    const normalizedId = normalizeEmployeeId(employeeId);
    if (!normalizedId) {
      return { status: 400, error: 'employeeId query parameter is required.' };
    }

    await db.read();

    const employees = Array.isArray(db.data?.employees) ? db.data.employees : [];
    const users = Array.isArray(db.data?.users) ? db.data.users : [];

    const employee = employees.find(emp => normalizeEmployeeId(emp?.id) === normalizedId) || null;
    const user = users.find(u => normalizeEmployeeId(u?.employeeId) === normalizedId) || null;

    const role = normalizeRole(user?.role || getEmpRole(employee));
    if (!isManagerRole(role)) {
      return { status: 403, error: 'Manager access required.' };
    }

    if (!isEmployeeActive(employee)) {
      return { status: 403, error: 'Employee account is inactive.' };
    }

    return { employeeId: normalizedId, employee, user, employees, users };
  }

  function isLeaveInRange(app, rangeStart, rangeEnd) {
    if (!app) return false;
    const start = rangeStart ? new Date(rangeStart) : null;
    const end = rangeEnd ? new Date(rangeEnd) : null;
    const from = new Date(app.from);
    const to = new Date(app.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return false;
    }
    if (start && to < start) return false;
    if (end && from > end) return false;
    return true;
  }

  function buildLeaveWindowEntry(app, employeesById) {
    const summary = toLeaveApplicationSummary(app);
    const employee = employeesById.get(String(summary.employeeId)) || null;
    return {
      ...summary,
      employeeName: employee?.name || null,
      title: findValueByKeywords(employee, ['title', 'position']) || null,
      project: findValueByKeywords(employee, ['project', 'department']) || null
    };
  }

  function toLeaveApplicationSummary(app) {
    const summary = {
      id: app.id,
      employeeId: normalizeEmployeeId(app.employeeId) || app.employeeId,
      type: app.type,
      from: app.from,
      to: app.to,
      status: app.status,
      reason: app.reason || '',
      halfDay: Boolean(app.halfDay),
      halfDayType: app.halfDayType || null,
      days: getLeaveDays(app),
      allowNegativeBalance: Boolean(app.allowNegativeBalance)
    };

    if (app.approvedBy) summary.approvedBy = app.approvedBy;
    if (app.approverRemark) summary.approverRemark = app.approverRemark;
    if (app.approvedAt) summary.approvedAt = app.approvedAt;
    if (app.cancelledAt) summary.cancelledAt = app.cancelledAt;

    return summary;
  }

  async function createLeaveApplication(payload, currentUser) {
    const {
      employeeId,
      type,
      from,
      to,
      reason,
      halfDay,
      halfDayType
    } = payload || {};

    await db.read();
    db.data.applications = Array.isArray(db.data.applications)
      ? db.data.applications
      : [];
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    db.data.users = Array.isArray(db.data.users) ? db.data.users : [];

    if (!employeeId) {
      return { status: 400, error: 'Employee ID is required.' };
    }

    if (
      currentUser &&
      !isManagerRole(currentUser.role) &&
      currentUser.employeeId != employeeId
    ) {
      return { status: 403, error: 'Cannot apply for another employee' };
    }

    const supportedTypes = SUPPORTED_LEAVE_TYPES;
    const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
    if (!supportedTypes.includes(normalizedType)) {
      return { status: 400, error: 'Unsupported leave type.' };
    }

    if (!from || !to) {
      return { status: 400, error: 'Start and end dates are required.' };
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return { status: 400, error: 'Invalid date format.' };
    }

    if (toDate < fromDate) {
      return { status: 400, error: 'End date cannot be before start date.' };
    }

    const employees = db.data.employees;
    const employee = employees.find(e => e.id == employeeId);
    const status = (employee?.status || '').toString().toLowerCase();
    if (!employee || ['inactive', 'deactivated', 'disabled'].includes(status)) {
      return { status: 403, error: 'Employee account is inactive' };
    }

    const { raw: leaveBalances } = await getComputedLeaveBalances(employee, {
      dateNow: new Date(),
      applications: db.data.applications,
      holidays: db.data.holidays
    });

    const normalizedFrom =
      typeof from === 'string' ? from.trim() : fromDate.toISOString();
    const normalizedTo = typeof to === 'string' ? to.trim() : toDate.toISOString();

    const allowsNegativeBalance = isManagerRole(currentUser?.role);

    const newApp = {
      id: Date.now(),
      employeeId,
      type: normalizedType,
      from: normalizedFrom,
      to: normalizedTo,
      reason: reason || '',
      status: 'pending',
      allowNegativeBalance: allowsNegativeBalance
    };

    if (halfDay) {
      newApp.halfDay = true;
      if (halfDayType) {
        newApp.halfDayType = halfDayType;
      }
    }

    const days = getLeaveDays(newApp);
    const balance = leaveBalances?.[normalizedType]?.balance || 0;
    const validationError = validateLeaveBalance(balance, normalizedType, days, {
      allowNegativeBalance: allowsNegativeBalance
    });
    if (validationError) {
      return { status: 400, error: validationError };
    }

    db.data.applications.push(newApp);
    await db.write();

    const emailConfig = await loadEmailSettings();
    const recipientSet = new Set();
    const addRecipients = list => {
      (list || []).forEach(value => {
        if (!value) return;
        const email = typeof value === 'string' ? value : value?.email;
        if (!email) return;
        const normalized = email.toString().trim().toLowerCase();
        if (normalized) {
          recipientSet.add(normalized);
        }
      });
    };

    const managerRecipients = resolveEmployeeManagers(employee, db.data);
    addRecipients(managerRecipients.map(manager => manager?.email));
    addRecipients(emailConfig?.recipients);

    if (!recipientSet.size) {
      const managers = db.data.users.filter(u => isManagerRole(u?.role));
      addRecipients(managers.map(m => m.email));
    }

    const empEmail = getEmpEmail(employee);
    const name = employee?.name || empEmail || `Employee ${employeeId}`;

    if (!recipientSet.size && ADMIN_EMAIL) {
      recipientSet.add(ADMIN_EMAIL.toLowerCase());
    }

    const recipientEmails = Array.from(recipientSet.values());
    if (recipientEmails.length) {
      const templates = emailConfig?.templates || DEFAULT_LEAVE_EMAIL_TEMPLATES;
      const templateVars = {
        name,
        type: normalizedType,
        from: normalizedFrom,
        to: normalizedTo
      };
      await sendEmail(
        recipientEmails,
        renderTemplate(templates.requestSubject, templateVars),
        renderTemplate(templates.requestBody, templateVars)
      );
    }

    return { status: 201, application: newApp };
  }

  function validateLeaveBalance(balance, leaveType, requestedDays, options = {}) {
    const { allowNegativeBalance = false } = options || {};
    const days = Number.isFinite(requestedDays) ? requestedDays : 0;
    const projected = roundToOneDecimal((Number(balance) || 0) - days);
    if (!allowNegativeBalance && projected < 0) {
      return `Insufficient ${leaveType} balance. Current balance: ${roundToOneDecimal(balance)} days. You cannot apply for more of this leave type until your balance is non-negative.`;
    }
    return null;
  }

  async function handleLeaveApplicationRequest(req, res) {
    const scope = resolveEmployeeScope(req, req.body?.employeeId);
    if (scope.error) {
      return res.status(scope.status).json({ success: false, error: scope.error });
    }

    const payload = { ...req.body, employeeId: scope.employeeId };
    const result = await createLeaveApplication(payload, req.user);
    if (result.error) {
      return res
        .status(result.status)
        .json({ success: false, error: result.error });
    }

    return res
      .status(result.status)
      .json({ success: true, application: result.application });
  }

  // ---- APPLY FOR LEAVE ----
  app.post('/applications', async (req, res) => {
    const result = await createLeaveApplication(req.body, req.user);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.status(result.status).json(result.application);
  });

  app.get('/api/me', authRequired, (req, res) => {
    res.json({
      userId: req.user.id,
      employeeId: req.user.employeeId ?? null,
      email: req.user.email || null,
      role: req.user.role
    });
  });

  async function resolveUserInformation(identifier, currentUser) {
    const rawId = identifier ?? '';
    const id = typeof rawId === 'string' ? rawId.trim() : String(rawId).trim();

    if (!id) {
      return { status: 400, error: 'Employee ID is required' };
    }

    await db.read();
    db.data.users = Array.isArray(db.data.users) ? db.data.users : [];
    db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];

    const matchedUser = db.data.users.find(
      user => user && (user.id == id || user.employeeId == id)
    );
    const employeeId = matchedUser?.employeeId ?? id;
    const matchedEmployee = db.data.employees.find(emp => emp && emp.id == employeeId) ||
      db.data.employees.find(emp => emp && emp.id == id);

    if (!matchedUser && !matchedEmployee) {
      return { status: 404, error: 'User not found' };
    }

    const isSelf = Boolean(
      (matchedUser && (currentUser.id == matchedUser.id || currentUser.employeeId == matchedUser.employeeId)) ||
      (matchedEmployee && currentUser.employeeId == matchedEmployee.id) ||
      currentUser.id == id ||
      currentUser.employeeId == id
    );

    if (!isManagerRole(currentUser.role) && !isSelf) {
      return { status: 403, error: 'Forbidden' };
    }

    const resolvedEmployee = matchedEmployee || (matchedUser?.employeeId
      ? db.data.employees.find(emp => emp && emp.id == matchedUser.employeeId)
      : null);
    const name = resolvedEmployee?.name ? String(resolvedEmployee.name).trim() : null;
    const email = matchedUser?.email || (resolvedEmployee ? getEmpEmail(resolvedEmployee) : '');
    const role = matchedUser?.role || getEmpRole(resolvedEmployee);

    let managerInfo = null;
    if (resolvedEmployee) {
      const rawManager = findValueByKeywords(resolvedEmployee, [
        'appraiser',
        'manager',
        'supervisor',
        'reporting'
      ]);
      const managerCandidates = rawManager
        ? rawManager
            .split(/[\\/,&]+/)
            .map(value => value && value.trim())
            .filter(Boolean)
        : [];
      const primaryManagerName = managerCandidates[0] || (rawManager ? rawManager.trim() : '');

      if (primaryManagerName) {
        const normalizedPrimary = primaryManagerName.trim().toLowerCase();
        const managerEmployee =
          db.data.employees.find(emp =>
            typeof emp?.name === 'string' && emp.name.trim().toLowerCase() === normalizedPrimary
          ) || null;
        const managerUser = managerEmployee
          ? db.data.users.find(user => user && user.employeeId == managerEmployee.id)
          : null;
        const managerEmail = managerUser?.email || (managerEmployee ? getEmpEmail(managerEmployee) : '');

        managerInfo = {
          name: primaryManagerName,
          employeeId: managerEmployee?.id ?? null,
          email: managerEmail ? managerEmail : null
        };
      }
    }

    const title = resolvedEmployee
      ? findValueByKeywords(resolvedEmployee, ['title', 'position'])
      : '';
    const department = resolvedEmployee
      ? findValueByKeywords(resolvedEmployee, ['department', 'project', 'team'])
      : '';

    return {
      status: 200,
      data: {
        id: matchedUser?.id || resolvedEmployee?.id || id,
        employeeId: resolvedEmployee?.id || matchedUser?.employeeId || null,
        name,
        email: email ? email : null,
        role,
        title: title || null,
        department: department || null,
        manager: managerInfo
      }
    };
  }

  app.get('/api/users/:id', authRequired, async (req, res) => {
    const { id } = req.params;
    const result = await resolveUserInformation(id, req.user);

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(result.status).json(result.data);
  });

  app.post('/api/users', authRequired, async (req, res) => {
    const { employeeId } = req.body || {};
    const normalizedId =
      employeeId === null || employeeId === undefined ? '' : String(employeeId).trim();

    if (!normalizedId) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }

    const result = await resolveUserInformation(normalizedId, req.user);

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(result.status).json(result.data);
  });

  app.get('/api/manager-users', authRequired, managerOnly, async (_req, res) => {
    await db.read();
    const managers = buildRecipientOptions(db.data).map(option => ({
      email: option.email,
      name: option.name || '',
      employeeId: option.employeeId || null
    }));

    res.json({ managers });
  });

  app.get('/api/leave-summary', authRequired, async (req, res) => {
    const targetEmployeeId =
      isManagerRole(req.user.role) && req.query.employeeId
        ? req.query.employeeId
        : req.user.employeeId;

    if (!targetEmployeeId) {
      return res.status(400).json({ error: 'Employee ID is required.' });
    }

    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    db.data.applications = Array.isArray(db.data.applications)
      ? db.data.applications
      : [];

    const employee = db.data.employees.find(e => e.id == targetEmployeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const { formatted: leaveBalances } = await getComputedLeaveBalances(employee, {
      dateNow: new Date(),
      applications: db.data.applications,
      holidays: db.data.holidays
    });

    const now = new Date();
    const previousLeaveDays = db.data.applications
      .filter(app => app.employeeId == targetEmployeeId && app.status === 'approved')
      .filter(app => {
        const toDate = new Date(app.to);
        return !Number.isNaN(toDate.getTime()) && toDate < now;
      })
      .reduce((sum, app) => sum + getLeaveDays(app), 0);

    res.json({
      employeeId: employee.id,
      leaveBalances,
      previousLeaveDays
    });
  });

  app.get('/api/previous-leave-days', async (req, res) => {
    const targetEmployeeId =
      normalizeEmployeeId(req.query?.employeeId) ||
      normalizeEmployeeId(req.body?.employeeId) ||
      normalizeEmployeeId(req.user?.employeeId);

    if (!targetEmployeeId) {
      return res.status(400).json({ error: 'Employee ID is required.' });
    }

    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    db.data.applications = Array.isArray(db.data.applications)
      ? db.data.applications
      : [];

    const employee = db.data.employees.find(e => e.id == targetEmployeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const now = new Date();
    const previousLeaveDays = db.data.applications
      .filter(app => app.employeeId == targetEmployeeId && app.status === 'approved')
      .filter(app => {
        const toDate = new Date(app.to);
        return !Number.isNaN(toDate.getTime()) && toDate < now;
      })
      .reduce((sum, app) => sum + getLeaveDays(app), 0);

    res.json({
      employeeId: employee.id,
      previousLeaveDays
    });
  });

  app.post('/api/leave/existing-days', async (req, res) => {
    const scope = resolveEmployeeScope(req, req.body?.employeeId);
    if (scope.error) {
      return res.status(scope.status).json({ error: scope.error });
    }

    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    db.data.applications = Array.isArray(db.data.applications)
      ? db.data.applications
      : [];

    const employee = db.data.employees.find(e => e.id == scope.employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const approvedApplications = db.data.applications
      .filter(app => app.employeeId == scope.employeeId)
      .filter(app => String(app.status || '').toLowerCase() === 'approved')
      .map(toLeaveApplicationSummary);

    const totalApprovedDays = approvedApplications.reduce(
      (total, app) => total + Number(app.days || 0),
      0
    );

    res.json({
      employeeId: normalizeEmployeeId(employee.id) || scope.employeeId,
      totalApprovedDays,
      applications: approvedApplications
    });
  });

  app.post('/api/leave/pending', async (req, res) => {
    const scope = resolveEmployeeScope(req, req.body?.employeeId);
    if (scope.error) {
      return res.status(scope.status).json({ error: scope.error });
    }

    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];
    db.data.applications = Array.isArray(db.data.applications)
      ? db.data.applications
      : [];

    const employee = db.data.employees.find(e => e.id == scope.employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const pendingApplications = db.data.applications
      .filter(app => app.employeeId == scope.employeeId)
      .filter(app => String(app.status || '').toLowerCase() === 'pending')
      .map(toLeaveApplicationSummary);

    const totalPendingDays = pendingApplications.reduce(
      (total, app) => total + Number(app.days || 0),
      0
    );

    res.json({
      employeeId: normalizeEmployeeId(employee.id) || scope.employeeId,
      totalPendingDays,
      pendingApplications
    });
  });

  app.post('/api/leave/balance', async (req, res) => {
    const scope = resolveEmployeeScope(req, req.body?.employeeId);
    if (scope.error) {
      return res.status(scope.status).json({ error: scope.error });
    }

    await db.read();
    db.data.employees = Array.isArray(db.data.employees)
      ? db.data.employees
      : [];

    const employee = db.data.employees.find(e => e.id == scope.employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const { formatted: leaveBalances } = await getComputedLeaveBalances(employee, {
      dateNow: new Date(),
      applications: db.data.applications,
      holidays: db.data.holidays
    });

    res.json({
      employeeId: normalizeEmployeeId(employee.id) || scope.employeeId,
      leaveBalances
    });
  });

  app.post('/api/leave/submit', async (req, res) => {
    const scope = resolveEmployeeScope(req, req.body?.employeeId);
    if (scope.error) {
      return res.status(scope.status).json({ success: false, error: scope.error });
    }

    const payload = { ...req.body, employeeId: scope.employeeId };
    const result = await createLeaveApplication(payload, req.user);
    if (result.error) {
      return res
        .status(result.status)
        .json({ success: false, error: result.error });
    }

    return res
      .status(result.status)
      .json({ success: true, application: result.application });
  });

  app.post('/api/leaves', handleLeaveApplicationRequest);
  app.post('/api/apply-leave', handleLeaveApplicationRequest);

  app.get('/api/management/overview', async (req, res) => {
    const access = await resolveManagerAccess(req.query?.employeeId);
    if (access?.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const { employees } = access;
    const employeesById = new Map(
      (employees || []).map(emp => [String(emp.id), emp])
    );

    const applications = Array.isArray(db.data?.applications)
      ? db.data.applications
      : [];
    const approvedApps = applications.filter(
      app => (app?.status || '').toString().toLowerCase() === 'approved'
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfToday = new Date(today);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sevenDaysOut = new Date(today);
    sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);

    const onLeaveToday = approvedApps
      .filter(app => isLeaveInRange(app, today, endOfToday))
      .map(app => buildLeaveWindowEntry(app, employeesById))
      .sort((a, b) => (a.employeeName || '').localeCompare(b.employeeName || ''));

    const onLeaveNext7Days = approvedApps
      .filter(app => isLeaveInRange(app, tomorrow, sevenDaysOut))
      .map(app => buildLeaveWindowEntry(app, employeesById))
      .sort((a, b) => {
        const aDate = new Date(a.from).getTime();
        const bDate = new Date(b.from).getTime();
        if (!Number.isFinite(aDate) || !Number.isFinite(bDate)) {
          return (a.employeeName || '').localeCompare(b.employeeName || '');
        }
        return aDate - bDate;
      });

    const leaveApplications = applications
      .map(app => {
        const summary = toLeaveApplicationSummary(app);
        const employee = employeesById.get(String(summary.employeeId)) || null;
        return {
          ...summary,
          employeeName: employee?.name || null,
          title: findValueByKeywords(employee, ['title', 'position']) || null,
          project: findValueByKeywords(employee, ['project', 'department']) || null
        };
      })
      .sort((a, b) => (b.id || 0) - (a.id || 0));

    res.json({
      employeeId: access.employeeId,
      manager: {
        employeeId: access.employee?.id || access.employeeId,
        name: access.employee?.name || null,
        email: getEmpEmail(access.employee) || access.user?.email || null
      },
      onLeaveToday,
      onLeaveNext7Days,
      leaveApplications
    });
  });

  app.get('/api/management/employees', async (req, res) => {
    const access = await resolveManagerAccess(req.query?.employeeId);
    if (access?.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const searchTerm = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    const nameFilter = typeof req.query?.name === 'string' ? req.query.name.trim() : '';
    const titleFilter = typeof req.query?.title === 'string' ? req.query.title.trim() : '';
    const projectFilter = typeof req.query?.project === 'string' ? req.query.project.trim() : '';
    const managerFilter = typeof req.query?.manager === 'string' ? req.query.manager.trim() : '';

    const toComparable = value => (value || '').toString().trim().toLowerCase();

    const matches = (value, filter) => {
      if (!filter) return true;
      return toComparable(value).includes(filter.toLowerCase());
    };

    const employees = Array.isArray(access.employees) ? access.employees : [];

    const summaries = employees
      .map(emp => {
        const name = emp?.name || '';
        const title = findValueByKeywords(emp, ['title', 'position']) || '';
        const project = findValueByKeywords(emp, ['project', 'department']) || '';
        const manager = findValueByKeywords(emp, ['appraiser', 'manager', 'supervisor', 'reporting']) || '';
        const status = typeof emp?.status === 'string' ? emp.status : '';
        return {
          employeeId: emp?.id || null,
          name,
          email: getEmpEmail(emp) || '',
          title,
          project,
          manager,
          status,
          role: getEmpRole(emp)
        };
      })
      .filter(summary => {
        if (!summary.employeeId) return false;
        if (searchTerm) {
          const combined = [
            summary.name,
            summary.title,
            summary.project,
            summary.manager,
            summary.email
          ]
            .map(value => value || '')
            .join(' ')
            .toLowerCase();
          if (!combined.includes(searchTerm.toLowerCase())) {
            return false;
          }
        }
        if (!matches(summary.name, nameFilter)) return false;
        if (!matches(summary.title, titleFilter)) return false;
        if (!matches(summary.project, projectFilter)) return false;
        if (!matches(summary.manager, managerFilter)) return false;
        return true;
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({
      employeeId: access.employeeId,
      total: summaries.length,
      employees: summaries
    });
  });

  // ========== FINANCE ==========
  app.get('/api/finance/salaries', authRequired, superadminOnly, async (req, res) => {
    const requestedMonth = normalizePayrollMonth(req.query?.month);
    const month = requestedMonth || currentPayrollMonth();

    await db.read();
    db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];
    db.data.salaries = Array.isArray(db.data.salaries) ? db.data.salaries : [];

    const salaryRecordsByEmployee = new Map();
    db.data.salaries.forEach(entry => {
      if (!entry) return;
      const employeeId = normalizeEmployeeId(entry.employeeId);
      if (!employeeId) return;
      const amount = Number(entry.amount);
      const normalizedAmount = Number.isFinite(amount) ? amount : null;
      const record = {
        employeeId,
        month: normalizePayrollMonth(entry.month) || null,
        amount: normalizedAmount,
        currency: entry.currency || null,
        updatedAt: entry.updatedAt || null
      };
      const records = salaryRecordsByEmployee.get(employeeId) || [];
      records.push(record);
      salaryRecordsByEmployee.set(employeeId, records);
    });

    const activeEmployees = db.data.employees
      .filter(emp => emp && isEmployeeActive(emp))
      .map(emp => {
        const employeeId = normalizeEmployeeId(emp.id);
        if (!employeeId) return null;
        const bankAccountNumber = findValueByKeywords(emp, [
          'bank account number',
          'account number',
          'bank account'
        ]);
        const bankAccountName = findValueByKeywords(emp, [
          'bank account name',
          'account name',
          'account holder'
        ]);
        const salary = pickSalaryRecord(salaryRecordsByEmployee.get(employeeId) || [], month);

        const summary = {
          employeeId,
          name: emp.name || '',
          email: getEmpEmail(emp) || '',
          title: findValueByKeywords(emp, ['title', 'position']) || '',
          department: findValueByKeywords(emp, ['department', 'project']) || '',
          status: emp.status || '',
          bankAccountName: bankAccountName || '',
          bankAccountNumber: bankAccountNumber || '',
          salary: salary || null
        };

        return { summary, raw: emp, salary };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const nameA = (a?.summary?.name || '').toLowerCase();
        const nameB = (b?.summary?.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });

    const employees = activeEmployees.map(entry => entry.summary);
    const payrollSummary = activeEmployees.map(entry =>
      buildPayrollSummaryEntry(entry.raw, entry.summary, entry.salary, month)
    );

    res.json({ month, employees, payrollSummary });
  });

  app.post('/api/finance/salaries', authRequired, superadminOnly, async (req, res) => {
    const { employeeId: rawEmployeeId, month: rawMonth, amount: rawAmount, currency: rawCurrency } =
      req.body || {};

    const employeeId = normalizeEmployeeId(rawEmployeeId);
    if (!employeeId) {
      return res.status(400).json({ error: 'employeeId is required.' });
    }

    const month = normalizePayrollMonth(rawMonth) || currentPayrollMonth();
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Salary amount must be a non-negative number.' });
    }

    const currency = typeof rawCurrency === 'string'
      ? rawCurrency.trim().toUpperCase().slice(0, 8) || null
      : null;

    await db.read();
    db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];
    db.data.salaries = Array.isArray(db.data.salaries) ? db.data.salaries : [];

    const employee = db.data.employees.find(emp => normalizeEmployeeId(emp.id) === employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    if (!isEmployeeActive(employee)) {
      return res.status(400).json({ error: 'Cannot assign salary to inactive employee.' });
    }

    let record = db.data.salaries.find(entry => {
      if (!entry) return false;
      const entryEmployeeId = normalizeEmployeeId(entry.employeeId);
      const entryMonth = normalizePayrollMonth(entry.month);
      return entryEmployeeId === employeeId && entryMonth === month;
    });

    const timestamp = new Date().toISOString();
    if (record) {
      record.amount = amount;
      record.month = month;
      record.currency = currency;
      record.updatedAt = timestamp;
    } else {
      record = {
        employeeId,
        month,
        amount,
        currency,
        updatedAt: timestamp
      };
      db.data.salaries.push(record);
    }

    await db.write();

    const responseSalary = {
      employeeId,
      month,
      amount,
      currency,
      updatedAt: record.updatedAt
    };

    const employeeSummary = {
      employeeId,
      name: employee?.name || '',
      email: getEmpEmail(employee) || '',
      title: findValueByKeywords(employee, ['title', 'position']) || '',
      department: findValueByKeywords(employee, ['department', 'project']) || '',
      status: employee?.status || '',
      bankAccountName: findValueByKeywords(employee, ['bank account name', 'account name', 'account holder']) || '',
      bankAccountNumber: findValueByKeywords(employee, ['bank account number', 'account number', 'bank account']) || ''
    };

    const payrollEntry = buildPayrollSummaryEntry(employee, employeeSummary, responseSalary, month);

    res.json({ salary: responseSalary, employee: employeeSummary, payroll: payrollEntry });
  });

  app.get('/api/openapi/user-info', authRequired, (req, res) => {
    const userInfoOpenApi = {
      openapi: '3.0.0',
      info: {
        title: 'User Information API',
        version: '1.0.0',
        description: 'Specification describing the user information endpoint.'
      },
      servers: [{ url: 'http://localhost:3000' }],
      paths: {
        '/api/users/{id}': buildUserInfoOpenApiPath(),
        '/api/users': buildUserInfoLookupOpenApiPath()
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        },
        schemas: buildUserInfoOpenApiSchemas()
      }
    };

    res
      .type('application/json')
      .send(JSON.stringify(userInfoOpenApi, null, 2));
  });

  app.get('/api/leaveapplicationopenapi', authRequired, (req, res) => {
    const leaveOpenApi = buildLeaveApplicationOpenApiSpec();
    res
      .type('application/json')
      .send(JSON.stringify(leaveOpenApi, null, 2));
  });

  app.get('/api/managementopenapi', (req, res) => {
    const managementOpenApi = {
      openapi: '3.0.0',
      info: {
        title: 'Brillar HR Management APIs',
        version: '1.0.0',
        description:
          'Unauthenticated endpoints that provide aggregated employee and leave information for manager accounts.'
      },
      servers: [{ url: 'http://localhost:3000' }],
      paths: {
        '/api/management/overview': {
          get: {
            summary: 'Get aggregated leave insights for the organization.',
            parameters: [
              {
                in: 'query',
                name: 'employeeId',
                required: true,
                schema: { type: 'string' },
                description: 'Employee identifier of the manager requesting access.'
              }
            ],
            responses: {
              200: {
                description: 'Aggregated leave information for the organization.',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ManagementOverviewResponse' }
                  }
                }
              },
              400: { description: 'Missing or invalid employee identifier.' },
              403: { description: 'The supplied employee identifier does not belong to a manager.' }
            }
          }
        },
        '/api/management/employees': {
          get: {
            summary: 'Search and list employees with optional filters.',
            parameters: [
              {
                in: 'query',
                name: 'employeeId',
                required: true,
                schema: { type: 'string' },
                description: 'Employee identifier of the manager requesting access.'
              },
              {
                in: 'query',
                name: 'q',
                required: false,
                schema: { type: 'string' },
                description: 'Free-text search across name, title, project, manager and email.'
              },
              {
                in: 'query',
                name: 'name',
                required: false,
                schema: { type: 'string' },
                description: 'Filter employees by name.'
              },
              {
                in: 'query',
                name: 'title',
                required: false,
                schema: { type: 'string' },
                description: 'Filter employees by job title or position.'
              },
              {
                in: 'query',
                name: 'project',
                required: false,
                schema: { type: 'string' },
                description: 'Filter employees by project or department.'
              },
              {
                in: 'query',
                name: 'manager',
                required: false,
                schema: { type: 'string' },
                description: 'Filter employees by reporting manager or appraiser.'
              }
            ],
            responses: {
              200: {
                description: 'Filtered employee listing.',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ManagementEmployeeSearchResponse' }
                  }
                }
              },
              400: { description: 'Missing or invalid employee identifier.' },
              403: { description: 'The supplied employee identifier does not belong to a manager.' }
            }
          }
        }
      },
      components: {
        schemas: {
          LeaveWindowEntry: {
            type: 'object',
            properties: {
              id: { type: ['integer', 'string'] },
              employeeId: { type: ['string', 'null'] },
              employeeName: { type: ['string', 'null'] },
              title: { type: ['string', 'null'] },
              project: { type: ['string', 'null'] },
              type: { type: ['string', 'null'] },
              from: { type: ['string', 'null'], format: 'date-time' },
              to: { type: ['string', 'null'], format: 'date-time' },
              status: { type: ['string', 'null'] },
              reason: { type: ['string', 'null'] },
              halfDay: { type: 'boolean' },
              halfDayType: { type: ['string', 'null'] },
              days: { type: 'number' },
              approvedBy: { type: ['string', 'null'] },
              approverRemark: { type: ['string', 'null'] },
              approvedAt: { type: ['string', 'null'], format: 'date-time' },
              cancelledAt: { type: ['string', 'null'], format: 'date-time' }
            }
          },
          ManagementOverviewResponse: {
            type: 'object',
            properties: {
              employeeId: { type: 'string' },
              manager: {
                type: 'object',
                properties: {
                  employeeId: { type: ['string', 'null'] },
                  name: { type: ['string', 'null'] },
                  email: { type: ['string', 'null'], format: 'email' }
                }
              },
              onLeaveToday: {
                type: 'array',
                items: { $ref: '#/components/schemas/LeaveWindowEntry' }
              },
              onLeaveNext7Days: {
                type: 'array',
                items: { $ref: '#/components/schemas/LeaveWindowEntry' }
              },
              leaveApplications: {
                type: 'array',
                items: { $ref: '#/components/schemas/LeaveWindowEntry' }
              }
            }
          },
          ManagementEmployeeSummary: {
            type: 'object',
            properties: {
              employeeId: { type: ['string', 'integer'] },
              name: { type: ['string', 'null'] },
              email: { type: ['string', 'null'], format: 'email' },
              title: { type: ['string', 'null'] },
              project: { type: ['string', 'null'] },
              manager: { type: ['string', 'null'] },
              status: { type: ['string', 'null'] },
              role: { type: ['string', 'null'] }
            }
          },
          ManagementEmployeeSearchResponse: {
            type: 'object',
            properties: {
              employeeId: { type: 'string' },
              total: { type: 'integer' },
              employees: {
                type: 'array',
                items: { $ref: '#/components/schemas/ManagementEmployeeSummary' }
              }
            }
          }
        }
      }
    };

    res
      .type('application/json')
      .send(JSON.stringify(managementOpenApi, null, 2));
  });

  app.get('/api/recruitmentopenAI', authRequired, managerOnly, (req, res) => {
    res.type('application/json').send(recruitmentOpenApiSpec);
  });

  app.get('/api/openapi', authRequired, (req, res) => {
    const userInfoSchemas = buildUserInfoOpenApiSchemas();
    const leaveApplicationSchemas = buildLeaveApplicationSchemas();
    const leaveApplicationPaths = buildLeaveApplicationPaths();
    const openApiSpec = {
      openapi: '3.0.0',
      info: {
        title: 'Brillar HR Portal Leave APIs',
        version: '1.0.0',
        description:
          'API specification for leave management helper endpoints.'
      },
      servers: [{ url: 'http://localhost:3000' }],
      paths: {
        '/api/me': {
          get: {
            summary: 'Get current user identifier',
            security: [{ bearerAuth: [] }],
            responses: {
              200: {
                description: 'Authenticated user information',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/CurrentUserResponse' }
                  }
                }
              }
            }
          }
        },
        '/api/users/{id}': buildUserInfoOpenApiPath(),
        '/api/users': buildUserInfoLookupOpenApiPath(),
        ...leaveApplicationPaths,
        '/api/leave-summary': {
          get: {
            summary: 'Retrieve leave balances and historical usage',
            security: [{ bearerAuth: [] }],
            parameters: [
              {
                in: 'query',
                name: 'employeeId',
                schema: { type: 'string' },
                description:
                  'Optional employee identifier. Managers can view other employees.'
              }
            ],
            responses: {
              200: {
                description: 'Leave balances and usage metrics',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/LeaveSummaryResponse' }
                  }
                }
              }
            }
          }
        },
        '/api/previous-leave-days': {
          get: {
            summary: 'Retrieve total approved leave days in the past',
            parameters: [
              {
                in: 'query',
                name: 'employeeId',
                schema: { type: 'string' },
                description:
                  'Optional employee identifier. Managers can view other employees.'
              }
            ],
            responses: {
              200: {
                description: 'Total approved leave days prior to today',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/PreviousLeaveDaysResponse' }
                  }
                }
              },
              400: { description: 'Employee ID missing' },
              404: { description: 'Employee not found' }
            }
          }
        },
        '/api/leaves': {
          post: {
            summary: 'Apply for leave',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LeaveApplicationRequest' }
                }
              }
            },
            responses: {
              201: {
                description: 'Leave application created',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/LeaveApplicationResponse' }
                  }
                }
              },
              400: { description: 'Validation error' },
              403: { description: 'Forbidden' }
            }
          }
        },
        '/api/apply-leave': {
          post: {
            summary: 'Apply for leave (alias of /api/leaves)',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LeaveApplicationRequest' }
                }
              }
            },
            responses: {
              201: {
                description: 'Leave application created',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/LeaveApplicationResponse' }
                  }
                }
              },
              400: { description: 'Validation error' },
              403: { description: 'Forbidden' }
            }
          }
        },
        '/api/openapi': {
          get: {
            summary: 'Retrieve OpenAPI specification',
            security: [{ bearerAuth: [] }],
            responses: {
              200: {
                description: 'OpenAPI specification JSON string',
                content: {
                  'application/json': {
                    schema: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        },
        schemas: {
          CurrentUserResponse: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              employeeId: { type: ['string', 'null'] },
              email: { type: ['string', 'null'], format: 'email' },
              role: { type: 'string' }
            }
          },
          LeaveSummaryResponse: {
            type: 'object',
            properties: {
              employeeId: { type: 'string' },
              leaveBalances: {
                type: 'object',
                additionalProperties: { type: 'number' }
              },
              previousLeaveDays: { type: 'number' }
            }
          },
          PreviousLeaveDaysResponse: {
            type: 'object',
            properties: {
              employeeId: { type: 'string' },
              previousLeaveDays: { type: 'number' }
            }
          },
          ...leaveApplicationSchemas,
          ...userInfoSchemas
        }
      }
    };

    res
      .type('application/json')
      .send(JSON.stringify(openApiSpec, null, 2));
  });

  // ---- APPROVE LEAVE ----
  app.patch('/applications/:id/approve', authRequired, managerOnly, async (req, res) => {
    const { id } = req.params;
    const { approver, remark } = req.body;
    await db.read();
    const appIdx = db.data.applications.findIndex(x => x.id == id);
    if (appIdx < 0) return res.status(404).json({ error: 'Not found' });
    if (db.data.applications[appIdx].status !== 'pending')
      return res.status(400).json({ error: 'Already actioned' });

    const app = db.data.applications[appIdx];
    const employee = db.data.employees.find(e => e.id == app.employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found for this leave request.' });
    }

    const { raw: leaveBalances } = await getComputedLeaveBalances(employee, {
      dateNow: new Date(),
      applications: db.data.applications,
      holidays: db.data.holidays
    });

    const leaveType = String(app.type || '').toLowerCase();
    const requestedDays = getLeaveDays(app);
    const balance = leaveBalances?.[leaveType]?.balance || 0;
    const validationError = validateLeaveBalance(balance, leaveType, requestedDays, {
      allowNegativeBalance: Boolean(app.allowNegativeBalance)
    });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    db.data.applications[appIdx].status = 'approved';
    db.data.applications[appIdx].approvedBy = approver || '';
    db.data.applications[appIdx].approverRemark = remark || '';
    db.data.applications[appIdx].approvedAt = new Date().toISOString();
    await db.write();

    const email = getEmpEmail(employee);
    const name = employee?.name || email || `Employee ${db.data.applications[appIdx].employeeId}`;
    if (email) {
      const templates = (await loadEmailSettings())?.templates || DEFAULT_LEAVE_EMAIL_TEMPLATES;
      const templateVars = {
        name,
        type: db.data.applications[appIdx].type,
        from: db.data.applications[appIdx].from,
        to: db.data.applications[appIdx].to
      };
      await sendEmail(
        email,
        renderTemplate(templates.approveSubject, templateVars),
        renderTemplate(templates.approveBody, templateVars)
      );
    }

    res.json(db.data.applications[appIdx]);
  });

  // ---- REJECT LEAVE ----
  app.patch('/applications/:id/reject', authRequired, managerOnly, async (req, res) => {
    const { id } = req.params;
    const { approver, remark } = req.body;
    await db.read();
    const appIdx = db.data.applications.findIndex(x => x.id == id);
    if (appIdx < 0) return res.status(404).json({ error: 'Not found' });

    const app = db.data.applications[appIdx];
    if (app.status !== 'pending' && app.status !== 'approved')
      return res.status(400).json({ error: 'Already actioned' });

    // Credit back balance when rejecting (whether pending or already approved)
    const empIdx = db.data.employees.findIndex(x => x.id == app.employeeId);
    if (empIdx >= 0) {
      const employee = db.data.employees[empIdx];
      ensureLeaveBalances(employee);
      const days = getLeaveDays(app);
      const current = getLeaveBalanceValue(employee.leaveBalances, app.type);
      setLeaveBalanceValue(employee.leaveBalances, app.type, current + days);
    }

    db.data.applications[appIdx].status = 'rejected';
    db.data.applications[appIdx].approvedBy = approver || '';
    db.data.applications[appIdx].approverRemark = remark || '';
    db.data.applications[appIdx].approvedAt = new Date().toISOString();
    await db.write();

    const emp = db.data.employees.find(e => e.id == app.employeeId);
    const email = getEmpEmail(emp);
    const name = emp?.name || email || `Employee ${app.employeeId}`;
    if (email) {
      const templates = (await loadEmailSettings())?.templates || DEFAULT_LEAVE_EMAIL_TEMPLATES;
      const templateVars = { name, type: app.type, from: app.from, to: app.to };
      await sendEmail(
        email,
        renderTemplate(templates.rejectSubject, templateVars),
        renderTemplate(templates.rejectBody, templateVars)
      );
    }

    res.json(db.data.applications[appIdx]);
  });

  // ---- CANCEL LEAVE ----
  app.patch('/applications/:id/cancel', authRequired, async (req, res) => {
    const { id } = req.params;
    await db.read();
    const appIdx = db.data.applications.findIndex(x => x.id == id);
    if (appIdx < 0) return res.status(404).json({ error: 'Not found' });

    const appObjApp = db.data.applications[appIdx];
    if (!isManagerRole(req.user.role) && appObjApp.employeeId != req.user.employeeId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (['cancelled', 'rejected'].includes(appObjApp.status)) {
      return res.status(400).json({ error: 'Already cancelled/rejected' });
    }

    // Only allow cancel if today is before leave "from" date
    const now = new Date();
    if (new Date(appObjApp.from) <= now) {
      return res.status(400).json({ error: 'Cannot cancel after leave started' });
    }

    // Credit back balance when cancelling (whether pending or approved)
    const empIdx = db.data.employees.findIndex(x => x.id == appObjApp.employeeId);
    if (empIdx >= 0) {
      const employee = db.data.employees[empIdx];
      ensureLeaveBalances(employee);
      const days = getLeaveDays(appObjApp);
      const current = getLeaveBalanceValue(employee.leaveBalances, appObjApp.type);
      setLeaveBalanceValue(employee.leaveBalances, appObjApp.type, current + days);
    }

    db.data.applications[appIdx].status = 'cancelled';
    db.data.applications[appIdx].cancelledAt = new Date().toISOString();
    await db.write();

    const emp = db.data.employees.find(e => e.id == appObjApp.employeeId);
    const email = getEmpEmail(emp);
    const name = emp?.name || email || `Employee ${appObjApp.employeeId}`;
    if (email) {
      const templates = (await loadEmailSettings())?.templates || DEFAULT_LEAVE_EMAIL_TEMPLATES;
      const templateVars = {
        name,
        type: appObjApp.type,
        from: appObjApp.from,
        to: appObjApp.to
      };
      await sendEmail(
        email,
        renderTemplate(templates.cancelSubject, templateVars),
        renderTemplate(templates.cancelBody, templateVars)
      );
    }

    res.json(db.data.applications[appIdx]);
  });

  // (Legacy/optional: PATCH by status field)
  app.patch('/applications/:id/decision', authRequired, managerOnly, async (req, res) => {
    await db.read();
    const { status } = req.body; // "approved" or "rejected"
    const appIdx = db.data.applications.findIndex(a => a.id == req.params.id);
    const app = db.data.applications[appIdx];
    if (!app) return res.status(404).json({ error: 'Not found' });
    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';

    if (normalizedStatus === 'approved') {
      const employee = db.data.employees.find(e => e.id == app.employeeId);
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found for this leave request.' });
      }

      const { raw: leaveBalances } = await getComputedLeaveBalances(employee, {
        dateNow: new Date(),
        applications: db.data.applications,
        holidays: db.data.holidays
      });

      const leaveType = String(app.type || '').toLowerCase();
      const requestedDays = getLeaveDays(app);
      const balance = leaveBalances?.[leaveType]?.balance || 0;
      const validationError = validateLeaveBalance(balance, leaveType, requestedDays, {
        allowNegativeBalance: Boolean(app.allowNegativeBalance)
      });
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    } else if (normalizedStatus === 'rejected') {
      // Credit back leave
      const emp = db.data.employees.find(e => e.id == app.employeeId);
      if (emp) {
        ensureLeaveBalances(emp);
        const days = getLeaveDays(app);
        const current = getLeaveBalanceValue(emp.leaveBalances, app.type);
        setLeaveBalanceValue(emp.leaveBalances, app.type, current + days);
      }
    }
    app.status = normalizedStatus || status;
    await db.write();
    res.json(app);
  });

  // ========== GLOBAL ERROR HANDLER ==========
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  // ========== START SERVER ==========
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
