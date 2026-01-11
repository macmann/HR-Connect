// public/index.js

let currentUser = null;
let calendarCurrent = new Date();
let empSearchTerm = '';
const employeeGridState = {
  sort: { key: '', direction: 'asc' },
  columnVisibility: {},
  columnWidths: {},
  expanded: new Set(),
  view: 'table',
  page: 1,
  pageSize: 8,
  statusFilter: 'all',
  internFilter: 'all'
};
let companyHolidays = [];
let holidaysLoaded = false;
let holidaysLoading = null;
let managerOptionsCache = null;
let managerOptionsPromise = null;

const DEFAULT_POST_LOGIN_URL = 'https://api-qa.atenxion.ai/api/post-login/user-login';
const DEFAULT_POST_LOGIN_AUTH =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhZ2VudElkIjoiNjkwMDcxMjAzN2MwZWQwMzY4MjFiMzM0IiwidHlwZSI6Im11bHRpYWdlbnQiLCJpYXQiOjE3NjE2MzY2NDB9.-reLuknFL4cc26r2BGms92CZnSHj-J3riIgo7XM4ZcI';
const POST_LOGIN_TIMEOUT_MS = 5000;
const DEFAULT_CHAT_WIDGET_URL =
  'https://qa.atenxion.ai/chat-widget?agentchainId=6900712037c0ed036821b334';
const INACTIVE_EMPLOYEE_STATUSES = new Set(['inactive', 'deactivated', 'disabled', 'terminated']);
const SUPPORTED_LEAVE_TYPES = ['annual', 'casual', 'medical'];
const DEFAULT_LEAVE_BALANCE_CONFIG = {
  annual: { yearlyAllocation: 10, monthlyAccrual: 10 / 12 },
  casual: { yearlyAllocation: 5, monthlyAccrual: 5 / 12 },
  medical: { yearlyAllocation: 14, monthlyAccrual: 14 / 12 }
};
const LOCATION_COLORS = ['#6366f1', '#22c55e', '#06b6d4', '#f97316', '#a855f7', '#f43f5e', '#10b981', '#a3e635'];

function normalizeRole(role) {
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function isManagerRole(roleOrUser) {
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser?.role;
  const normalized = normalizeRole(role);
  return normalized === 'manager' || normalized === 'superadmin';
}

function isSuperAdmin(roleOrUser) {
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser?.role;
  return normalizeRole(role) === 'superadmin';
}

function isLearningAdminRole(roleOrUser) {
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser?.role;
  const normalized = normalizeRole(role);
  return ['superadmin', 'hr', 'l&d', 'learning', 'learning & development', 'learning and development', 'ld'].includes(normalized);
}

function isLearningReportRole(roleOrUser) {
  return isManagerRole(roleOrUser) || isLearningAdminRole(roleOrUser);
}

function isActiveEmployeeStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!normalized) return true;
  return !INACTIVE_EMPLOYEE_STATUSES.has(normalized);
}

function isEmployeeActive(employee) {
  if (!employee || typeof employee !== 'object') return false;
  const statusKey = Object.keys(employee).find(key => key.toLowerCase() === 'status');
  const statusValue = statusKey ? employee[statusKey] : '';
  return isActiveEmployeeStatus(statusValue);
}

function roundToOneDecimal(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 10) / 10;
}

const LEAVE_TYPE_DEFAULTS = {
  annual: { yearlyAllocation: 10 },
  casual: { yearlyAllocation: 5 },
  medical: { yearlyAllocation: 14 }
};

function getLeaveBalanceValue(leaveBalances = {}, type) {
  if (!type) return 0;
  const entry = leaveBalances[type];
  if (entry && typeof entry === 'object') {
    return roundToOneDecimal(entry.balance);
  }
  return roundToOneDecimal(entry);
}

function normalizeLeaveBalanceMap(leaveBalances = {}) {
  return {
    annual: getLeaveBalanceValue(leaveBalances, 'annual'),
    casual: getLeaveBalanceValue(leaveBalances, 'casual'),
    medical: getLeaveBalanceValue(leaveBalances, 'medical')
  };
}

function getLeaveTypeAllocation(type, leaveBalances = {}) {
  const entry = leaveBalances[type];
  if (entry && typeof entry === 'object' && Number.isFinite(entry.yearlyAllocation)) {
    return entry.yearlyAllocation;
  }
  return LEAVE_TYPE_DEFAULTS[type]?.yearlyAllocation || 0;
}

function getLeaveCycleStart(leaveBalances = {}) {
  const raw = leaveBalances.cycleStart || leaveBalances.accrualStartDate;
  const parsed = raw ? new Date(raw) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;

  const now = new Date();
  const julyStart = new Date(now.getFullYear(), 6, 1);
  if (now < julyStart) julyStart.setFullYear(now.getFullYear() - 1);
  return julyStart;
}

function buildAvailableLeaveState(leaveBalances = {}, applications = []) {
  const cycleStart = getLeaveCycleStart(leaveBalances);
  const usage = { annual: 0, casual: 0, medical: 0 };
  const available = {};
  const accrued = {};
  const normalizedBalances = normalizeLeaveBalanceMap(leaveBalances);

  SUPPORTED_LEAVE_TYPES.forEach(type => {
    const entry = leaveBalances[type] || {};
    const takenValue = Number.isFinite(entry.taken) ? entry.taken : usage[type] || 0;
    usage[type] = roundToOneDecimal(takenValue);
    const accruedValue = Number.isFinite(entry.accrued)
      ? entry.accrued
      : roundToOneDecimal((normalizedBalances[type] || 0) + usage[type]);
    accrued[type] = roundToOneDecimal(accruedValue);
    available[type] = roundToOneDecimal(normalizedBalances[type]);
  });

  return { cycleStart, usage, available, accrued };
}

function setBalanceValue(elementId, value) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const rounded = roundToOneDecimal(value);
  el.textContent = rounded.toFixed(1);
  el.classList.toggle('balance-negative', rounded < 0);
}

function getNegativeBalanceTypes(balanceMap = {}) {
  return Object.entries(balanceMap)
    .filter(([, val]) => typeof val === 'number' && val < 0)
    .map(([key]) => key);
}

function updateBalanceWarning(balanceMap = {}) {
  const warningEl = document.getElementById('balanceWarning');
  if (!warningEl) return;
  const negativeTypes = getNegativeBalanceTypes(balanceMap);
  if (!negativeTypes.length) {
    warningEl.classList.add('hidden');
    return;
  }
  const warningText = warningEl.querySelector('p');
  if (warningText) {
    const readableTypes = negativeTypes.map(capitalize).join(', ');
    const managerOverride = isManagerRole(currentUser?.role)
      ? ' Managers can proceed but balances will go negative.'
      : ' Applications for these types are temporarily disabled.';
    warningText.textContent = `Negative balance for ${readableTypes}.${managerOverride}`;
  }
  warningEl.classList.remove('hidden');
}

function populateLeaveTypeOptions(selectEl, balanceMap = {}) {
  if (!selectEl) return { hasEnabled: false };
  selectEl.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- select leave type --';
  placeholder.disabled = true;
  placeholder.selected = true;
  selectEl.appendChild(placeholder);
  const types = ['annual', 'casual', 'medical'];
  let firstEnabled = '';
  types.forEach(type => {
    const balance = balanceMap[type] ?? 0;
    const isDisabled = balance < 0 && !isManagerRole(currentUser?.role);
    const opt = document.createElement('option');
    opt.value = type;
    opt.disabled = isDisabled;
    opt.dataset.balance = balance;
    opt.textContent = `${capitalize(type)} (${balance} days${isDisabled ? ' - unavailable' : ''})`;
    if (!isDisabled && !firstEnabled) firstEnabled = type;
    selectEl.appendChild(opt);
  });
  const hasEnabled = Boolean(firstEnabled);
  if (hasEnabled) {
    selectEl.value = firstEnabled;
  } else {
    placeholder.disabled = false;
    selectEl.value = '';
  }
  return { hasEnabled };
}

function buildLeaveBalanceEntry(balance, type) {
  const defaults = DEFAULT_LEAVE_BALANCE_CONFIG[type] || { yearlyAllocation: 0, monthlyAccrual: 0 };
  const numericBalance = Number(balance);
  return {
    balance: Number.isFinite(numericBalance) ? numericBalance : 0,
    yearlyAllocation: defaults.yearlyAllocation,
    monthlyAccrual: defaults.monthlyAccrual
  };
}

function normalizeInternFlag(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
  }
  return Boolean(value);
}

function normalizePositionStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'closed') return 'Closed';
  return 'Open';
}

function getChatWidgetBaseUrl() {
  const configuredUrl = chatWidgetSettings?.url;
  return configuredUrl || DEFAULT_CHAT_WIDGET_URL;
}

function updateChatWidgetUser(employeeId) {
  const iframe = document.getElementById('chatWidgetIframe');
  if (!iframe || typeof URL !== 'function') return;
  const baseUrl = getChatWidgetBaseUrl();
  if (!baseUrl) return;
  let widgetUrl;
  try {
    widgetUrl = new URL(baseUrl);
  } catch (error) {
    return;
  }
  widgetUrl.searchParams.delete('employeeId');

  if (employeeId) {
    widgetUrl.searchParams.set('userId', String(employeeId));
  } else {
    widgetUrl.searchParams.delete('userId');
  }

  iframe.src = widgetUrl.toString();
}

function resolvePostLoginConfig(settings = postLoginSettings) {
  const url = settings?.hasCustomUrl
    ? settings.url
    : settings?.url || DEFAULT_POST_LOGIN_URL;
  const token = settings?.hasCustomToken
    ? settings.token
    : settings?.token || DEFAULT_POST_LOGIN_AUTH;
  return {
    url: url || DEFAULT_POST_LOGIN_URL,
    token: token || ''
  };
}

function jsonBlob(payload) {
  const json = JSON.stringify(payload);
  if (typeof Blob === 'function') {
    return new Blob([json], { type: 'application/json' });
  }
  return json;
}

function timeoutFetch(url, options, ms) {
  if (typeof AbortController !== 'function') {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const opts = { ...(options || {}), signal: controller.signal };

  return fetch(url, opts).finally(() => clearTimeout(timer));
}

async function fetchManagerOptions() {
  if (managerOptionsCache) return managerOptionsCache;
  if (managerOptionsPromise) return managerOptionsPromise;

  managerOptionsPromise = (async () => {
    try {
      const res = await apiFetch('/api/manager-users');
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.managers)) {
        managerOptionsCache = data.managers;
        return managerOptionsCache;
      }
    } catch (err) {
      console.error('Failed to load manager options', err);
    }
    managerOptionsCache = [];
    return managerOptionsCache;
  })();

  return managerOptionsPromise;
}

function queuePostLoginSync(employeeId) {
  if (!employeeId) return;
  const normalizedEmployeeId = String(employeeId);
  const body = {
    employeeId: normalizedEmployeeId,
    userId: normalizedEmployeeId
  };

  const sendBeaconFallback = (url) => {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      console.warn('navigator.sendBeacon is unavailable; post-login sync could not be queued.');
      return;
    }

    try {
      console.info('Attempting post-login sync via sendBeacon.', { url, body });
      const queued = navigator.sendBeacon(url, jsonBlob(body));
      if (queued) {
        console.info('Post-login sync queued via sendBeacon.');
      } else {
        console.warn('navigator.sendBeacon failed to queue post-login sync.');
      }
    } catch (error) {
      console.warn('navigator.sendBeacon threw while queuing post-login sync.', error);
    }
  };

  (async () => {
    const resolvedSettings = await loadPostLoginSettings({ silent: true }).catch(() => null);
    const { url, token } = resolvePostLoginConfig(resolvedSettings || postLoginSettings);

    if (typeof fetch !== 'function') {
      sendBeaconFallback(url);
      return;
    }

    try {
      const startTime = Date.now();
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = token;
      }
      console.info('Initiating post-login sync request.', { url, body });
      const response = await timeoutFetch(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          keepalive: true
        },
        POST_LOGIN_TIMEOUT_MS
      );

      if (response.ok) {
        console.info('Post-login sync succeeded.', {
          status: response.status,
          durationMs: Date.now() - startTime
        });
      } else {
        console.warn(`Post-login sync responded with status ${response.status}.`, {
          status: response.status,
          durationMs: Date.now() - startTime
        });
      }
    } catch (error) {
      console.warn('Post-login sync fetch failed; attempting sendBeacon fallback.', {
        error,
        url,
        body
      });
      sendBeaconFallback(url);
    }
  })();
}

function setupTabGroupMenus() {
  const groups = Array.from(document.querySelectorAll('[data-tab-group]'));
  if (!groups.length) return;

  const closeGroup = (group) => {
    group.classList.remove('is-open');
    const toggle = group.querySelector('[data-tab-group-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  };

  const openGroup = (group) => {
    group.classList.add('is-open');
    const toggle = group.querySelector('[data-tab-group-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
  };

  const closeAll = (except = null) => {
    groups.forEach((group) => {
      if (group !== except) closeGroup(group);
    });
  };

  groups.forEach((group) => {
    const toggle = group.querySelector('[data-tab-group-toggle]');
    const menu = group.querySelector('[data-tab-group-menu]');
    if (!toggle || !menu) return;

    toggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const isOpen = group.classList.contains('is-open');
      if (isOpen) {
        closeGroup(group);
      } else {
        closeAll(group);
        openGroup(group);
      }
    });

    menu.addEventListener('click', (ev) => {
      const button = ev.target.closest('button');
      if (!button) return;
      closeAll();
    });
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-tab-group]')) {
      closeAll();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeAll();
    }
  });

  refreshTabGroupVisibility();
}

function refreshTabGroupVisibility() {
  document.querySelectorAll('[data-tab-group]').forEach((group) => {
    const menu = group.querySelector('[data-tab-group-menu]');
    if (!menu) return;
    const hasVisibleButton = Array.from(menu.querySelectorAll('button')).some(
      (btn) => !btn.classList.contains('hidden')
    );
    const toggle = group.querySelector('[data-tab-group-toggle]');
    if (hasVisibleButton) {
      group.classList.remove('tab-group--hidden');
      if (toggle) toggle.removeAttribute('disabled');
    } else {
      group.classList.remove('is-open');
      group.classList.add('tab-group--hidden');
      if (toggle) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('disabled', '');
      }
    }
  });
}

function setRecruitmentPositionQuestions(questions = []) {
  recruitmentPositionQuestions = Array.isArray(questions)
    ? questions.map((q, index) => ({
        id: q?.id || `q${index + 1}`,
        text: q?.text || ''
      }))
    : [];
  renderRecruitmentPositionQuestions();
}

function renderRecruitmentPositionQuestions() {
  const list = document.getElementById('aiQuestionsList');
  if (!list) return;
  if (!recruitmentPositionQuestions.length) {
    list.innerHTML =
      '<p class="text-muted" style="font-style: italic; margin: 0;">No questions yet. Add your own or auto-generate suggestions.</p>';
    return;
  }

  list.innerHTML = recruitmentPositionQuestions
    .map((question, index) => {
      const label = `Question ${index + 1}`;
      const text = escapeHtml(question.text || '');
      return `
        <div class="ai-question-row" data-question-index="${index}">
          <div class="ai-question-row__header">
            <span class="ai-question-row__label">${label}</span>
            <button type="button" class="md-button md-button--text md-button--small" data-action="remove-question" data-question-index="${index}">
              <span class="material-symbols-rounded">delete</span>
              Remove
            </button>
          </div>
          <textarea class="md-textarea" rows="2" data-question-index="${index}" placeholder="Enter the interview question">${text}</textarea>
        </div>
      `;
    })
    .join('');
}

function onAiQuestionListInput(ev) {
  const textarea = ev.target.closest('textarea[data-question-index]');
  if (!textarea) return;
  const index = Number(textarea.getAttribute('data-question-index'));
  if (Number.isNaN(index) || !recruitmentPositionQuestions[index]) return;
  recruitmentPositionQuestions[index].text = textarea.value || '';
}

function onAiQuestionListClick(ev) {
  const removeBtn = ev.target.closest('[data-action="remove-question"]');
  if (removeBtn) {
    const index = Number(removeBtn.getAttribute('data-question-index'));
    if (!Number.isNaN(index)) {
      recruitmentPositionQuestions.splice(index, 1);
      renderRecruitmentPositionQuestions();
    }
  }
}

function onAddAiQuestionClick() {
  recruitmentPositionQuestions.push({
    id: `q${recruitmentPositionQuestions.length + 1}`,
    text: ''
  });
  renderRecruitmentPositionQuestions();
  const list = document.getElementById('aiQuestionsList');
  if (list) {
    const lastTextarea = list.querySelector('textarea:last-of-type');
    if (lastTextarea) lastTextarea.focus();
  }
}

async function onGenerateAiQuestionsClick() {
  const button = document.getElementById('generateAiQuestionsBtn');
  const editingId = recruitmentEditingPositionId;
  if (!editingId) {
    alert('Please save the position first, then click Auto-generate.');
    return;
  }

  const position = recruitmentPositions.find(pos => pos.id == editingId);
  const objectId = position?._id;
  if (!objectId) {
    alert('Please save the position first, then click Auto-generate.');
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'Generating...';
  }

  try {
    const res = await apiFetch(`/api/hr/positions/${objectId}/ai-questions/generate`, {
      method: 'POST'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.questions)) {
      throw new Error('Failed to generate');
    }
    const normalized = data.questions.map((q, index) => ({
      id: q?.id || `q${index + 1}`,
      text: q?.text || ''
    }));
    setRecruitmentPositionQuestions(normalized);
  } catch (err) {
    console.error('Unable to auto-generate interview questions', err);
    alert('Unable to auto-generate questions right now. Please try again later.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Auto-generate with AI';
    }
  }
}

const PIPELINE_STATUSES = ['New', 'Selected for Interview', 'Interview Completed', 'Rejected', 'Hired'];
const POSITION_STATUSES = ['Open', 'Closed'];
const CANDIDATE_CV_HELP_DEFAULT = 'Accepted formats: PDF or Word documents.';
const CANDIDATE_CV_HELP_EDIT = 'Accepted formats: PDF or Word documents. Leave blank to keep the current CV.';
let recruitmentPositions = [];
let recruitmentCandidates = [];
let recruitmentActivePositionId = null;
let recruitmentActiveSubtab = 'pipeline';
let recruitmentInitialized = false;
let recruitmentActiveCommentCandidateId = null;
let recruitmentCandidateComments = [];
let recruitmentEditingCommentId = null;
let recruitmentActiveDetailsCandidateId = null;
let recruitmentEditingPositionId = null;
let recruitmentEditingCandidateId = null;
let recruitmentCandidateSearchTimer = null;
let recruitmentCandidateSearchAbort = null;
let recruitmentCandidateSearchResults = [];
let recruitmentCandidateSearchQuery = '';
let recruitmentCandidateSearchLoading = false;
let recruitmentCandidateSearchError = null;
const candidateCvPreviewUrls = new Map();
const candidateDetailsCache = new Map();
const aiInterviewCache = new Map();
let candidateCvModalCandidateId = null;
let aiCvScreeningTemplate = '';
let recruitmentPositionQuestions = [];
let currentDrawerFields = [];
let hireModalState = { candidateId: null, select: null, previousStatus: null, candidate: null };
let currentHireFields = [];
let activeAiInterviewApplicationId = null;
let profileData = null;
let profileLoading = null;
const DEFAULT_LEAVE_EMAIL_TEMPLATES = {
  requestSubject: 'Leave request from {name}',
  requestBody: '{name} applied for {type} leave from {from} to {to}.',
  approveSubject: 'Leave approved',
  approveBody: '{name}, your leave from {from} to {to} has been approved.',
  rejectSubject: 'Update on your leave request',
  rejectBody: [
    'Hi {name},',
    '',
    'Thank you for submitting your {type} leave request for {from} to {to}. After reviewing the schedule and team coverage, we’re unable to approve it at this time.',
    '',
    '{managerNote}',
    '',
    'If you’d like to discuss alternative dates or have questions, please reply to this email.',
    '',
    'Thank you for your understanding.'
  ].join('\n'),
  cancelSubject: 'Leave cancelled',
  cancelBody: '{name}, your leave from {from} to {to} has been cancelled.'
};
let emailSettings = null;
let emailSettingsLoaded = false;
let emailSettingsLoading = null;
let emailSettingsHasPassword = false;
let emailSettingsHasClientSecret = false;
let emailSettingsHasRefreshToken = false;
let emailRecipientOptions = [];
let aiSettings = null;
let aiSettingsLoaded = false;
let aiSettingsLoading = null;
let chatWidgetSettings = null;
let chatWidgetSettingsLoaded = false;
let chatWidgetSettingsLoading = null;
let postLoginSettings = null;
let postLoginSettingsLoaded = false;
let postLoginSettingsLoading = null;
let aiModelOptions = [
  { value: 'gpt-5', label: 'GPT5' },
  { value: 'gpt-5.1-mini', label: 'GPT5.1 mini' },
  { value: 'gpt-5.1-nano', label: 'GPT5.1nano' }
];

function normalizeCandidateId(value) {
  if (value === null || typeof value === 'undefined') return null;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  return str ? str : null;
}

function formatCandidateSource(source) {
  if (!source) return '';
  const text = String(source).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cacheCandidateDetails(candidate) {
  if (!candidate || candidate.id == null) return null;
  const id = normalizeCandidateId(candidate.id);
  if (id == null) return null;
  const existing = candidateDetailsCache.get(id);
  if (existing) {
    Object.assign(existing, candidate);
    return existing;
  }
  const stored = { ...candidate, id };
  candidateDetailsCache.set(id, stored);
  return stored;
}

function getCachedCandidate(id) {
  const normalized = normalizeCandidateId(id);
  if (normalized == null) return null;
  return recruitmentCandidates.find(candidate => candidate.id == normalized) || candidateDetailsCache.get(normalized) || null;
}

function adaptSearchResultToCandidate(result) {
  if (!result || result.id == null) return null;
  const id = normalizeCandidateId(result.id);
  if (id == null) return null;
  const filename = result.cvFilename || result.cv?.filename || 'CV Document';
  const lower = filename.toLowerCase();
  const contentType = result.cvContentType || result.cv?.contentType || (lower.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
  const candidate = {
    id,
    positionId: result.positionId != null ? normalizeCandidateId(result.positionId) : null,
    name: result.name || '',
    contact: result.contact || '',
    status: result.status || 'New',
    createdAt: result.createdAt || null,
    updatedAt: result.updatedAt || null,
    cv: result.hasCv
      ? { filename, contentType }
      : null,
    commentCount: typeof result.commentCount === 'number' ? result.commentCount : null
  };
  return candidate;
}

document.addEventListener('DOMContentLoaded', () => {
  setupTabGroupMenus();
  const params = new URLSearchParams(window.location.search);
  const aiScreeningPanel = document.getElementById('ai-cv-screening');
  if (aiScreeningPanel) {
    aiCvScreeningTemplate = aiScreeningPanel.innerHTML;
  }
  if (params.get('token')) {
    localStorage.setItem('brillar_token', params.get('token'));
    try {
      currentUser = JSON.parse(decodeURIComponent(params.get('user')));
      localStorage.setItem('brillar_user', JSON.stringify(currentUser));
      queuePostLoginSync(currentUser?.employeeId);
      loadChatWidgetSettings({ force: true, silent: true });
      loadPostLoginSettings({ force: true, silent: true });
    } catch {}
    window.history.replaceState({}, document.title, '/');
  }
  if (!localStorage.getItem('brillar_token')) {
    document.getElementById('loginPage').classList.remove('hidden');
    document.getElementById('logoutBtn').classList.add('hidden');
    document.getElementById('changePassBtn').classList.add('hidden');
    document.getElementById('mainApp').classList.add('hidden');
    updateChatWidgetUser(null);
  } else {
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('logoutBtn').classList.remove('hidden');
    document.getElementById('changePassBtn').classList.remove('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    try {
      currentUser = JSON.parse(localStorage.getItem('brillar_user'));
    } catch {}
    loadChatWidgetSettings({ force: true, silent: true });
    loadPostLoginSettings({ force: true, silent: true });
    toggleTabsByRole();
    init();
  }
});

// Login form logic
document.getElementById('loginForm').onsubmit = async function(ev) {
  ev.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) throw new Error('Login failed');
    const data = await res.json();
    localStorage.setItem('brillar_token', data.token);
    currentUser = data.user;
    localStorage.setItem('brillar_user', JSON.stringify(currentUser));
    queuePostLoginSync(currentUser?.employeeId);
    loadChatWidgetSettings({ force: true, silent: true });
    loadPostLoginSettings({ force: true, silent: true });
    document.getElementById('loginPage').classList.add('hidden');
    document.getElementById('logoutBtn').classList.remove('hidden');
    document.getElementById('changePassBtn').classList.remove('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    toggleTabsByRole();
    init();
  } catch (e) {
    document.getElementById('loginError').textContent = 'Invalid email or password';
    document.getElementById('loginError').classList.remove('hidden');
  }
};

// Microsoft SSO button
const msBtn = document.getElementById('msLoginBtn');
if (msBtn) msBtn.onclick = () => {
  window.location.href = '/auth/microsoft';
};

// Logout logic
function logout() {
  localStorage.removeItem('brillar_token');
  localStorage.removeItem('brillar_user');
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.add('hidden');
  document.getElementById('changePassBtn').classList.add('hidden');
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('tabProfile').classList.add('hidden');
  document.getElementById('tabManage').classList.add('hidden');
  document.getElementById('tabRecruitment').classList.add('hidden');
  document.getElementById('tabManagerApps').classList.add('hidden');
  document.getElementById('tabLeaveReport').classList.add('hidden');
  document.getElementById('tabLearningHub').classList.add('hidden');
  document.getElementById('tabSettings').classList.add('hidden');
  document.getElementById('tabFinance').classList.add('hidden');
  refreshTabGroupVisibility();
  updateChatWidgetUser(null);
  location.reload();
}
window.logout = logout;

const API = window.location.origin;

const PROFILE_SECTION_ICONS = {
  personal: 'person',
  contact: 'call',
  emergency: 'medical_services',
  employment: 'work_history',
  department: 'corporate_fare'
};

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('brillar_token');
  options.headers = options.headers || {};
  if (token) options.headers['Authorization'] = 'Bearer ' + token;
  return fetch(API + path, options);
}

const toastContainer = document.getElementById('toastContainer');
const toastIcons = {
  success: 'check_circle',
  error: 'error',
  warning: 'warning',
  info: 'info'
};

const financeMonthInput = document.getElementById('financeMonth');
const financeRefreshButton = document.getElementById('financeRefresh');
const financeTableBody = document.getElementById('employee-cards');
const financeEmptyState = document.getElementById('financeEmptyState');
const financeSearchInput = document.getElementById('employee-search');
const financeSubtabButtons = document.querySelectorAll('[data-finance-subtab]');
const financeSubtabPanels = {
  employees: document.getElementById('active-employees'),
  payroll: document.getElementById('payrollSummarySection')
};
const recruitmentSubtabButtons = document.querySelectorAll('[data-recruitment-subtab]');
const recruitmentSubtabPanels = {
  search: document.getElementById('recruitmentSearchSection'),
  positions: document.getElementById('recruitmentPositionsSection'),
  pipeline: document.getElementById('recruitmentPipelineSection')
};
const payrollSummaryBody = document.getElementById('payrollSummaryBody');
const payrollSummaryMonth = document.getElementById('payrollSummaryMonth');
const payrollSummaryEmpty = document.getElementById('payrollSummaryEmpty');
const payrollExportButton = document.getElementById('payrollExport');
let financeInitialized = false;
let financeState = { month: '', employees: [], payrollSummary: [] };
let financeLoading = false;
let financeSaving = false;
let financeSavingId = null;
let financeSearchTerm = '';
let financeActiveSubtab = 'employees';

document.addEventListener('DOMContentLoaded', function () {
  var searchInput = document.getElementById('employee-search');
  if (!searchInput) return;

  searchInput.addEventListener('input', function () {
    financeSearchTerm = this.value.trim().toLowerCase();
    applyFinanceSearchFilter();
  });
});

function showToast(message, type = 'info') {
  if (!toastContainer) {
    window.alert(message);
    return;
  }
  const toast = document.createElement('div');
  toast.className = `app-toast app-toast--${type}`;

  const icon = document.createElement('span');
  icon.className = 'material-symbols-rounded';
  icon.textContent = toastIcons[type] || toastIcons.info;

  const text = document.createElement('span');
  text.textContent = message;

  toast.append(icon, text);
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('app-toast--visible'));

  const removeToast = () => {
    toast.classList.remove('app-toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  const duration = Math.min(Math.max(message.length * 50, 3000), 7000);
  const timeoutId = setTimeout(removeToast, duration);
  toast.addEventListener('click', () => {
    clearTimeout(timeoutId);
    removeToast();
  });
}

function setButtonLoading(button, isLoading) {
  if (!(button instanceof HTMLElement)) return;
  if (isLoading) {
    button.dataset.loading = 'true';
    button.classList.add('is-loading');
    button.disabled = true;
  } else if (button.dataset.loading) {
    button.classList.remove('is-loading');
    button.disabled = false;
    delete button.dataset.loading;
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch] || ch));
}

// Tab switching logic
function showPanel(name) {
  const profileBtn = document.getElementById('tabProfile');
  const portalBtn   = document.getElementById('tabPortal');
  const performanceBtn = document.getElementById('tabPerformance');
  const learningHubBtn = document.getElementById('tabLearningHub');
  const learningReportsBtn = document.getElementById('tabLearningReports');
  const learningAdminBtn = document.getElementById('tabLearningAdmin');
  const manageBtn   = document.getElementById('tabManage');
  const recruitmentBtn = document.getElementById('tabRecruitment');
  const managerBtn  = document.getElementById('tabManagerApps');
  const reportBtn   = document.getElementById('tabLeaveReport');
  const locationBtn = document.getElementById('tabLocationInsights');
  const settingsBtn = document.getElementById('tabSettings');
  const financeBtn = document.getElementById('tabFinance');
  const profilePanel = document.getElementById('profilePanel');
  const portalPanel = document.getElementById('portalPanel');
  const performancePanel = document.getElementById('performancePanel');
  const learningHubPanel = document.getElementById('learningHubPanel');
  const learningReportsPanel = document.getElementById('learningReportsPanel');
  const learningAdminPanel = document.getElementById('learningAdminPanel');
  const managePanel = document.getElementById('managePanel');
  const recruitmentPanel = document.getElementById('recruitmentPanel');
  const managerPanel = document.getElementById('managerAppsPanel');
  const reportPanel  = document.getElementById('leaveReportPanel');
  const locationPanel = document.getElementById('locationPanel');
  const settingsPanel = document.getElementById('settingsPanel');
  const financePanel = document.getElementById('financePanel');

  [profileBtn, portalBtn, performanceBtn, learningHubBtn, learningReportsBtn, learningAdminBtn, manageBtn, recruitmentBtn, managerBtn, reportBtn, locationBtn, settingsBtn, financeBtn].forEach(btn =>
 btn && btn.classList.remove('active-tab'));

  if (profilePanel) profilePanel.classList.add('hidden');
  portalPanel.classList.add('hidden');
  if (performancePanel) performancePanel.classList.add('hidden');
  if (learningHubPanel) learningHubPanel.classList.add('hidden');
  if (learningReportsPanel) learningReportsPanel.classList.add('hidden');
  if (learningAdminPanel) learningAdminPanel.classList.add('hidden');
  managePanel.classList.add('hidden');
  recruitmentPanel.classList.add('hidden');
  managerPanel.classList.add('hidden');
  reportPanel.classList.add('hidden');
  if (locationPanel) locationPanel.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  if (financePanel) financePanel.classList.add('hidden');

  if (name === 'profile') {
    if (profilePanel) profilePanel.classList.remove('hidden');
    if (profileBtn) profileBtn.classList.add('active-tab');
    loadMyProfile();
  }
  if (name === 'portal') {
    portalPanel.classList.remove('hidden');
    portalBtn.classList.add('active-tab');
  }
  if (name === 'performance' && performancePanel) {
    performancePanel.classList.remove('hidden');
    if (performanceBtn) performanceBtn.classList.add('active-tab');
    ensurePerformanceExperience();
  }
  if (name === 'learningHub' && learningHubPanel) {
    learningHubPanel.classList.remove('hidden');
    if (learningHubBtn) learningHubBtn.classList.add('active-tab');
    if (learningHubState.initialized) {
      refreshLearningHubData();
    } else {
      initLearningHub();
    }
  }
  if (name === 'learningReports' && learningReportsPanel) {
    learningReportsPanel.classList.remove('hidden');
    if (learningReportsBtn) learningReportsBtn.classList.add('active-tab');
    initLearningReports();
  }
  if (name === 'learningAdmin' && learningAdminPanel) {
    learningAdminPanel.classList.remove('hidden');
    if (learningAdminBtn) learningAdminBtn.classList.add('active-tab');
    initLearningAdmin();
  }
  if (name === 'manage') {
    managePanel.classList.remove('hidden');
    manageBtn.classList.add('active-tab');
  }
  if (name === 'recruitment') {
    recruitmentPanel.classList.remove('hidden');
    recruitmentBtn.classList.add('active-tab');
    if (isManagerRole(currentUser?.role)) {
      if (recruitmentInitialized) {
        loadRecruitmentPositions();
        updateRecruitmentSubtab(recruitmentActiveSubtab);
      } else {
        initRecruitment();
      }
    }
  }
  if (name === 'managerApps') {
    managerPanel.classList.remove('hidden');
    managerBtn.classList.add('active-tab');
    loadManagerApplications();
  }
  if (name === 'leaveReport') {
    reportPanel.classList.remove('hidden');
    reportBtn.classList.add('active-tab');
    loadLeaveReport();
    calendarCurrent = new Date();
    loadLeaveCalendar();
    const cards = document.getElementById('leaveRangeCards');
    if (cards) cards.innerHTML = '';
  }
  if (name === 'location') {
    if (locationPanel) locationPanel.classList.remove('hidden');
    if (locationBtn) locationBtn.classList.add('active-tab');
    loadLocationInsights();
  }
  if (name === 'settings') {
    settingsPanel.classList.remove('hidden');
    if (settingsBtn) settingsBtn.classList.add('active-tab');
    if (isManagerRole(currentUser?.role)) {
      loadHolidays();
      loadEmailSettingsConfig();
      loadAiSettingsConfig();
      loadChatWidgetSettings();
      loadPostLoginSettings();
    }
  }
  if (name === 'finance' && financePanel) {
    financePanel.classList.remove('hidden');
    if (financeBtn) financeBtn.classList.add('active-tab');
    if (isSuperAdmin(currentUser)) {
      setupFinanceModule();
      loadFinanceData();
    }
  }

  const primaryTabSelect = document.getElementById('primaryTabSelect');
  if (primaryTabSelect && (name === 'profile' || name === 'portal' || name === 'performance')) {
    primaryTabSelect.value = name;
  }
}

// Role-based tab display
function toggleTabsByRole() {
  const profileTab = document.getElementById('tabProfile');
  if (profileTab) profileTab.classList.remove('hidden');
  const manageTab = document.getElementById('tabManage');
  const recruitmentTab = document.getElementById('tabRecruitment');
  const managerAppsTab = document.getElementById('tabManagerApps');
  const leaveReportTab = document.getElementById('tabLeaveReport');
  const locationTab = document.getElementById('tabLocationInsights');
  const settingsTab = document.getElementById('tabSettings');
  const financeTab = document.getElementById('tabFinance');
  const learningHubTab = document.getElementById('tabLearningHub');
  const learningReportsTab = document.getElementById('tabLearningReports');
  const learningAdminTab = document.getElementById('tabLearningAdmin');

  const managerVisible = isManagerRole(currentUser?.role);
  const superAdminVisible = isSuperAdmin(currentUser);
  const learningAdminVisible = isLearningAdminRole(currentUser?.role);
  const learningReportsVisible = isLearningReportRole(currentUser?.role);

  [manageTab, recruitmentTab, managerAppsTab, leaveReportTab, locationTab, settingsTab].forEach(tab => {
    if (!tab) return;
    tab.classList.toggle('hidden', !managerVisible);
  });

  if (financeTab) {
    financeTab.classList.toggle('hidden', !superAdminVisible);
  }

  if (learningHubTab) {
    learningHubTab.classList.remove('hidden');
  }

  if (learningReportsTab) {
    learningReportsTab.classList.toggle('hidden', !learningReportsVisible);
  }

  if (learningAdminTab) {
    learningAdminTab.classList.toggle('hidden', !learningAdminVisible);
  }

  refreshTabGroupVisibility();
}

// ----------- LEARNING HUB -----------
const learningHubState = {
  courses: [],
  modulesByCourse: new Map(),
  lessonsByModule: new Map(),
  playbackByLesson: new Map(),
  progress: {
    courses: new Map(),
    modules: new Map(),
    lessons: new Map()
  },
  selectedCourseId: null,
  selectedModuleId: null,
  selectedLessonId: null,
  initialized: false,
  loading: {
    courses: false,
    modules: false,
    lessons: false,
    playback: false
  },
  progressTracking: {
    activeLessonId: null,
    lastWatchPercent: 0,
    lastWatchSentAt: 0,
    pendingWatchUpdate: false,
    pendingCompletionUpdate: false
  }
};

function learningHubFetch(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (!headers.Accept) {
    headers.Accept = 'application/json';
  }
  return fetch(path, {
    ...options,
    headers,
    credentials: 'include'
  });
}

function setLearningHubStatus(message = '') {
  const statusEl = document.getElementById('learningHubStatus');
  if (!statusEl) return;
  if (!message) {
    statusEl.textContent = '';
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
}

function updateLearningHubSummary() {
  const courseCountEl = document.getElementById('learningHubCourseCount');
  const overallProgressEl = document.getElementById('learningHubOverallProgress');
  const updatedAtEl = document.getElementById('learningHubUpdatedAt');
  if (courseCountEl) {
    courseCountEl.textContent = `Courses: ${learningHubState.courses.length}`;
  }
  if (overallProgressEl) {
    const progressValues = learningHubState.courses
      .map(course => resolveCourseProgress(course.id))
      .filter(val => Number.isFinite(val));
    const overall = progressValues.length
      ? Math.round(progressValues.reduce((sum, val) => sum + val, 0) / progressValues.length)
      : 0;
    overallProgressEl.textContent = `Overall: ${overall}%`;
  }
  if (updatedAtEl) {
    updatedAtEl.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  }
}

function normalizeProgressCollection(collection, idKeys) {
  const map = new Map();
  if (Array.isArray(collection)) {
    collection.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const idKey = idKeys.find(key => item[key]);
      const id = idKey ? item[idKey] : null;
      if (!id) return;
      map.set(String(id), item);
    });
    return map;
  }
  if (collection && typeof collection === 'object') {
    Object.entries(collection).forEach(([key, value]) => {
      if (value && typeof value === 'object') {
        map.set(String(key), { id: key, ...value });
      } else {
        map.set(String(key), { id: key, progress: value });
      }
    });
  }
  return map;
}

function splitProgressEntries(payload) {
  const grouped = { courses: [], modules: [], lessons: [] };
  if (Array.isArray(payload)) {
    payload.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      if (entry.progressType === 'course') grouped.courses.push(entry);
      if (entry.progressType === 'module') grouped.modules.push(entry);
      if (entry.progressType === 'lesson') grouped.lessons.push(entry);
    });
    return grouped;
  }
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.courses) || Array.isArray(payload.modules) || Array.isArray(payload.lessons)) {
      grouped.courses = Array.isArray(payload.courses) ? payload.courses : [];
      grouped.modules = Array.isArray(payload.modules) ? payload.modules : [];
      grouped.lessons = Array.isArray(payload.lessons) ? payload.lessons : [];
      return grouped;
    }
  }
  return grouped;
}

function normalizeLearningItems(items, idKeys) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const id = idKeys.map(key => item[key]).find(val => val !== undefined && val !== null);
    if (!id) return null;
    return { ...item, id };
  }).filter(Boolean);
}

function normalizePlaybackAssets(playback) {
  const assets = Array.isArray(playback?.assets) ? playback.assets : [];
  const legacyAssets = [];
  const legacyMaterials = Array.isArray(playback?.readingMaterials) ? playback.readingMaterials : [];
  const legacyDocuments = Array.isArray(playback?.documents) ? playback.documents : [];

  [...legacyMaterials, ...legacyDocuments].forEach(material => {
    if (!material || typeof material !== 'object') return;
    legacyAssets.push({
      title: material.title || material.name || material.label,
      url: material.url || material.link,
      metadata: {
        mimeType: material.mimeType
      },
      playback: {
        type: 'direct',
        url: material.url || material.link
      }
    });
  });

  return [...assets, ...legacyAssets];
}

function resolveAssetUrl(asset) {
  return (
    asset?.playback?.streamUrl ||
    asset?.playback?.url ||
    asset?.playback?.embedUrl ||
    asset?.url ||
    ''
  );
}

function resolveAssetLabel(asset) {
  return asset?.title || asset?.name || asset?.label || asset?.description || 'Lesson asset';
}

function resolveAssetTypeLabel(asset) {
  const playbackType = asset?.playback?.type;
  if (playbackType === 'youtube') return 'YouTube';
  if (playbackType === 'onedrive') return 'OneDrive';
  if (playbackType === 'direct') return 'Link';
  if (asset?.metadata?.mimeType) return asset.metadata.mimeType;
  return '';
}

function looksLikeVideoUrl(url = '') {
  return /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/.test(url);
}

function isVideoAsset(asset) {
  const playbackType = asset?.playback?.type;
  if (playbackType === 'youtube') return true;
  const mime = asset?.metadata?.mimeType || '';
  if (mime.startsWith('video/')) return true;
  const url = resolveAssetUrl(asset);
  if (playbackType === 'direct' || playbackType === 'onedrive') {
    return looksLikeVideoUrl(url);
  }
  return false;
}

function toPercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (value <= 1) return Math.round(value * 100);
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) return numeric > 1 ? Math.round(numeric) : Math.round(numeric * 100);
  }
  return null;
}

function extractProgress(entry) {
  if (!entry) return null;
  if (typeof entry === 'number' || typeof entry === 'string') {
    return toPercent(entry);
  }
  const direct =
    entry.progress ??
    entry.completion ??
    entry.percent ??
    entry.percentage ??
    entry.completionRate;
  const directPercent = toPercent(direct);
  if (directPercent !== null) return directPercent;
  if (entry.completed || entry.status === 'completed') return 100;
  if (entry.status === 'in_progress') return 50;
  return null;
}

function resolveCourseProgress(courseId) {
  const direct = extractProgress(learningHubState.progress.courses.get(String(courseId)));
  if (direct !== null) return direct;
  const modules = learningHubState.modulesByCourse.get(String(courseId)) || [];
  const values = modules
    .map(module => resolveModuleProgress(module.id))
    .filter(val => Number.isFinite(val));
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, val) => sum + val, 0) / values.length);
}

function resolveModuleProgress(moduleId) {
  const direct = extractProgress(learningHubState.progress.modules.get(String(moduleId)));
  if (direct !== null) return direct;
  return calculateModuleProgressFromLessons(moduleId);
}

function resolveLessonProgress(lessonId) {
  const direct = extractProgress(learningHubState.progress.lessons.get(String(lessonId)));
  if (direct !== null) return direct;
  return 0;
}

function resolveProgressStatus(progress) {
  if (progress >= 100) return 'Completed';
  if (progress > 0) return 'In progress';
  return 'Not started';
}

function calculateModuleProgressFromLessons(moduleId) {
  const lessons = learningHubState.lessonsByModule.get(String(moduleId)) || [];
  const values = lessons
    .map(lesson => resolveLessonProgress(lesson.id))
    .filter(val => Number.isFinite(val));
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, val) => sum + val, 0) / values.length);
}

function calculateCourseProgressFromModules(courseId) {
  const modules = learningHubState.modulesByCourse.get(String(courseId)) || [];
  const values = modules
    .map(module => resolveModuleProgress(module.id))
    .filter(val => Number.isFinite(val));
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, val) => sum + val, 0) / values.length);
}

function resolveLessonStatus(lessonId) {
  const entry = learningHubState.progress.lessons.get(String(lessonId));
  const percent = resolveLessonProgress(lessonId);
  if (entry?.completed || entry?.status === 'completed' || percent >= 100) {
    return 'Completed';
  }
  if (entry?.status === 'in_progress' || percent > 0) {
    return 'In progress';
  }
  return 'Not started';
}

function upsertProgressEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  if (entry.progressType === 'course' && entry.courseId) {
    learningHubState.progress.courses.set(String(entry.courseId), entry);
  }
  if (entry.progressType === 'module' && entry.moduleId) {
    learningHubState.progress.modules.set(String(entry.moduleId), entry);
  }
  if (entry.progressType === 'lesson' && entry.lessonId) {
    learningHubState.progress.lessons.set(String(entry.lessonId), entry);
  }
}

function applyProgressPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.progress) {
    upsertProgressEntry(payload.progress);
  }
  if (payload.moduleRollup) {
    upsertProgressEntry(payload.moduleRollup);
  }
  if (payload.courseRollup) {
    upsertProgressEntry(payload.courseRollup);
  }
}

function buildRequirementBadge(isRequired) {
  const badge = document.createElement('span');
  badge.className = `learning-badge ${isRequired ? 'learning-badge--required' : 'learning-badge--optional'}`;
  badge.textContent = isRequired ? 'Required' : 'Optional';
  return badge;
}

function buildStatusBadge(status) {
  const badge = document.createElement('span');
  const normalized = (status || '').toLowerCase();
  let variant = 'not-started';
  if (normalized === 'completed') variant = 'completed';
  if (normalized === 'in progress') variant = 'progress';
  badge.className = `learning-badge learning-badge--status learning-badge--status-${variant}`;
  badge.textContent = status;
  return badge;
}

function renderProgressBar(barId, textId, percent) {
  const bar = document.getElementById(barId);
  const text = document.getElementById(textId);
  const safePercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
  if (bar) bar.style.width = `${safePercent}%`;
  if (text) text.textContent = `${safePercent}%`;
}

function renderCourseList() {
  const list = document.getElementById('learningCourseList');
  const empty = document.getElementById('learningCourseEmpty');
  if (!list) return;
  list.innerHTML = '';

  if (!learningHubState.courses.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  learningHubState.courses.forEach(course => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'learning-list-item';
    if (String(course.id) === String(learningHubState.selectedCourseId)) {
      button.classList.add('learning-list-item--active');
    }
    button.dataset.courseId = course.id;

    const title = document.createElement('div');
    title.className = 'learning-list-title';
    title.innerHTML = `
      <span>${escapeHtml(course.title || course.name || 'Untitled course')}</span>
    `;
    title.appendChild(buildRequirementBadge(course.required ?? course.isRequired ?? course.assignmentRequired));

    const meta = document.createElement('div');
    meta.className = 'learning-list-meta';
    const progress = resolveCourseProgress(course.id);
    const statusLabel = resolveProgressStatus(progress);
    meta.innerHTML = `<span>${statusLabel}</span><span>•</span><span>${progress}% complete</span>`;

    const status = document.createElement('div');
    status.className = 'learning-progress-inline';
    status.innerHTML = `
      <div class="learning-progress-bar">
        <div class="learning-progress-fill" style="width: ${progress}%;"></div>
      </div>
      <span class="learning-progress-text">${progress}%</span>
    `;

    button.append(title, meta, status);
    list.appendChild(button);
  });
}

function renderCourseDetails() {
  const title = document.getElementById('learningCourseTitle');
  const meta = document.getElementById('learningCourseMeta');
  const course = learningHubState.courses.find(item => String(item.id) === String(learningHubState.selectedCourseId));
  if (title) {
    title.textContent = course
      ? (course.title || course.name || 'Course details')
      : 'Select a course to view modules and lessons.';
  }
  const badges = document.getElementById('learningCourseBadges');
  if (badges) {
    badges.innerHTML = '';
    if (course) {
      badges.appendChild(buildRequirementBadge(course.required ?? course.isRequired ?? course.assignmentRequired));
      badges.appendChild(buildStatusBadge(resolveProgressStatus(resolveCourseProgress(course.id))));
    }
  }
  if (meta) {
    meta.innerHTML = '';
    if (course) {
      const duration = course.duration || course.estimatedDuration || course.length;
      const modulesCount = learningHubState.modulesByCourse.get(String(course.id))?.length ?? 0;
      const items = [];
      if (duration) items.push(`Duration: ${duration}`);
      if (Number.isFinite(modulesCount)) items.push(`Modules: ${modulesCount}`);
      if (course.category) items.push(`Category: ${course.category}`);
      meta.textContent = items.join(' • ');
    }
  }
  renderProgressBar('learningCourseProgressBar', 'learningCourseProgressText', course ? resolveCourseProgress(course.id) : 0);
}

function renderModuleList() {
  const list = document.getElementById('learningModuleList');
  if (!list) return;
  list.innerHTML = '';
  const modules = learningHubState.modulesByCourse.get(String(learningHubState.selectedCourseId)) || [];

  modules.forEach(module => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'learning-list-item';
    if (String(module.id) === String(learningHubState.selectedModuleId)) {
      button.classList.add('learning-list-item--active');
    }
    button.dataset.moduleId = module.id;

    const title = document.createElement('div');
    title.className = 'learning-list-title';
    title.innerHTML = `
      <span>${escapeHtml(module.title || module.name || 'Module')}</span>
    `;
    title.appendChild(buildRequirementBadge(module.required ?? module.isRequired ?? module.assignmentRequired));

    const meta = document.createElement('div');
    meta.className = 'learning-list-meta';
    const progress = resolveModuleProgress(module.id);
    const statusLabel = resolveProgressStatus(progress);
    meta.innerHTML = `<span>${statusLabel}</span><span>•</span><span>${progress}% complete</span>`;

    const status = document.createElement('div');
    status.className = 'learning-progress-inline';
    status.innerHTML = `
      <div class="learning-progress-bar">
        <div class="learning-progress-fill" style="width: ${progress}%;"></div>
      </div>
      <span class="learning-progress-text">${progress}%</span>
    `;

    button.append(title, meta, status);
    list.appendChild(button);
  });
}

function renderLessonList() {
  const list = document.getElementById('learningLessonList');
  if (!list) return;
  list.innerHTML = '';
  const lessons = learningHubState.lessonsByModule.get(String(learningHubState.selectedModuleId)) || [];

  lessons.forEach(lesson => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'learning-list-item';
    if (String(lesson.id) === String(learningHubState.selectedLessonId)) {
      button.classList.add('learning-list-item--active');
    }
    button.dataset.lessonId = lesson.id;

    const title = document.createElement('div');
    title.className = 'learning-list-title';
    title.innerHTML = `
      <span>${escapeHtml(lesson.title || lesson.name || 'Lesson')}</span>
    `;
    title.appendChild(buildRequirementBadge(lesson.required ?? lesson.isRequired ?? lesson.assignmentRequired));

    const meta = document.createElement('div');
    meta.className = 'learning-list-meta';
    const progress = resolveLessonProgress(lesson.id);
    meta.textContent = `${resolveLessonStatus(lesson.id)} • ${progress}%`;

    const status = document.createElement('div');
    status.className = 'learning-progress-inline';
    status.innerHTML = `
      <div class="learning-progress-bar">
        <div class="learning-progress-fill" style="width: ${progress}%;"></div>
      </div>
      <span class="learning-progress-text">${progress}%</span>
    `;

    button.append(title, meta, status);
    list.appendChild(button);
  });
}

function renderLessonPlayer() {
  const lesson = findCurrentLesson();
  const title = document.getElementById('learningLessonTitle');
  if (title) {
    title.textContent = lesson
      ? (lesson.title || lesson.name || 'Lesson player')
      : 'Select a lesson to start playback.';
  }
  const lessonMeta = document.getElementById('learningLessonMeta');
  if (lessonMeta) {
    lessonMeta.innerHTML = '';
    if (lesson) {
      lessonMeta.appendChild(buildRequirementBadge(lesson.required ?? lesson.isRequired ?? lesson.assignmentRequired));
      lessonMeta.appendChild(buildStatusBadge(resolveLessonStatus(lesson.id)));
    }
  }

  renderProgressBar('learningLessonProgressBar', 'learningLessonProgressText', lesson ? resolveLessonProgress(lesson.id) : 0);
  renderProgressBar('learningModuleProgressBar', 'learningModuleProgressText', learningHubState.selectedModuleId ? resolveModuleProgress(learningHubState.selectedModuleId) : 0);

  const activeLessonId = lesson?.id ? String(lesson.id) : null;
  if (learningHubState.progressTracking.activeLessonId !== activeLessonId) {
    learningHubState.progressTracking.activeLessonId = activeLessonId;
    learningHubState.progressTracking.lastWatchPercent = 0;
    learningHubState.progressTracking.lastWatchSentAt = 0;
  }

  const playback = lesson ? learningHubState.playbackByLesson.get(String(lesson.id)) : null;
  const video = document.getElementById('learningVideo');
  const embed = document.getElementById('learningVideoEmbed');
  const placeholder = document.getElementById('learningVideoPlaceholder');
  const assets = normalizePlaybackAssets(playback);
  const videoAsset = assets.find(isVideoAsset);
  const videoSrc = videoAsset ? resolveAssetUrl(videoAsset) : '';
  const isYouTube = videoAsset?.playback?.type === 'youtube';

  if (video && embed && placeholder) {
    if (videoAsset && isYouTube && videoSrc) {
      embed.src = videoSrc;
      embed.classList.remove('hidden');
      video.classList.add('hidden');
      video.removeAttribute('src');
      placeholder.classList.add('hidden');
    } else if (videoAsset && videoSrc) {
      video.src = videoSrc;
      video.classList.remove('hidden');
      embed.classList.add('hidden');
      embed.removeAttribute('src');
      placeholder.classList.add('hidden');
    } else {
      video.removeAttribute('src');
      embed.removeAttribute('src');
      video.classList.add('hidden');
      embed.classList.add('hidden');
      placeholder.classList.remove('hidden');
    }
  }

  const readingList = document.getElementById('learningReadingList');
  if (readingList) {
    readingList.innerHTML = '';
    if (!assets.length) {
      const item = document.createElement('div');
      item.className = 'text-muted';
      item.textContent = 'No lesson assets for this lesson.';
      readingList.appendChild(item);
    } else {
      assets.forEach(asset => {
        const href = resolveAssetUrl(asset);
        const link = document.createElement(href ? 'a' : 'div');
        link.className = 'learning-reading-item';
        if (href) {
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener';
        }
        const icon = isVideoAsset(asset) ? 'play_circle' : 'description';
        const typeLabel = resolveAssetTypeLabel(asset);
        link.innerHTML = `
          <span class="material-symbols-rounded">${icon}</span>
          <span class="learning-asset-title">${escapeHtml(resolveAssetLabel(asset))}</span>
          ${typeLabel ? `<span class="learning-asset-type">${escapeHtml(typeLabel)}</span>` : ''}
        `;
        readingList.appendChild(link);
      });
    }
  }

  const markComplete = document.getElementById('learningMarkComplete');
  if (markComplete) {
    if (!lesson) {
      markComplete.disabled = true;
      markComplete.textContent = 'Mark complete';
      markComplete.title = 'Select a lesson to enable completion.';
    } else {
      const status = resolveLessonStatus(lesson.id);
      const isCompleted = status === 'Completed';
      markComplete.disabled = isCompleted;
      markComplete.textContent = isCompleted ? 'Completed' : 'Mark complete';
      markComplete.title = isCompleted ? 'Lesson already completed.' : 'Mark this lesson as complete.';
    }
  }
}

function findCurrentLesson() {
  if (!learningHubState.selectedLessonId) return null;
  const lessons = learningHubState.lessonsByModule.get(String(learningHubState.selectedModuleId)) || [];
  return lessons.find(item => String(item.id) === String(learningHubState.selectedLessonId)) || null;
}

function updateLearningHubUI() {
  renderCourseList();
  renderCourseDetails();
  renderModuleList();
  renderLessonList();
  renderLessonPlayer();
  updateLearningHubSummary();
}

async function loadLearningHubProgress() {
  try {
    const res = await learningHubFetch('/api/learning-hub/progress');
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Your session has expired. Please sign in again to access the Learning Hub.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    const grouped = splitProgressEntries(data);
    learningHubState.progress.courses = normalizeProgressCollection(grouped.courses, ['courseId', 'id']);
    learningHubState.progress.modules = normalizeProgressCollection(grouped.modules, ['moduleId', 'id']);
    learningHubState.progress.lessons = normalizeProgressCollection(grouped.lessons, ['lessonId', 'id']);
    setLearningHubStatus('');
  } catch (error) {
    console.error('Failed to load learning hub progress', error);
    setLearningHubStatus('Unable to load progress right now. Please try again later.');
  }
}

async function loadLearningHubCourses() {
  if (learningHubState.loading.courses) return;
  learningHubState.loading.courses = true;
  try {
    const filter = document.getElementById('learningCourseFilter')?.value || 'assigned';
    const query = new URLSearchParams({ filter });
    const res = await learningHubFetch(`/api/learning-hub/courses?${query.toString()}`);
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Access denied for learning courses. Please reauthenticate.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    const rawCourses = Array.isArray(data.courses) ? data.courses : (Array.isArray(data) ? data : []);
    learningHubState.courses = normalizeLearningItems(rawCourses, ['id', 'courseId', '_id']);
    setLearningHubStatus('');
    if (!learningHubState.courses.length) {
      learningHubState.selectedCourseId = null;
      learningHubState.selectedModuleId = null;
      learningHubState.selectedLessonId = null;
      updateLearningHubUI();
      return;
    }
    if (!learningHubState.selectedCourseId || !learningHubState.courses.some(course => String(course.id) === String(learningHubState.selectedCourseId))) {
      learningHubState.selectedCourseId = learningHubState.courses[0].id;
    }
    await loadCourseModules(learningHubState.selectedCourseId);
    updateLearningHubUI();
  } catch (error) {
    console.error('Failed to load learning hub courses', error);
    setLearningHubStatus('Unable to load courses right now. Please try again later.');
  } finally {
    learningHubState.loading.courses = false;
  }
}

async function loadCourseModules(courseId) {
  if (!courseId || learningHubState.loading.modules) return;
  learningHubState.loading.modules = true;
  try {
    const res = await learningHubFetch(`/api/learning-hub/courses/${courseId}/modules`);
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Access denied for course modules. Please reauthenticate.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    const rawModules = Array.isArray(data.modules) ? data.modules : (Array.isArray(data) ? data : []);
    const modules = normalizeLearningItems(rawModules, ['id', 'moduleId', '_id']);
    learningHubState.modulesByCourse.set(String(courseId), modules);
    learningHubState.selectedModuleId = modules[0]?.id || null;
    if (learningHubState.selectedModuleId) {
      await loadModuleLessons(learningHubState.selectedModuleId);
    }
  } catch (error) {
    console.error('Failed to load learning hub modules', error);
    setLearningHubStatus('Unable to load modules right now. Please try again later.');
  } finally {
    learningHubState.loading.modules = false;
  }
}

async function loadModuleLessons(moduleId) {
  if (!moduleId || learningHubState.loading.lessons) return;
  learningHubState.loading.lessons = true;
  try {
    const res = await learningHubFetch(`/api/learning-hub/modules/${moduleId}/lessons`);
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Access denied for lessons. Please reauthenticate.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    const rawLessons = Array.isArray(data.lessons) ? data.lessons : (Array.isArray(data) ? data : []);
    const lessons = normalizeLearningItems(rawLessons, ['id', 'lessonId', '_id']);
    learningHubState.lessonsByModule.set(String(moduleId), lessons);
    learningHubState.selectedLessonId = lessons[0]?.id || null;
    if (learningHubState.selectedLessonId) {
      await loadLessonPlayback(learningHubState.selectedLessonId);
    }
  } catch (error) {
    console.error('Failed to load learning hub lessons', error);
    setLearningHubStatus('Unable to load lessons right now. Please try again later.');
  } finally {
    learningHubState.loading.lessons = false;
  }
}

async function loadLessonPlayback(lessonId) {
  if (!lessonId || learningHubState.loading.playback) return;
  learningHubState.loading.playback = true;
  try {
    const res = await learningHubFetch(`/api/learning-hub/lessons/${lessonId}/playback`);
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Access denied for lesson playback. Please reauthenticate.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    learningHubState.playbackByLesson.set(String(lessonId), data);
  } catch (error) {
    console.error('Failed to load learning hub playback', error);
    setLearningHubStatus('Unable to load lesson playback right now. Please try again later.');
  } finally {
    learningHubState.loading.playback = false;
  }
}

function refreshLearningHubData() {
  return Promise.all([loadLearningHubProgress(), loadLearningHubCourses()]).then(updateLearningHubUI);
}

async function recordLessonCompletion(lessonId) {
  if (!lessonId || learningHubState.progressTracking.pendingCompletionUpdate) return;
  learningHubState.progressTracking.pendingCompletionUpdate = true;
  try {
    const res = await learningHubFetch(`/api/learning-hub/progress/lessons/${lessonId}/completion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Access denied for completion tracking. Please reauthenticate.');
      return;
    }
    if (!res.ok) {
      setLearningHubStatus('Unable to update completion right now. Please try again.');
      return;
    }
    const data = await res.json().catch(() => ({}));
    applyProgressPayload(data);
    updateLearningHubUI();
  } catch (error) {
    console.error('Failed to record lesson completion', error);
    setLearningHubStatus('Unable to update completion right now. Please try again later.');
  } finally {
    learningHubState.progressTracking.pendingCompletionUpdate = false;
  }
}

async function recordLessonWatchProgress(lessonId, percent) {
  if (!lessonId || learningHubState.progressTracking.pendingWatchUpdate) return;
  if (!Number.isFinite(percent)) return;
  learningHubState.progressTracking.pendingWatchUpdate = true;
  try {
    const res = await learningHubFetch(`/api/learning-hub/progress/lessons/${lessonId}/watch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ videoWatchPercent: percent })
    });
    if (res.status === 401 || res.status === 403) {
      setLearningHubStatus('Access denied for watch tracking. Please reauthenticate.');
      return;
    }
    if (!res.ok) {
      return;
    }
    const data = await res.json().catch(() => ({}));
    applyProgressPayload(data);
    updateLearningHubUI();
  } catch (error) {
    console.error('Failed to record watch progress', error);
  } finally {
    learningHubState.progressTracking.pendingWatchUpdate = false;
  }
}

function handleVideoProgressUpdate(event) {
  const video = event.target;
  const lessonId = learningHubState.progressTracking.activeLessonId;
  if (!lessonId || !video) return;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;
  const percent = Math.min(100, Math.max(0, Math.round((video.currentTime / video.duration) * 100)));
  if (!Number.isFinite(percent) || percent < 1) return;

  const now = Date.now();
  const lastPercent = learningHubState.progressTracking.lastWatchPercent;
  const lastSentAt = learningHubState.progressTracking.lastWatchSentAt;
  const percentDelta = percent - lastPercent;
  const timeDelta = now - lastSentAt;

  if (percent < 100 && percentDelta < 5 && timeDelta < 15000) {
    return;
  }

  learningHubState.progressTracking.lastWatchPercent = percent;
  learningHubState.progressTracking.lastWatchSentAt = now;
  recordLessonWatchProgress(lessonId, percent);
}

function handleVideoEnded(event) {
  const lessonId = learningHubState.progressTracking.activeLessonId;
  if (!lessonId) return;
  learningHubState.progressTracking.lastWatchPercent = 100;
  learningHubState.progressTracking.lastWatchSentAt = Date.now();
  recordLessonWatchProgress(lessonId, 100);
}

async function selectCourse(courseId) {
  if (!courseId) return;
  learningHubState.selectedCourseId = courseId;
  const modules = learningHubState.modulesByCourse.get(String(courseId));
  if (!modules) {
    await loadCourseModules(courseId);
  } else {
    learningHubState.selectedModuleId = modules[0]?.id || null;
    if (learningHubState.selectedModuleId) {
      await selectModule(learningHubState.selectedModuleId);
    }
  }
  updateLearningHubUI();
}

async function selectModule(moduleId) {
  if (!moduleId) return;
  learningHubState.selectedModuleId = moduleId;
  const lessons = learningHubState.lessonsByModule.get(String(moduleId));
  if (!lessons) {
    await loadModuleLessons(moduleId);
  } else {
    learningHubState.selectedLessonId = lessons[0]?.id || null;
    if (learningHubState.selectedLessonId) {
      await selectLesson(learningHubState.selectedLessonId);
    }
  }
  updateLearningHubUI();
}

async function selectLesson(lessonId) {
  if (!lessonId) return;
  learningHubState.selectedLessonId = lessonId;
  if (!learningHubState.playbackByLesson.get(String(lessonId))) {
    await loadLessonPlayback(lessonId);
  }
  updateLearningHubUI();
}

function getOrderedLessons() {
  return learningHubState.lessonsByModule.get(String(learningHubState.selectedModuleId)) || [];
}

function navigateLesson(direction) {
  const lessons = getOrderedLessons();
  const index = lessons.findIndex(item => String(item.id) === String(learningHubState.selectedLessonId));
  if (index === -1) return;
  const nextIndex = direction === 'next' ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= lessons.length) return;
  selectLesson(lessons[nextIndex].id);
}

function initLearningHub() {
  if (learningHubState.initialized) return;
  learningHubState.initialized = true;

  const courseList = document.getElementById('learningCourseList');
  const moduleList = document.getElementById('learningModuleList');
  const lessonList = document.getElementById('learningLessonList');
  const filter = document.getElementById('learningCourseFilter');
  const prevBtn = document.getElementById('learningPrevLesson');
  const nextBtn = document.getElementById('learningNextLesson');
  const markBtn = document.getElementById('learningMarkComplete');
  const video = document.getElementById('learningVideo');

  if (filter) {
    filter.addEventListener('change', () => {
      learningHubState.selectedCourseId = null;
      learningHubState.selectedModuleId = null;
      learningHubState.selectedLessonId = null;
      refreshLearningHubData();
    });
  }

  if (courseList) {
    courseList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-course-id]');
      if (!button) return;
      selectCourse(button.dataset.courseId);
    });
  }

  if (moduleList) {
    moduleList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-module-id]');
      if (!button) return;
      selectModule(button.dataset.moduleId);
    });
  }

  if (lessonList) {
    lessonList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-lesson-id]');
      if (!button) return;
      selectLesson(button.dataset.lessonId);
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => navigateLesson('prev'));
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => navigateLesson('next'));
  }
  if (markBtn) {
    markBtn.addEventListener('click', () => {
      const lesson = findCurrentLesson();
      if (!lesson) return;
      recordLessonCompletion(lesson.id);
    });
  }

  if (video) {
    video.addEventListener('timeupdate', handleVideoProgressUpdate);
    video.addEventListener('ended', handleVideoEnded);
  }

  refreshLearningHubData();
}

// ----------- LEARNING HUB ADMIN -----------
const learningAdminState = {
  courses: [],
  modulesByCourse: new Map(),
  lessonsByModule: new Map(),
  selectedCourseId: null,
  selectedModuleId: null,
  selectedLessonId: null,
  employees: [],
  initialized: false,
  loading: {
    courses: false,
    modules: false,
    lessons: false,
    employees: false,
    assets: false
  }
};

function setLearningAdminStatus(message = '') {
  const statusEl = document.getElementById('learningAdminStatus');
  if (!statusEl) return;
  if (!message) {
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
}

function setLearningAdminAccessState(isAllowed) {
  const gate = document.getElementById('learningAdminGate');
  const grid = document.getElementById('learningAdminGrid');
  if (gate) gate.classList.toggle('hidden', isAllowed);
  if (grid) grid.classList.toggle('hidden', !isAllowed);
}

function handleLearningAdminAuthFailure(res) {
  if (res.status === 401 || res.status === 403) {
    setLearningAdminStatus('Access denied. Please sign in with HR/L&D credentials.');
    setLearningAdminAccessState(false);
    return true;
  }
  return false;
}

function learningAdminFetch(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (!headers.Accept) headers.Accept = 'application/json';
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(path, {
    ...options,
    headers,
    credentials: 'include'
  });
}

function resetLearningAdminCourseForm() {
  const form = document.getElementById('learningAdminCourseForm');
  if (!form) return;
  form.reset();
  document.getElementById('learningAdminCourseId').value = '';
  document.getElementById('learningAdminCourseStatus').value = 'draft';
}

function resetLearningAdminModuleForm() {
  const form = document.getElementById('learningAdminModuleForm');
  if (!form) return;
  form.reset();
  document.getElementById('learningAdminModuleId').value = '';
}

function resetLearningAdminLessonForm() {
  const form = document.getElementById('learningAdminLessonForm');
  if (!form) return;
  form.reset();
  document.getElementById('learningAdminLessonId').value = '';
}

function renderLearningAdminCourses() {
  const list = document.getElementById('learningAdminCourseList');
  if (!list) return;
  list.innerHTML = '';
  if (!learningAdminState.courses.length) {
    list.innerHTML = '<p class="learning-admin-helper">No courses yet. Create the first course to begin.</p>';
    return;
  }
  learningAdminState.courses.forEach(course => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'learning-admin-item';
    if (String(course.id) === String(learningAdminState.selectedCourseId)) {
      button.classList.add('learning-admin-item--active');
    }
    button.dataset.courseId = course.id;
    const status = escapeHtml(course.status || 'draft');
    const summary = course.summary ? escapeHtml(course.summary) : 'No summary provided.';
    button.innerHTML = `
      <div class="learning-admin-item-header">
        <div class="learning-admin-item-title">
          <span>${escapeHtml(course.title || 'Untitled course')}</span>
        </div>
        <span class="learning-badge">${status}</span>
      </div>
      <div class="learning-admin-meta">
        <span>${summary}</span>
      </div>
    `;
    button.addEventListener('click', () => selectLearningAdminCourse(course.id));
    list.appendChild(button);
  });
}

function renderLearningAdminModules() {
  const list = document.getElementById('learningAdminModuleList');
  if (!list) return;
  list.innerHTML = '';
  const modules = learningAdminState.modulesByCourse.get(String(learningAdminState.selectedCourseId)) || [];
  if (!modules.length) {
    list.innerHTML = '<p class="learning-admin-helper">No modules yet. Add a module to structure the course.</p>';
    return;
  }
  modules.forEach(module => {
    const item = document.createElement('div');
    item.className = 'learning-admin-item';
    item.dataset.moduleId = module.id;
    item.draggable = true;
    if (String(module.id) === String(learningAdminState.selectedModuleId)) {
      item.classList.add('learning-admin-item--active');
    }
    const requiredBadge = module.required
      ? '<span class="learning-badge learning-badge--required">Required</span>'
      : '<span class="learning-badge learning-badge--optional">Optional</span>';
    item.innerHTML = `
      <div class="learning-admin-item-header">
        <div class="learning-admin-item-title">
          <span class="learning-admin-drag material-symbols-rounded">drag_indicator</span>
          <span>${escapeHtml(module.title || 'Untitled module')}</span>
        </div>
        ${requiredBadge}
      </div>
      <div class="learning-admin-meta">
        <span>${escapeHtml(module.summary || 'No summary')}</span>
      </div>
    `;
    item.addEventListener('click', () => selectLearningAdminModule(module.id));
    list.appendChild(item);
  });
}

function renderLearningAdminLessons() {
  const list = document.getElementById('learningAdminLessonList');
  if (!list) return;
  list.innerHTML = '';
  const lessons = learningAdminState.lessonsByModule.get(String(learningAdminState.selectedModuleId)) || [];
  if (!lessons.length) {
    list.innerHTML = '<p class="learning-admin-helper">No lessons yet. Add a lesson to begin.</p>';
    return;
  }
  lessons.forEach(lesson => {
    const item = document.createElement('div');
    item.className = 'learning-admin-item';
    item.dataset.lessonId = lesson.id;
    item.draggable = true;
    if (String(lesson.id) === String(learningAdminState.selectedLessonId)) {
      item.classList.add('learning-admin-item--active');
    }
    const requiredBadge = lesson.required
      ? '<span class="learning-badge learning-badge--required">Required</span>'
      : '<span class="learning-badge learning-badge--optional">Optional</span>';
    item.innerHTML = `
      <div class="learning-admin-item-header">
        <div class="learning-admin-item-title">
          <span class="learning-admin-drag material-symbols-rounded">drag_indicator</span>
          <span>${escapeHtml(lesson.title || 'Untitled lesson')}</span>
        </div>
        ${requiredBadge}
      </div>
      <div class="learning-admin-meta">
        <span>${escapeHtml(lesson.summary || 'No summary')}</span>
      </div>
    `;
    item.addEventListener('click', () => selectLearningAdminLesson(lesson.id));
    list.appendChild(item);
  });
}

function renderLearningAdminAssets() {
  const list = document.getElementById('learningAdminAssetList');
  if (!list) return;
  list.innerHTML = '';
  const lesson = resolveLearningAdminLesson();
  const assets = lesson?.assets || [];
  if (!assets.length) {
    list.innerHTML = '<p class="learning-admin-helper">No assets attached yet.</p>';
    return;
  }
  assets.forEach(asset => {
    const item = document.createElement('div');
    item.className = 'learning-admin-asset-item';
    const label = escapeHtml(asset.title || asset.label || asset.name || 'Untitled asset');
    const type = escapeHtml(asset.provider || asset.type || 'asset');
    const link = asset.url
      || asset.link
      || asset.playback?.embedUrl
      || asset.playback?.streamUrl
      || asset.playback?.url
      || '';
    const url = escapeHtml(link || '#');
    item.innerHTML = `
      <strong>${label}</strong>
      <span class="learning-admin-meta">${type}</span>
      ${link ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` : '<span class="learning-admin-meta">Link pending</span>'}
    `;
    list.appendChild(item);
  });
}

function populateLearningAdminCourseForm(course) {
  if (!course) return;
  document.getElementById('learningAdminCourseId').value = course.id || '';
  document.getElementById('learningAdminCourseTitle').value = course.title || '';
  document.getElementById('learningAdminCourseSummary').value = course.summary || '';
  document.getElementById('learningAdminCourseDescription').value = course.description || '';
  document.getElementById('learningAdminCourseStatus').value = course.status || 'draft';
}

function populateLearningAdminModuleForm(module) {
  if (!module) return;
  document.getElementById('learningAdminModuleId').value = module.id || '';
  document.getElementById('learningAdminModuleTitle').value = module.title || '';
  document.getElementById('learningAdminModuleSummary').value = module.summary || '';
  document.getElementById('learningAdminModuleDescription').value = module.description || '';
  document.getElementById('learningAdminModuleRequired').checked = Boolean(module.required);
}

function populateLearningAdminLessonForm(lesson) {
  if (!lesson) return;
  document.getElementById('learningAdminLessonId').value = lesson.id || '';
  document.getElementById('learningAdminLessonTitle').value = lesson.title || '';
  document.getElementById('learningAdminLessonSummary').value = lesson.summary || '';
  document.getElementById('learningAdminLessonDescription').value = lesson.description || '';
  document.getElementById('learningAdminLessonRequired').checked = Boolean(lesson.required);
}

function updateLearningAdminAssignmentOptions() {
  const courseSelect = document.getElementById('learningAdminAssignmentCourse');
  if (!courseSelect) return;
  courseSelect.innerHTML = '<option value="">-- select course --</option>';
  learningAdminState.courses.forEach(course => {
    courseSelect.add(new Option(course.title || `Course ${course.id}`, course.id));
  });
  if (learningAdminState.selectedCourseId) {
    courseSelect.value = learningAdminState.selectedCourseId;
  }
}

function updateLearningAdminEmployeesSelect() {
  const select = document.getElementById('learningAdminAssignmentEmployees');
  if (!select) return;
  select.innerHTML = '';
  learningAdminState.employees.forEach(emp => {
    select.add(new Option(emp.name || emp.fullName || `Employee ${emp.id}`, emp.id));
  });
}

function resolveLearningAdminLesson() {
  if (!learningAdminState.selectedLessonId) return null;
  const lessons = learningAdminState.lessonsByModule.get(String(learningAdminState.selectedModuleId)) || [];
  return lessons.find(item => String(item.id) === String(learningAdminState.selectedLessonId)) || null;
}

async function loadLearningAdminCourses() {
  if (learningAdminState.loading.courses) return;
  learningAdminState.loading.courses = true;
  try {
    const res = await learningAdminFetch('/api/learning-hub/courses');
    if (handleLearningAdminAuthFailure(res)) return;
    const data = await res.json();
    const rawCourses = Array.isArray(data) ? data : data.courses || [];
    learningAdminState.courses = normalizeLearningItems(rawCourses, ['id', 'courseId', '_id']);
    if (!learningAdminState.courses.length) {
      learningAdminState.selectedCourseId = null;
      learningAdminState.selectedModuleId = null;
      learningAdminState.selectedLessonId = null;
    } else if (!learningAdminState.selectedCourseId) {
      learningAdminState.selectedCourseId = learningAdminState.courses[0].id;
    }
    const selectedCourse = learningAdminState.courses.find(item => String(item.id) === String(learningAdminState.selectedCourseId));
    if (selectedCourse) {
      populateLearningAdminCourseForm(selectedCourse);
    } else {
      resetLearningAdminCourseForm();
    }
    renderLearningAdminCourses();
    updateLearningAdminAssignmentOptions();
    if (learningAdminState.selectedCourseId) {
      await loadLearningAdminModules(learningAdminState.selectedCourseId);
    }
  } catch (error) {
    console.error('Failed to load learning admin courses', error);
    setLearningAdminStatus('Unable to load courses. Please try again.');
  } finally {
    learningAdminState.loading.courses = false;
  }
}

async function loadLearningAdminModules(courseId) {
  if (!courseId || learningAdminState.loading.modules) return;
  learningAdminState.loading.modules = true;
  try {
    const res = await learningAdminFetch(`/api/learning-hub/courses/${courseId}/modules`);
    if (handleLearningAdminAuthFailure(res)) return;
    const data = await res.json();
    const rawModules = Array.isArray(data) ? data : data.modules || [];
    const modules = normalizeLearningItems(rawModules, ['id', 'moduleId', '_id']);
    learningAdminState.modulesByCourse.set(String(courseId), modules);
    learningAdminState.selectedModuleId = modules[0]?.id || null;
    const selectedModule = modules.find(item => String(item.id) === String(learningAdminState.selectedModuleId));
    if (selectedModule) {
      populateLearningAdminModuleForm(selectedModule);
    } else {
      resetLearningAdminModuleForm();
    }
    renderLearningAdminModules();
    if (learningAdminState.selectedModuleId) {
      await loadLearningAdminLessons(learningAdminState.selectedModuleId);
    } else {
      learningAdminState.selectedLessonId = null;
      resetLearningAdminLessonForm();
      renderLearningAdminLessons();
      renderLearningAdminAssets();
    }
  } catch (error) {
    console.error('Failed to load learning admin modules', error);
    setLearningAdminStatus('Unable to load modules. Please try again.');
  } finally {
    learningAdminState.loading.modules = false;
  }
}

async function loadLearningAdminLessons(moduleId) {
  if (!moduleId || learningAdminState.loading.lessons) return;
  learningAdminState.loading.lessons = true;
  try {
    const res = await learningAdminFetch(`/api/learning-hub/modules/${moduleId}/lessons`);
    if (handleLearningAdminAuthFailure(res)) return;
    const data = await res.json();
    const rawLessons = Array.isArray(data) ? data : data.lessons || [];
    const lessons = normalizeLearningItems(rawLessons, ['id', 'lessonId', '_id']);
    learningAdminState.lessonsByModule.set(String(moduleId), lessons);
    learningAdminState.selectedLessonId = lessons[0]?.id || null;
    const selectedLesson = lessons.find(item => String(item.id) === String(learningAdminState.selectedLessonId));
    if (selectedLesson) {
      populateLearningAdminLessonForm(selectedLesson);
    } else {
      resetLearningAdminLessonForm();
    }
    renderLearningAdminLessons();
    if (learningAdminState.selectedLessonId) {
      await loadLearningAdminAssets(learningAdminState.selectedLessonId);
    } else {
      renderLearningAdminAssets();
    }
  } catch (error) {
    console.error('Failed to load learning admin lessons', error);
    setLearningAdminStatus('Unable to load lessons. Please try again.');
  } finally {
    learningAdminState.loading.lessons = false;
  }
}

async function loadLearningAdminAssets(lessonId) {
  if (!lessonId || learningAdminState.loading.assets) return;
  learningAdminState.loading.assets = true;
  try {
    const res = await learningAdminFetch(`/api/learning-hub/lessons/${lessonId}/playback`);
    if (handleLearningAdminAuthFailure(res)) return;
    const data = await res.json();
    const lesson = resolveLearningAdminLesson();
    if (lesson && Array.isArray(data.assets)) {
      lesson.assets = data.assets;
    }
    renderLearningAdminAssets();
  } catch (error) {
    console.error('Failed to load lesson assets', error);
    setLearningAdminStatus('Unable to load lesson assets.');
  } finally {
    learningAdminState.loading.assets = false;
  }
}

async function loadLearningAdminEmployees() {
  if (learningAdminState.loading.employees) return;
  learningAdminState.loading.employees = true;
  try {
    const res = await learningAdminFetch('/employees');
    if (handleLearningAdminAuthFailure(res)) return;
    if (!res.ok) {
      setLearningAdminStatus('Unable to load employee list.');
      return;
    }
    const employees = await res.json();
    learningAdminState.employees = Array.isArray(employees) ? employees : [];
    updateLearningAdminEmployeesSelect();
  } catch (error) {
    console.error('Failed to load employee list for learning admin', error);
    setLearningAdminStatus('Unable to load employee list.');
  } finally {
    learningAdminState.loading.employees = false;
  }
}

function selectLearningAdminCourse(courseId) {
  learningAdminState.selectedCourseId = courseId;
  const course = learningAdminState.courses.find(item => String(item.id) === String(courseId));
  if (course) {
    populateLearningAdminCourseForm(course);
  }
  renderLearningAdminCourses();
  updateLearningAdminAssignmentOptions();
  if (courseId) {
    loadLearningAdminModules(courseId);
  }
}

function selectLearningAdminModule(moduleId) {
  learningAdminState.selectedModuleId = moduleId;
  const modules = learningAdminState.modulesByCourse.get(String(learningAdminState.selectedCourseId)) || [];
  const module = modules.find(item => String(item.id) === String(moduleId));
  if (module) {
    populateLearningAdminModuleForm(module);
  }
  renderLearningAdminModules();
  if (moduleId) {
    loadLearningAdminLessons(moduleId);
  }
}

function selectLearningAdminLesson(lessonId) {
  learningAdminState.selectedLessonId = lessonId;
  const lessons = learningAdminState.lessonsByModule.get(String(learningAdminState.selectedModuleId)) || [];
  const lesson = lessons.find(item => String(item.id) === String(lessonId));
  if (lesson) {
    populateLearningAdminLessonForm(lesson);
  }
  renderLearningAdminLessons();
  if (lessonId) {
    loadLearningAdminAssets(lessonId);
  } else {
    renderLearningAdminAssets();
  }
}

function syncLearningAdminOrder(listEl, type) {
  if (!listEl) return [];
  const ids = [...listEl.querySelectorAll('[data-module-id], [data-lesson-id]')].map(el =>
    type === 'modules' ? el.dataset.moduleId : el.dataset.lessonId
  );
  if (!ids.length) return [];
  if (type === 'modules') {
    const modules = learningAdminState.modulesByCourse.get(String(learningAdminState.selectedCourseId)) || [];
    const ordered = ids.map(id => modules.find(item => String(item.id) === String(id))).filter(Boolean);
    learningAdminState.modulesByCourse.set(String(learningAdminState.selectedCourseId), ordered);
    return ordered;
  }
  const lessons = learningAdminState.lessonsByModule.get(String(learningAdminState.selectedModuleId)) || [];
  const ordered = ids.map(id => lessons.find(item => String(item.id) === String(id))).filter(Boolean);
  learningAdminState.lessonsByModule.set(String(learningAdminState.selectedModuleId), ordered);
  return ordered;
}

async function persistLearningAdminModuleOrder() {
  const courseId = learningAdminState.selectedCourseId;
  const modules = learningAdminState.modulesByCourse.get(String(courseId)) || [];
  if (!modules.length) return;
  try {
    const res = await learningAdminFetch(`/api/learning-hub/courses/${courseId}/modules/reorder`, {
      method: 'POST',
      body: JSON.stringify({
        orderedModuleIds: modules.map(module => module.id)
      })
    });
    if (handleLearningAdminAuthFailure(res)) return;
    if (!res.ok) {
      setLearningAdminStatus('Unable to save module ordering.');
    }
  } catch (error) {
    console.error('Failed to persist module order', error);
    setLearningAdminStatus('Unable to save module ordering.');
  }
}

async function persistLearningAdminLessonOrder() {
  const moduleId = learningAdminState.selectedModuleId;
  const lessons = learningAdminState.lessonsByModule.get(String(moduleId)) || [];
  if (!lessons.length) return;
  try {
    const res = await learningAdminFetch(`/api/learning-hub/modules/${moduleId}/lessons/reorder`, {
      method: 'POST',
      body: JSON.stringify({
        orderedLessonIds: lessons.map(lesson => lesson.id)
      })
    });
    if (handleLearningAdminAuthFailure(res)) return;
    if (!res.ok) {
      setLearningAdminStatus('Unable to save lesson ordering.');
    }
  } catch (error) {
    console.error('Failed to persist lesson order', error);
    setLearningAdminStatus('Unable to save lesson ordering.');
  }
}

function enableLearningAdminDrag(listEl, type) {
  if (!listEl) return;
  let draggedItem = null;
  listEl.addEventListener('dragstart', event => {
    const target = event.target.closest('.learning-admin-item');
    if (!target) return;
    draggedItem = target;
    target.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  listEl.addEventListener('dragover', event => {
    event.preventDefault();
    const target = event.target.closest('.learning-admin-item');
    if (!target || target === draggedItem) return;
    const rect = target.getBoundingClientRect();
    const shouldPlaceAfter = (event.clientY - rect.top) > rect.height / 2;
    if (shouldPlaceAfter) {
      target.after(draggedItem);
    } else {
      target.before(draggedItem);
    }
  });
  listEl.addEventListener('drop', event => {
    event.preventDefault();
    if (!draggedItem) return;
    draggedItem.classList.remove('is-dragging');
    const ordered = syncLearningAdminOrder(listEl, type);
    if (type === 'modules') {
      renderLearningAdminModules();
      persistLearningAdminModuleOrder(ordered);
    } else {
      renderLearningAdminLessons();
      persistLearningAdminLessonOrder(ordered);
    }
    draggedItem = null;
  });
  listEl.addEventListener('dragend', () => {
    if (draggedItem) {
      draggedItem.classList.remove('is-dragging');
    }
    draggedItem = null;
  });
}

async function onLearningAdminCourseSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('learningAdminCourseId').value;
  const payload = {
    id: id || undefined,
    title: document.getElementById('learningAdminCourseTitle').value.trim(),
    summary: document.getElementById('learningAdminCourseSummary').value.trim(),
    description: document.getElementById('learningAdminCourseDescription').value.trim(),
    status: document.getElementById('learningAdminCourseStatus').value
  };
  if (!payload.title) {
    setLearningAdminStatus('Course title is required.');
    return;
  }
  try {
    const res = await learningAdminFetch(id ? `/api/learning-hub/courses/${id}` : '/api/learning-hub/courses', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    if (handleLearningAdminAuthFailure(res)) return;
    await loadLearningAdminCourses();
    setLearningAdminStatus('');
  } catch (error) {
    console.error('Failed to save course', error);
    setLearningAdminStatus('Unable to save course.');
  }
}

async function onLearningAdminCourseAction(action) {
  const courseId = document.getElementById('learningAdminCourseId').value;
  if (!courseId) {
    setLearningAdminStatus('Select a course first.');
    return;
  }
  try {
    const res = await learningAdminFetch(`/api/learning-hub/courses/${courseId}/${action}`, {
      method: 'PATCH'
    });
    if (handleLearningAdminAuthFailure(res)) return;
    await loadLearningAdminCourses();
    setLearningAdminStatus('');
  } catch (error) {
    console.error(`Failed to ${action} course`, error);
    setLearningAdminStatus(`Unable to ${action} course.`);
  }
}

async function onLearningAdminModuleSubmit(event) {
  event.preventDefault();
  if (!learningAdminState.selectedCourseId) {
    setLearningAdminStatus('Select a course before adding modules.');
    return;
  }
  const id = document.getElementById('learningAdminModuleId').value;
  const payload = {
    id: id || undefined,
    courseId: learningAdminState.selectedCourseId,
    title: document.getElementById('learningAdminModuleTitle').value.trim(),
    summary: document.getElementById('learningAdminModuleSummary').value.trim(),
    description: document.getElementById('learningAdminModuleDescription').value.trim(),
    required: document.getElementById('learningAdminModuleRequired').checked
  };
  if (!payload.title) {
    setLearningAdminStatus('Module title is required.');
    return;
  }
  try {
    const res = await learningAdminFetch(
      id ? `/api/learning-hub/modules/${id}` : `/api/learning-hub/courses/${learningAdminState.selectedCourseId}/modules`,
      {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      }
    );
    if (handleLearningAdminAuthFailure(res)) return;
    await loadLearningAdminModules(learningAdminState.selectedCourseId);
    setLearningAdminStatus('');
  } catch (error) {
    console.error('Failed to save module', error);
    setLearningAdminStatus('Unable to save module.');
  }
}

async function onLearningAdminLessonSubmit(event) {
  event.preventDefault();
  if (!learningAdminState.selectedModuleId) {
    setLearningAdminStatus('Select a module before adding lessons.');
    return;
  }
  const id = document.getElementById('learningAdminLessonId').value;
  const payload = {
    id: id || undefined,
    moduleId: learningAdminState.selectedModuleId,
    title: document.getElementById('learningAdminLessonTitle').value.trim(),
    summary: document.getElementById('learningAdminLessonSummary').value.trim(),
    description: document.getElementById('learningAdminLessonDescription').value.trim(),
    required: document.getElementById('learningAdminLessonRequired').checked
  };
  if (!payload.title) {
    setLearningAdminStatus('Lesson title is required.');
    return;
  }
  try {
    const res = await learningAdminFetch(
      id ? `/api/learning-hub/lessons/${id}` : `/api/learning-hub/modules/${learningAdminState.selectedModuleId}/lessons`,
      {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      }
    );
    if (handleLearningAdminAuthFailure(res)) return;
    await loadLearningAdminLessons(learningAdminState.selectedModuleId);
    setLearningAdminStatus('');
  } catch (error) {
    console.error('Failed to save lesson', error);
    setLearningAdminStatus('Unable to save lesson.');
  }
}

async function onLearningAdminAssetSubmit(event) {
  event.preventDefault();
  if (!learningAdminState.selectedLessonId) {
    setLearningAdminStatus('Select a lesson before attaching assets.');
    return;
  }
  const payload = {
    lessonId: learningAdminState.selectedLessonId,
    title: document.getElementById('learningAdminAssetLabel').value.trim(),
    provider: document.getElementById('learningAdminAssetType').value,
    url: document.getElementById('learningAdminAssetUrl').value.trim()
  };
  if (!payload.url) {
    setLearningAdminStatus('Asset URL is required.');
    return;
  }
  try {
    const res = await learningAdminFetch(`/api/learning-hub/lessons/${learningAdminState.selectedLessonId}/assets`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (handleLearningAdminAuthFailure(res)) return;
    const lesson = resolveLearningAdminLesson();
    if (lesson) {
      if (!Array.isArray(lesson.assets)) lesson.assets = [];
      lesson.assets.push({ ...payload });
    }
    document.getElementById('learningAdminAssetForm').reset();
    renderLearningAdminAssets();
    setLearningAdminStatus('');
  } catch (error) {
    console.error('Failed to add lesson asset', error);
    setLearningAdminStatus('Unable to add lesson asset.');
  }
}

async function onLearningAdminAssignmentSubmit(event) {
  event.preventDefault();
  const courseId = document.getElementById('learningAdminAssignmentCourse').value || learningAdminState.selectedCourseId;
  if (!courseId) {
    setLearningAdminStatus('Select a course to assign.');
    return;
  }
  const roleValue = document.getElementById('learningAdminAssignmentRole').value;
  const employeeSelect = document.getElementById('learningAdminAssignmentEmployees');
  const employeeIds = employeeSelect ? Array.from(employeeSelect.selectedOptions).map(opt => opt.value) : [];
  if (!roleValue && !employeeIds.length) {
    setLearningAdminStatus('Select a role or employees for assignment.');
    return;
  }
  const payload = {
    courseId,
    roles: roleValue ? [roleValue] : [],
    employeeIds
  };
  try {
    const res = await learningAdminFetch('/api/learning-hub/assignments', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (handleLearningAdminAuthFailure(res)) return;
    setLearningAdminStatus('Assignments saved.');
  } catch (error) {
    console.error('Failed to save assignments', error);
    setLearningAdminStatus('Unable to save assignments.');
  }
}

function initLearningAdmin() {
  if (learningAdminState.initialized) return;
  learningAdminState.initialized = true;
  const hasAccess = isLearningAdminRole(currentUser?.role);
  setLearningAdminAccessState(hasAccess);
  if (!hasAccess) {
    setLearningAdminStatus('Access denied. Please sign in with HR/L&D credentials.');
    return;
  }

  const courseForm = document.getElementById('learningAdminCourseForm');
  const moduleForm = document.getElementById('learningAdminModuleForm');
  const lessonForm = document.getElementById('learningAdminLessonForm');
  const assetForm = document.getElementById('learningAdminAssetForm');
  const assignmentForm = document.getElementById('learningAdminAssignmentForm');
  const newCourseBtn = document.getElementById('learningAdminNewCourse');
  const newModuleBtn = document.getElementById('learningAdminNewModule');
  const newLessonBtn = document.getElementById('learningAdminNewLesson');
  const publishBtn = document.getElementById('learningAdminPublishCourse');
  const archiveBtn = document.getElementById('learningAdminArchiveCourse');
  const moduleList = document.getElementById('learningAdminModuleList');
  const lessonList = document.getElementById('learningAdminLessonList');
  const assignmentCourseSelect = document.getElementById('learningAdminAssignmentCourse');

  if (courseForm) courseForm.addEventListener('submit', onLearningAdminCourseSubmit);
  if (moduleForm) moduleForm.addEventListener('submit', onLearningAdminModuleSubmit);
  if (lessonForm) lessonForm.addEventListener('submit', onLearningAdminLessonSubmit);
  if (assetForm) assetForm.addEventListener('submit', onLearningAdminAssetSubmit);
  if (assignmentForm) assignmentForm.addEventListener('submit', onLearningAdminAssignmentSubmit);
  if (newCourseBtn) newCourseBtn.addEventListener('click', () => {
    learningAdminState.selectedCourseId = null;
    learningAdminState.selectedModuleId = null;
    learningAdminState.selectedLessonId = null;
    resetLearningAdminCourseForm();
    renderLearningAdminCourses();
    updateLearningAdminAssignmentOptions();
    renderLearningAdminModules();
    renderLearningAdminLessons();
    renderLearningAdminAssets();
  });
  if (newModuleBtn) newModuleBtn.addEventListener('click', () => {
    learningAdminState.selectedModuleId = null;
    learningAdminState.selectedLessonId = null;
    resetLearningAdminModuleForm();
    renderLearningAdminModules();
    renderLearningAdminLessons();
    renderLearningAdminAssets();
  });
  if (newLessonBtn) newLessonBtn.addEventListener('click', () => {
    learningAdminState.selectedLessonId = null;
    resetLearningAdminLessonForm();
    renderLearningAdminLessons();
    renderLearningAdminAssets();
  });
  if (publishBtn) publishBtn.addEventListener('click', () => onLearningAdminCourseAction('publish'));
  if (archiveBtn) archiveBtn.addEventListener('click', () => onLearningAdminCourseAction('archive'));
  if (assignmentCourseSelect) {
    assignmentCourseSelect.addEventListener('change', event => {
      const courseId = event.target.value;
      if (courseId) {
        selectLearningAdminCourse(courseId);
      }
    });
  }

  enableLearningAdminDrag(moduleList, 'modules');
  enableLearningAdminDrag(lessonList, 'lessons');

  resetLearningAdminCourseForm();
  resetLearningAdminModuleForm();
  resetLearningAdminLessonForm();
  loadLearningAdminCourses();
  loadLearningAdminEmployees();
}

// ----------- LEARNING REPORTS -----------
const learningReportsState = {
  initialized: false,
  loading: false,
  updatedAt: null,
  data: {
    roles: [],
    overdueCount: 0,
    byCourse: [],
    overdue: [],
    team: []
  }
};

function setLearningReportsStatus(message = '') {
  const statusEl = document.getElementById('learningReportsStatus');
  if (!statusEl) return;
  if (!message) {
    statusEl.textContent = '';
    statusEl.classList.add('hidden');
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.remove('hidden');
}

function formatRoleLabel(role) {
  const normalized = normalizeRole(role);
  if (!normalized) return 'Unknown';
  if (normalized === 'hr') return 'HR';
  if (normalized === 'human resources') return 'Human Resources';
  if (['l&d', 'ld', 'lnd'].includes(normalized)) return 'L&D';
  return normalized.replace(/\b\w/g, char => char.toUpperCase());
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function formatPercent(value) {
  return `${roundToOneDecimal(clampPercent(value))}%`;
}

function updateLearningReportsSummary() {
  const roleCountEl = document.getElementById('learningReportsRoleCount');
  const teamCountEl = document.getElementById('learningReportsTeamCount');
  const avgCompletionEl = document.getElementById('learningReportsAvgCompletion');
  const overdueCountEl = document.getElementById('learningReportsOverdueCount');
  const updatedAtEl = document.getElementById('learningReportsUpdatedAt');

  const roles = learningReportsState.data.roles || [];
  const team = learningReportsState.data.team || [];
  const overdueCount = Number(learningReportsState.data.overdueCount || 0);
  const avgCompletion = team.length
    ? roundToOneDecimal(team.reduce((sum, entry) => sum + clampPercent(entry.completionRate), 0) / team.length)
    : 0;

  if (roleCountEl) roleCountEl.textContent = `Roles: ${roles.length}`;
  if (teamCountEl) teamCountEl.textContent = `Team: ${team.length}`;
  if (avgCompletionEl) avgCompletionEl.textContent = `Avg Completion: ${avgCompletion}%`;
  if (overdueCountEl) overdueCountEl.textContent = `Overdue: ${overdueCount}`;
  if (updatedAtEl) {
    const ts = learningReportsState.updatedAt;
    updatedAtEl.textContent = ts ? `Updated: ${ts.toLocaleString()}` : 'Updated: --';
  }
}

function updateLearningReportsDashboards() {
  const roleValueEl = document.getElementById('learningReportsRoleDashboardValue');
  const roleMetaEl = document.getElementById('learningReportsRoleDashboardMeta');
  const overdueValueEl = document.getElementById('learningReportsOverdueDashboardValue');
  const overdueMetaEl = document.getElementById('learningReportsOverdueDashboardMeta');
  const teamValueEl = document.getElementById('learningReportsTeamDashboardValue');
  const teamMetaEl = document.getElementById('learningReportsTeamDashboardMeta');

  const roles = Array.isArray(learningReportsState.data.roles)
    ? [...learningReportsState.data.roles]
    : [];
  const team = Array.isArray(learningReportsState.data.team)
    ? [...learningReportsState.data.team]
    : [];
  const overdueCount = Number(learningReportsState.data.overdueCount || 0);
  const byCourse = Array.isArray(learningReportsState.data.byCourse)
    ? [...learningReportsState.data.byCourse]
    : [];

  if (roleValueEl) {
    const avgCompletion = roles.length
      ? roundToOneDecimal(roles.reduce((sum, role) => sum + clampPercent(role.completionRate), 0) / roles.length)
      : 0;
    roleValueEl.textContent = `Avg ${avgCompletion}%`;
  }
  if (roleMetaEl) {
    if (!roles.length) {
      roleMetaEl.textContent = 'Top role: --';
    } else {
      const topRole = roles.reduce((best, role) => {
        const current = clampPercent(role.completionRate);
        const bestValue = clampPercent(best?.completionRate);
        return current > bestValue ? role : best;
      }, roles[0]);
      roleMetaEl.textContent = `Top role: ${formatRoleLabel(topRole.role)} (${formatPercent(topRole.completionRate)})`;
    }
  }

  if (overdueValueEl) {
    overdueValueEl.textContent = `Overdue ${overdueCount}`;
  }
  if (overdueMetaEl) {
    if (!overdueCount) {
      overdueMetaEl.textContent = 'All mandatory learning on track.';
    } else if (byCourse.length) {
      byCourse.sort((a, b) => (b.overdueCount || 0) - (a.overdueCount || 0));
      overdueMetaEl.textContent = `Most overdue: ${byCourse[0]?.courseTitle || 'Untitled Course'}`;
    } else {
      overdueMetaEl.textContent = 'Review overdue assignments.';
    }
  }

  if (teamValueEl) {
    const onTrack = team.filter(member => clampPercent(member.completionRate) >= 80).length;
    teamValueEl.textContent = `On track ${onTrack}/${team.length}`;
  }
  if (teamMetaEl) {
    if (!team.length) {
      teamMetaEl.textContent = 'At risk 0';
    } else {
      const atRisk = team.filter(member => clampPercent(member.completionRate) < 50).length;
      teamMetaEl.textContent = `At risk ${atRisk}`;
    }
  }
}

function renderLearningReportRoles() {
  const list = document.getElementById('learningReportsRoleList');
  if (!list) return;
  const roles = Array.isArray(learningReportsState.data.roles)
    ? [...learningReportsState.data.roles]
    : [];
  if (!roles.length) {
    list.innerHTML = '<p class="text-muted" style="font-style: italic;">No role assignments found.</p>';
    return;
  }
  roles.sort((a, b) => clampPercent(b.completionRate) - clampPercent(a.completionRate));
  list.innerHTML = roles.map(role => {
    const completionRate = clampPercent(role.completionRate);
    return `
      <div class="learning-report-item">
        <div class="learning-report-metric">
          <span>${escapeHtml(formatRoleLabel(role.role))}</span>
          <span>${formatPercent(completionRate)}</span>
        </div>
        <div class="learning-report-progress">
          <span style="width: ${completionRate}%;"></span>
        </div>
        <div class="learning-report-meta">
          ${role.completed || 0} completed · ${role.inProgress || 0} in progress · ${role.notStarted || 0} not started
        </div>
        <div class="learning-report-meta">${role.totalAssignments || 0} assignments</div>
      </div>
    `;
  }).join('');
}

function renderLearningReportOverdue() {
  const list = document.getElementById('learningReportsOverdueList');
  const summary = document.getElementById('learningReportsOverdueSummary');
  if (!list || !summary) return;
  const overdueCount = Number(learningReportsState.data.overdueCount || 0);
  const byCourse = Array.isArray(learningReportsState.data.byCourse)
    ? [...learningReportsState.data.byCourse]
    : [];

  summary.textContent = overdueCount
    ? `${overdueCount} mandatory assignment${overdueCount === 1 ? '' : 's'} overdue.`
    : 'No overdue mandatory assignments.';
  summary.classList.toggle('learning-report-highlight--ok', overdueCount === 0);

  if (!byCourse.length) {
    list.innerHTML = '<p class="text-muted" style="font-style: italic;">No overdue courses to review.</p>';
    return;
  }

  byCourse.sort((a, b) => (b.overdueCount || 0) - (a.overdueCount || 0));
  list.innerHTML = byCourse.map(course => `
    <div class="learning-report-item">
      <div class="learning-report-metric">
        <span>${escapeHtml(course.courseTitle || 'Untitled Course')}</span>
        <span>${course.overdueCount || 0} overdue</span>
      </div>
      <div class="learning-report-meta">Course ID: ${escapeHtml(course.courseId || '-')}</div>
    </div>
  `).join('');
}

function renderLearningReportTeam() {
  const list = document.getElementById('learningReportsTeamList');
  if (!list) return;
  const team = Array.isArray(learningReportsState.data.team)
    ? [...learningReportsState.data.team]
    : [];
  if (!team.length) {
    list.innerHTML = '<p class="text-muted" style="font-style: italic;">No team progress data available.</p>';
    return;
  }
  team.sort((a, b) => clampPercent(b.completionRate) - clampPercent(a.completionRate));
  list.innerHTML = team.map(member => {
    const completionRate = clampPercent(member.completionRate);
    const name = member.employeeName || `Employee ${member.employeeId || ''}`.trim();
    const roleLabel = member.role ? formatRoleLabel(member.role) : 'Role: -';
    return `
      <div class="learning-report-item">
        <div class="learning-report-metric">
          <span>${escapeHtml(name)}</span>
          <span>${formatPercent(completionRate)}</span>
        </div>
        <div class="learning-report-meta">${escapeHtml(roleLabel)}</div>
        <div class="learning-report-progress">
          <span style="width: ${completionRate}%;"></span>
        </div>
        <div class="learning-report-meta">
          ${member.completed || 0}/${member.totalAssignments || 0} completed · ${member.inProgress || 0} in progress · ${member.notStarted || 0} not started
        </div>
      </div>
    `;
  }).join('');
}

function renderLearningReports() {
  updateLearningReportsSummary();
  updateLearningReportsDashboards();
  renderLearningReportRoles();
  renderLearningReportOverdue();
  renderLearningReportTeam();
}

async function fetchLearningReportData(path) {
  const res = await learningHubFetch(path);
  if (res.status === 401 || res.status === 403) {
    const error = new Error('access_denied');
    error.code = 'access_denied';
    throw error;
  }
  if (!res.ok) {
    const error = new Error('request_failed');
    error.code = 'request_failed';
    throw error;
  }
  return res.json().catch(() => ({}));
}

async function loadLearningReports(triggerButton) {
  if (learningReportsState.loading) return;
  learningReportsState.loading = true;
  if (triggerButton) setButtonLoading(triggerButton, true);
  setLearningReportsStatus('Loading learning reports...');
  try {
    const [completionData, overdueData, teamData] = await Promise.all([
      fetchLearningReportData('/api/learning-hub/reports/completion-by-role'),
      fetchLearningReportData('/api/learning-hub/reports/overdue-mandatory'),
      fetchLearningReportData('/api/learning-hub/reports/team-progress')
    ]);
    learningReportsState.data = {
      roles: Array.isArray(completionData?.roles) ? completionData.roles : [],
      overdueCount: Number(overdueData?.overdueCount || 0),
      byCourse: Array.isArray(overdueData?.byCourse) ? overdueData.byCourse : [],
      overdue: Array.isArray(overdueData?.overdue) ? overdueData.overdue : [],
      team: Array.isArray(teamData?.team) ? teamData.team : []
    };
    learningReportsState.updatedAt = new Date();
    setLearningReportsStatus('');
    renderLearningReports();
  } catch (error) {
    console.error('Failed to load learning reports', error);
    if (error?.code === 'access_denied') {
      setLearningReportsStatus('Access denied. Please sign in with HR/L&D or manager credentials.');
    } else {
      setLearningReportsStatus('Unable to load learning reports right now.');
    }
  } finally {
    learningReportsState.loading = false;
    if (triggerButton) setButtonLoading(triggerButton, false);
  }
}

function initLearningReports() {
  if (learningReportsState.initialized) {
    loadLearningReports();
    return;
  }
  learningReportsState.initialized = true;
  const hasAccess = isLearningReportRole(currentUser?.role);
  if (!hasAccess) {
    setLearningReportsStatus('Access denied. Please sign in with HR/L&D or manager credentials.');
    return;
  }
  const refreshBtn = document.getElementById('learningReportsRefresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadLearningReports(refreshBtn));
  }
  loadLearningReports(refreshBtn);
}

// ----------- PERFORMANCE REVIEW -----------
const PERFORMANCE_COMPETENCIES = [
  { key: 'execution', label: 'Execution & Delivery' },
  { key: 'craft', label: 'Craft & Quality' },
  { key: 'collaboration', label: 'Collaboration' },
  { key: 'leadership', label: 'Leadership & Growth' }
];

let performanceState = null;
let performanceEmployeeId = '';
let performanceInitialized = false;
let performanceEditingGoalId = null;

function getPerformanceRole() {
  if (isSuperAdmin(currentUser)) return 'hr';
  if (isManagerRole(currentUser)) return 'manager';
  return 'employee';
}

function updatePerformanceSummary() {
  const roleChip = document.getElementById('performanceRoleChip');
  const cycleChip = document.getElementById('performanceCycleChip');
  const updatedChip = document.getElementById('performanceUpdatedChip');
  const role = getPerformanceRole();
  const roleLabel = role === 'hr' ? 'HR' : role === 'manager' ? 'Manager' : 'Employee';
  if (roleChip) {
    roleChip.querySelector('span:nth-child(2)').textContent = `Role: ${roleLabel}`;
  }
  if (cycleChip && performanceState?.cycleYear) {
    cycleChip.querySelector('span:nth-child(2)').textContent = `Cycle: ${performanceState.cycleYear}`;
  }
  if (updatedChip) {
    const ts = performanceState?.updatedAt ? new Date(performanceState.updatedAt) : null;
    updatedChip.querySelector('span:nth-child(2)').textContent = ts
      ? `Updated: ${ts.toLocaleString()}`
      : 'Updated: -';
  }
}

function normalizePerformanceState(data = {}) {
  return {
    employeeId: data.employeeId || performanceEmployeeId,
    cycleYear: data.cycleYear || new Date().getFullYear(),
    goals: Array.isArray(data.goals) ? data.goals : [],
    checkIns: Array.isArray(data.checkIns) ? data.checkIns : [],
    midYear: data.midYear || { selfAssessment: '', interimManagerRating: '', evidence: [] },
    yearEnd: data.yearEnd || {
      selfReview: '',
      managerReview: '',
      goalScores: [],
      competencyScores: [],
      overallScore: null
    },
    calibration: data.calibration || {
      locked: false,
      adjustments: [],
      distribution: { exceeds: 0, meets: 0, developing: 0 }
    },
    development: data.development || { planSummary: '', trainings: [], followUps: [] },
    approvals: Array.isArray(data.approvals) ? data.approvals : [],
    reminders: Array.isArray(data.reminders) ? data.reminders : [],
    updatedAt: data.updatedAt || new Date().toISOString()
  };
}

async function persistPerformance() {
  if (!performanceEmployeeId || !performanceState) return;
  const res = await apiFetch(`/api/performance/${performanceEmployeeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(performanceState)
  });
  if (!res.ok) {
    alert('Could not save performance data.');
    return;
  }
  const data = await res.json();
  performanceState = normalizePerformanceState(data.review || performanceState);
  updatePerformanceSummary();
  renderPerformanceExperience();
}

function renderGoals() {
  const container = document.getElementById('performanceGoalList');
  if (!container) return;
  container.innerHTML = '';
  const role = getPerformanceRole();
  const goals = Array.isArray(performanceState?.goals) ? performanceState.goals : [];
  if (!goals.length) {
    container.innerHTML = '<p class="text-muted">Add a goal with weight to kick off the cycle.</p>';
    return;
  }
  goals.forEach(goal => {
    const item = document.createElement('div');
    item.className = 'performance-item';
    item.innerHTML = `
      <div class="performance-item__body">
        <strong>${escapeHtml(goal.title || 'Goal')}</strong>
        <div class="performance-item__meta">
          <span class="performance-badge">Weight ${goal.weight || 0}%</span>
          ${goal.due ? `<span class="performance-badge">Due ${goal.due}</span>` : ''}
          <span class="performance-badge">${goal.status === 'approved' ? 'Manager approved' : 'Awaiting approval'}</span>
        </div>
        ${goal.description ? `<p class="text-muted">${escapeHtml(goal.description)}</p>` : ''}
      </div>
      <div class="performance-item__actions">
        ${role !== 'employee' && goal.status !== 'approved' ? `<button class="md-button md-button--filled" data-goal-action="approve" data-goal-id="${goal.id}">Approve</button>` : ''}
        ${goal.status === 'approved' && role !== 'employee' ? `<button class="md-button md-button--outlined" data-goal-action="reopen" data-goal-id="${goal.id}">Re-open</button>` : ''}
        ${goal.status !== 'approved' ? `<button class="md-button md-button--text" data-goal-action="edit" data-goal-id="${goal.id}">Edit</button>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

function renderCheckIns() {
  const container = document.getElementById('checkInList');
  if (!container) return;
  container.innerHTML = '';
  const checkIns = Array.isArray(performanceState?.checkIns) ? performanceState.checkIns : [];
  if (!checkIns.length) {
    container.innerHTML = '<p class="text-muted">Log check-ins to create reminders and escalations.</p>';
    return;
  }
  checkIns
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .forEach(entry => {
      const item = document.createElement('div');
      item.className = 'performance-item';
      item.innerHTML = `
        <div class="performance-item__body">
          <strong>${escapeHtml(entry.type || 'Status')}</strong>
          <p class="text-muted">${escapeHtml(entry.notes || '')}</p>
          <div class="performance-item__meta">
            ${entry.nextCheckIn ? `<span class="performance-badge">Next: ${entry.nextCheckIn}</span>` : ''}
            ${entry.escalate ? '<span class="performance-badge">Escalation</span>' : ''}
          </div>
        </div>
      `;
      container.appendChild(item);
    });
}

function renderMidYear() {
  const selfInput = document.getElementById('midYearSelf');
  const ratingSelect = document.getElementById('midYearRating');
  const evidenceList = document.getElementById('midYearEvidenceList');
  if (!performanceState?.midYear) return;
  if (selfInput) selfInput.value = performanceState.midYear.selfAssessment || '';
  if (ratingSelect) ratingSelect.value = performanceState.midYear.interimManagerRating || '';
  if (evidenceList) {
    evidenceList.innerHTML = '';
    const evidence = Array.isArray(performanceState.midYear.evidence)
      ? performanceState.midYear.evidence
      : [];
    if (!evidence.length) {
      evidenceList.innerHTML = '<p class="text-muted">Upload links or proof points to support your self-assessment.</p>';
    } else {
      evidence.forEach(ev => {
        const chip = document.createElement('span');
        chip.className = 'performance-chip';
        chip.textContent = ev.name || 'Attachment';
        evidenceList.appendChild(chip);
      });
    }
  }
}

function ensureGoalScores() {
  const goals = Array.isArray(performanceState?.goals) ? performanceState.goals : [];
  if (!performanceState.yearEnd) {
    performanceState.yearEnd = { selfReview: '', managerReview: '', goalScores: [], competencyScores: [], overallScore: null };
  }
  const goalScores = Array.isArray(performanceState.yearEnd.goalScores)
    ? performanceState.yearEnd.goalScores
    : [];
  goals.forEach(goal => {
    if (!goalScores.find(gs => gs.goalId === goal.id)) {
      goalScores.push({ goalId: goal.id, rating: 3 });
    }
  });
  performanceState.yearEnd.goalScores = goalScores;

  const competencyScores = Array.isArray(performanceState.yearEnd.competencyScores)
    ? performanceState.yearEnd.competencyScores
    : [];
  PERFORMANCE_COMPETENCIES.forEach(comp => {
    if (!competencyScores.find(c => c.key === comp.key)) {
      competencyScores.push({ key: comp.key, rating: 3 });
    }
  });
  performanceState.yearEnd.competencyScores = competencyScores;
}

function computeWeightedScore() {
  const goals = Array.isArray(performanceState?.goals) ? performanceState.goals : [];
  const scores = Array.isArray(performanceState?.yearEnd?.goalScores)
    ? performanceState.yearEnd.goalScores
    : [];
  if (!goals.length || !scores.length) return null;
  const totalWeight = goals.reduce((sum, g) => sum + Number(g.weight || 0), 0) || goals.length;
  let scoreSum = 0;
  goals.forEach(goal => {
    const entry = scores.find(s => s.goalId === goal.id);
    const rating = entry ? Number(entry.rating || 0) : 0;
    const weight = Number(goal.weight || 0) || 1;
    scoreSum += (weight / totalWeight) * rating;
  });
  const overall = Number((scoreSum || 0).toFixed(2));
  performanceState.yearEnd.overallScore = overall;
  return overall;
}

function renderYearEnd() {
  ensureGoalScores();
  const selfInput = document.getElementById('yearEndSelf');
  const managerInput = document.getElementById('yearEndManager');
  const goalsContainer = document.getElementById('yearEndGoals');
  const compContainer = document.getElementById('yearEndCompetencies');
  const scoreEl = document.getElementById('yearEndScore');
  if (selfInput) selfInput.value = performanceState?.yearEnd?.selfReview || '';
  if (managerInput) managerInput.value = performanceState?.yearEnd?.managerReview || '';

  if (goalsContainer) {
    goalsContainer.innerHTML = '';
    const goals = Array.isArray(performanceState?.goals) ? performanceState.goals : [];
    if (!goals.length) {
      goalsContainer.innerHTML = '<p class="text-muted">Add goals to capture weighted scoring.</p>';
    } else {
      goals.forEach(goal => {
        const scoreEntry = performanceState.yearEnd.goalScores.find(gs => gs.goalId === goal.id) || { rating: 3 };
        const wrapper = document.createElement('div');
        wrapper.className = 'performance-item';
        wrapper.innerHTML = `
          <div class="performance-item__body">
            <strong>${escapeHtml(goal.title || 'Goal')}</strong>
            <p class="performance-helper">Weight ${goal.weight || 0}%</p>
          </div>
          <div>
            <label class="performance-helper" for="goalScore-${goal.id}">Rating</label>
            <input type="range" min="1" max="5" step="1" id="goalScore-${goal.id}" data-goal-score="${goal.id}" value="${scoreEntry.rating}" />
          </div>
        `;
        goalsContainer.appendChild(wrapper);
      });
    }
  }

  if (compContainer) {
    compContainer.innerHTML = '';
    PERFORMANCE_COMPETENCIES.forEach(comp => {
      const entry = performanceState.yearEnd.competencyScores.find(c => c.key === comp.key) || { rating: 3 };
      const row = document.createElement('div');
      row.className = 'performance-item';
      row.innerHTML = `
        <div class="performance-item__body">
          <strong>${comp.label}</strong>
          <p class="performance-helper">Rate 1-5</p>
        </div>
        <div>
          <input type="range" min="1" max="5" step="1" data-competency-score="${comp.key}" value="${entry.rating}" />
        </div>
      `;
      compContainer.appendChild(row);
    });
  }

  const score = computeWeightedScore();
  if (scoreEl) scoreEl.textContent = score != null ? score : '-';
}

function renderCalibration() {
  const toggle = document.getElementById('calibrationToggle');
  const adjustments = document.getElementById('calibrationAdjustments');
  const distribution = document.getElementById('calibrationDistribution');
  const role = getPerformanceRole();
  if (toggle) {
    toggle.disabled = role !== 'hr';
    const locked = Boolean(performanceState?.calibration?.locked);
    toggle.querySelector('span:nth-child(1)').textContent = locked ? 'lock' : 'lock_open';
    toggle.querySelector('span:nth-child(2)').textContent = locked ? 'Locked' : 'Unlock';
  }
  if (adjustments) {
    const notes = Array.isArray(performanceState?.calibration?.adjustments)
      ? performanceState.calibration.adjustments.join('\n')
      : performanceState?.calibration?.adjustments || '';
    adjustments.value = notes;
    adjustments.disabled = Boolean(performanceState?.calibration?.locked) && role !== 'hr';
  }
  if (distribution) {
    distribution.innerHTML = '';
    const dist = performanceState?.calibration?.distribution || { exceeds: 0, meets: 0, developing: 0 };
    ['exceeds', 'meets', 'developing'].forEach(key => {
      const value = Number(dist[key] || 0);
      const row = document.createElement('div');
      row.innerHTML = `
        <p class="performance-helper" style="margin:0 0 4px; text-transform: capitalize;">${key} (${value})</p>
        <div class="distribution-bar"><span style="width:${Math.min(value, 100)}%;"></span></div>
      `;
      distribution.appendChild(row);
    });
  }
}

function renderDevelopment() {
  const summaryInput = document.getElementById('developmentSummary');
  const trainingList = document.getElementById('trainingList');
  const followUpList = document.getElementById('followUpList');
  if (summaryInput) summaryInput.value = performanceState?.development?.planSummary || '';
  if (trainingList) {
    trainingList.innerHTML = '';
    (performanceState?.development?.trainings || []).forEach((item, idx) => {
      const chip = document.createElement('span');
      chip.className = 'performance-chip';
      chip.innerHTML = `${escapeHtml(item)} <button type="button" data-training-remove="${idx}" class="md-button md-button--text md-button--small">Remove</button>`;
      trainingList.appendChild(chip);
    });
  }
  if (followUpList) {
    followUpList.innerHTML = '';
    (performanceState?.development?.followUps || []).forEach((item, idx) => {
      const chip = document.createElement('span');
      chip.className = 'performance-chip';
      chip.innerHTML = `${escapeHtml(item)} <button type="button" data-followup-remove="${idx}" class="md-button md-button--text md-button--small">Remove</button>`;
      followUpList.appendChild(chip);
    });
  }
}

function renderPerformanceExperience() {
  renderGoals();
  renderCheckIns();
  renderMidYear();
  renderYearEnd();
  renderCalibration();
  renderDevelopment();
  updatePerformanceSummary();
}

async function loadPerformanceReview(empId) {
  if (!empId) return;
  performanceEmployeeId = empId;
  const res = await apiFetch(`/api/performance/${empId}`);
  if (!res.ok) {
    alert('Unable to load performance review.');
    return;
  }
  const data = await res.json();
  performanceState = normalizePerformanceState(data.review || {});
  renderPerformanceExperience();
}

async function loadPerformanceEmployees() {
  const select = document.getElementById('performanceEmployeeSelect');
  if (!select) return;
  const emps = await getJSON('/employees');
  const role = getPerformanceRole();
  let options = emps;
  if (role === 'employee') {
    options = emps.filter(e => e.id == currentUser?.employeeId);
  }
  select.innerHTML = '<option value="">-- select --</option>';
  options.forEach(e => select.add(new Option(e.name || `Employee ${e.id}`, e.id)));
  if (!performanceEmployeeId && options.length === 1) {
    performanceEmployeeId = options[0].id;
    select.value = performanceEmployeeId;
  }
  if (select.value && select.value !== performanceEmployeeId) {
    performanceEmployeeId = select.value;
  }
  select.onchange = ev => {
    performanceEmployeeId = ev.target.value;
    if (performanceEmployeeId) loadPerformanceReview(performanceEmployeeId);
  };
  if (performanceEmployeeId) {
    await loadPerformanceReview(performanceEmployeeId);
  }
}

async function onGoalSubmit(ev) {
  ev.preventDefault();
  const title = document.getElementById('goalTitle').value.trim();
  const weight = Number(document.getElementById('goalWeight').value || 0);
  const due = document.getElementById('goalDue').value;
  const description = document.getElementById('goalDescription').value.trim();
  if (!title) return;
  const now = Date.now();
  const goal = {
    id: performanceEditingGoalId || now,
    title,
    weight: weight || 0,
    due,
    description,
    status: 'pending',
    createdAt: new Date(now).toISOString()
  };
  const goals = Array.isArray(performanceState?.goals) ? [...performanceState.goals] : [];
  const idx = goals.findIndex(g => g.id === goal.id);
  if (idx >= 0) goals[idx] = goal; else goals.push(goal);
  performanceState.goals = goals;
  performanceEditingGoalId = null;
  document.getElementById('performanceGoalForm').reset();
  renderGoals();
  await persistPerformance();
}

function onGoalListClick(ev) {
  const btn = ev.target.closest('[data-goal-action]');
  if (!btn) return;
  const goalId = btn.getAttribute('data-goal-id');
  const action = btn.getAttribute('data-goal-action');
  const goals = Array.isArray(performanceState?.goals) ? performanceState.goals : [];
  const goal = goals.find(g => String(g.id) === String(goalId));
  if (!goal) return;
  if (action === 'approve' && getPerformanceRole() !== 'employee') {
    goal.status = 'approved';
    goal.approvedAt = new Date().toISOString();
  } else if (action === 'reopen' && getPerformanceRole() !== 'employee') {
    goal.status = 'pending';
  } else if (action === 'edit') {
    performanceEditingGoalId = goal.id;
    document.getElementById('goalTitle').value = goal.title || '';
    document.getElementById('goalWeight').value = goal.weight || '';
    document.getElementById('goalDue').value = goal.due || '';
    document.getElementById('goalDescription').value = goal.description || '';
  }
  renderGoals();
  persistPerformance();
}

async function onCheckInSubmit(ev) {
  ev.preventDefault();
  const notes = document.getElementById('checkInNotes').value.trim();
  if (!notes) return;
  const type = document.getElementById('checkInType').value || 'status';
  const nextCheckIn = document.getElementById('checkInDate').value || '';
  const escalate = document.getElementById('checkInEscalate').checked;
  const entry = {
    id: Date.now(),
    notes,
    type,
    nextCheckIn,
    escalate,
    createdAt: new Date().toISOString()
  };
  const checkIns = Array.isArray(performanceState?.checkIns) ? performanceState.checkIns : [];
  performanceState.checkIns = [entry, ...checkIns];
  document.getElementById('checkInForm').reset();
  renderCheckIns();
  await persistPerformance();
}

async function onMidYearSubmit(ev) {
  ev.preventDefault();
  const selfAssessment = document.getElementById('midYearSelf').value;
  const interimManagerRating = document.getElementById('midYearRating').value;
  const files = Array.from(document.getElementById('midYearEvidence').files || []);
  const uploads = await Promise.all(files.map(async file => ({
    id: Date.now() + file.size,
    name: file.name,
    content: await fileToBase64(file)
  })));
  const evidence = Array.isArray(performanceState?.midYear?.evidence)
    ? [...performanceState.midYear.evidence, ...uploads]
    : uploads;
  performanceState.midYear = { selfAssessment, interimManagerRating, evidence };
  renderMidYear();
  await persistPerformance();
}

function onYearEndChange(ev) {
  const goalScore = ev.target.getAttribute('data-goal-score');
  const compScore = ev.target.getAttribute('data-competency-score');
  if (goalScore) {
    const entry = performanceState.yearEnd.goalScores.find(gs => gs.goalId == goalScore);
    if (entry) entry.rating = Number(ev.target.value || 0);
  }
  if (compScore) {
    const entry = performanceState.yearEnd.competencyScores.find(c => c.key === compScore);
    if (entry) entry.rating = Number(ev.target.value || 0);
  }
  renderYearEnd();
}

async function onYearEndSubmit(ev) {
  ev.preventDefault();
  const selfReview = document.getElementById('yearEndSelf').value;
  const managerReview = document.getElementById('yearEndManager').value;
  performanceState.yearEnd = {
    ...performanceState.yearEnd,
    selfReview,
    managerReview
  };
  computeWeightedScore();
  renderYearEnd();
  await persistPerformance();
}

async function onCalibrationSave() {
  const notes = document.getElementById('calibrationAdjustments').value;
  const locked = Boolean(performanceState?.calibration?.locked);
  performanceState.calibration = {
    ...(performanceState.calibration || {}),
    adjustments: notes ? notes.split('\n').filter(Boolean) : [],
    locked
  };
  renderCalibration();
  await persistPerformance();
}

async function onCalibrationToggle() {
  if (getPerformanceRole() !== 'hr') return;
  const locked = !Boolean(performanceState?.calibration?.locked);
  performanceState.calibration = {
    ...(performanceState.calibration || {}),
    locked
  };
  renderCalibration();
  await persistPerformance();
}

async function onDevelopmentSubmit(ev) {
  ev.preventDefault();
  const summary = document.getElementById('developmentSummary').value;
  performanceState.development = {
    ...(performanceState.development || {}),
    planSummary: summary,
    trainings: performanceState.development?.trainings || [],
    followUps: performanceState.development?.followUps || []
  };
  renderDevelopment();
  await persistPerformance();
}

function onTrainingAdd() {
  const input = document.getElementById('trainingInput');
  if (!input || !input.value.trim()) return;
  performanceState.development = performanceState.development || { trainings: [], followUps: [] };
  performanceState.development.trainings = performanceState.development.trainings || [];
  performanceState.development.trainings.push(input.value.trim());
  input.value = '';
  renderDevelopment();
  persistPerformance();
}

function onFollowUpAdd() {
  const input = document.getElementById('followUpInput');
  if (!input || !input.value.trim()) return;
  performanceState.development = performanceState.development || { trainings: [], followUps: [] };
  performanceState.development.followUps = performanceState.development.followUps || [];
  performanceState.development.followUps.push(input.value.trim());
  input.value = '';
  renderDevelopment();
  persistPerformance();
}

function onDevelopmentListClick(ev) {
  const trainingBtn = ev.target.closest('[data-training-remove]');
  const followUpBtn = ev.target.closest('[data-followup-remove]');
  if (trainingBtn) {
    const idx = Number(trainingBtn.getAttribute('data-training-remove'));
    performanceState.development.trainings.splice(idx, 1);
  }
  if (followUpBtn) {
    const idx = Number(followUpBtn.getAttribute('data-followup-remove'));
    performanceState.development.followUps.splice(idx, 1);
  }
  renderDevelopment();
  persistPerformance();
}

async function ensurePerformanceExperience() {
  if (performanceInitialized) {
    if (performanceEmployeeId) await loadPerformanceReview(performanceEmployeeId);
    return;
  }
  performanceInitialized = true;
  performanceState = performanceState || normalizePerformanceState({});
  const goalForm = document.getElementById('performanceGoalForm');
  const checkInForm = document.getElementById('checkInForm');
  const midYearForm = document.getElementById('midYearForm');
  const yearEndForm = document.getElementById('yearEndForm');
  const devForm = document.getElementById('developmentForm');
  const goalList = document.getElementById('performanceGoalList');
  const yearEndGoals = document.getElementById('yearEndGoals');
  const yearEndCompetencies = document.getElementById('yearEndCompetencies');
  const calibrationButton = document.getElementById('calibrationSave');
  const calibrationToggle = document.getElementById('calibrationToggle');
  const trainingButton = document.getElementById('addTraining');
  const followUpButton = document.getElementById('addFollowUp');
  const devLists = document.getElementById('developmentForm');

  if (goalForm) goalForm.addEventListener('submit', onGoalSubmit);
  if (goalList) goalList.addEventListener('click', onGoalListClick);
  if (checkInForm) checkInForm.addEventListener('submit', onCheckInSubmit);
  if (midYearForm) midYearForm.addEventListener('submit', onMidYearSubmit);
  if (yearEndForm) yearEndForm.addEventListener('submit', onYearEndSubmit);
  if (yearEndGoals) yearEndGoals.addEventListener('input', onYearEndChange);
  if (yearEndCompetencies) yearEndCompetencies.addEventListener('input', onYearEndChange);
  if (calibrationButton) calibrationButton.addEventListener('click', onCalibrationSave);
  if (calibrationToggle) calibrationToggle.addEventListener('click', onCalibrationToggle);
  if (devForm) devForm.addEventListener('submit', onDevelopmentSubmit);
  if (trainingButton) trainingButton.addEventListener('click', onTrainingAdd);
  if (followUpButton) followUpButton.addEventListener('click', onFollowUpAdd);
  if (devLists) devLists.addEventListener('click', onDevelopmentListClick);

  await loadPerformanceEmployees();
}

function getCurrentPayrollMonthValue() {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function updateFinanceSubtab(name = 'employees') {
  if (!name || !financeSubtabPanels[name]) return;

  financeActiveSubtab = name;

  financeSubtabButtons.forEach(button => {
    const isActive = button.dataset.financeSubtab === name;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });

  Object.entries(financeSubtabPanels).forEach(([panelName, panelEl]) => {
    if (!panelEl) return;
    const isActive = panelName === name;
    panelEl.classList.toggle('hidden', !isActive);
    panelEl.classList.toggle('finance-subtab-panel--active', isActive);
  });
}

function updateRecruitmentSubtab(name = 'pipeline') {
  if (!name || !recruitmentSubtabPanels[name]) return;

  recruitmentActiveSubtab = name;

  recruitmentSubtabButtons.forEach(button => {
    const isActive = button.dataset.recruitmentSubtab === name;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });

  Object.entries(recruitmentSubtabPanels).forEach(([panelName, panelEl]) => {
    if (!panelEl) return;
    const isActive = panelName === name;
    panelEl.classList.toggle('hidden', !isActive);
    panelEl.classList.toggle('recruitment-subtab-panel--active', isActive);
  });
}

function formatFinanceUpdatedAt(value) {
  if (!value) return 'Updated: Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Updated: Not set';
  const datePart = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
  return `Updated: ${datePart} ${timePart}`;
}

function formatSalaryAmount(amount, currency = null) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  const options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (currency) {
    options.style = 'currency';
    options.currency = currency;
  }
  try {
    return amount.toLocaleString(undefined, options);
  } catch (err) {
    const fallback = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${currency} ${fallback}` : fallback;
  }
}

function getPayrollSalaryAmount(summary) {
  const grossPay = typeof summary?.grossPay === 'number' && Number.isFinite(summary.grossPay)
    ? summary.grossPay
    : null;
  const salaryAmount = typeof summary?.salary?.amount === 'number' && Number.isFinite(summary.salary.amount)
    ? summary.salary.amount
    : null;
  if (grossPay !== null) return grossPay;
  if (salaryAmount !== null) return salaryAmount;
  return null;
}

function setupFinanceModule() {
  if (financeInitialized) return;
  if (!financeMonthInput || !financeTableBody) return;
  financeInitialized = true;

  if (financeSubtabButtons.length) {
    financeSubtabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const targetTab = button.dataset.financeSubtab || 'employees';
        updateFinanceSubtab(targetTab);
      });
    });
    updateFinanceSubtab(financeActiveSubtab);
  }

  financeMonthInput.value = financeMonthInput.value || getCurrentPayrollMonthValue();
  financeMonthInput.addEventListener('change', () => {
    if (!isSuperAdmin(currentUser)) return;
    loadFinanceData();
  });
  if (financeRefreshButton) {
    financeRefreshButton.addEventListener('click', () => {
      if (!isSuperAdmin(currentUser)) return;
      loadFinanceData(true);
    });
  }
  if (payrollExportButton) {
    payrollExportButton.addEventListener('click', exportPayrollToXlsx);
  }
  if (financeTableBody) {
    financeTableBody.addEventListener('input', onFinanceSalaryInputChange);
    financeTableBody.addEventListener('click', onFinanceSaveClick);
  }
}

function setFinanceLoading(isLoading) {
  financeLoading = Boolean(isLoading);
  if (financeRefreshButton) {
    setButtonLoading(financeRefreshButton, financeLoading);
  }
  if (financeMonthInput) {
    financeMonthInput.disabled = financeLoading;
  }
  if (financeTableBody) {
    financeTableBody.classList.toggle('is-loading', financeLoading);
  }
}

async function loadFinanceData(showFeedback = false) {
  if (!isSuperAdmin(currentUser)) return;
  if (!financeMonthInput) return;
  const monthValue = financeMonthInput.value || getCurrentPayrollMonthValue();
  financeMonthInput.value = monthValue;
  setFinanceLoading(true);
  try {
    const res = await apiFetch(`/api/finance/salaries?month=${encodeURIComponent(monthValue)}`);
    if (!res.ok) throw new Error('Failed to load finance data');
    const data = await res.json();
    financeState.month = data.month || monthValue;
    financeState.employees = Array.isArray(data.employees) ? data.employees : [];
    financeState.payrollSummary = Array.isArray(data.payrollSummary)
      ? data.payrollSummary
      : financeState.employees.map(emp => ({
          employeeId: emp.employeeId,
          name: emp.name || '',
          month: financeState.month,
          salary: emp.salary || null,
          grossPay: typeof emp?.salary?.amount === 'number' && Number.isFinite(emp.salary.amount)
            ? emp.salary.amount
            : null,
          bankAccountName: emp.bankAccountName || '',
          bankAccountNumber: emp.bankAccountNumber || ''
        }));
    if (financeMonthInput) {
      financeMonthInput.value = financeState.month || monthValue;
    }
    renderFinanceTable();
    renderPayrollSummary();
    if (showFeedback) {
      showToast('Finance data refreshed.', 'success');
    }
  } catch (error) {
    console.error('Failed to load finance data', error);
    showToast('Failed to load finance data. Please try again.', 'error');
  } finally {
    setFinanceLoading(false);
  }
}

function renderFinanceTable() {
  if (!financeTableBody) return;
  const employees = Array.isArray(financeState.employees) ? financeState.employees : [];
  if (!employees.length) {
    financeTableBody.innerHTML = '';
    if (financeEmptyState) {
      const emptyText = financeEmptyState.querySelector('p');
      if (emptyText) {
        emptyText.textContent = 'All active employees will appear here when available.';
      }
      financeEmptyState.classList.remove('hidden');
    }
    return;
  }

  const cards = employees
    .map(emp => {
      const salaryAmount = typeof emp?.salary?.amount === 'number' && Number.isFinite(emp.salary.amount)
        ? emp.salary.amount
        : null;
      const inputValue = salaryAmount === null ? '' : salaryAmount;
      const updatedText = emp?.salary?.updatedAt ? formatFinanceUpdatedAt(emp.salary.updatedAt) : 'Updated: Not set';
      const jobLine = [emp?.title || '', emp?.department || '']
        .map(part => part && part.trim())
        .filter(Boolean)
        .join(' • ');
      const nameDisplay = escapeHtml(emp?.name || 'Unknown');
      const jobDisplay = jobLine ? escapeHtml(jobLine) : '—';
      const employeeId = emp?.employeeId || '';
      const isSavingThisEmployee = financeSaving && String(financeSavingId) === String(employeeId);
      const salaryFieldId = `finance-salary-${String(employeeId || '')
        .replace(/[^a-zA-Z0-9_-]/g, '') || Math.random().toString(36).slice(2, 8)}`;
      return `
        <article
          class="employee-card"
          data-employee-id="${escapeHtml(employeeId)}"
          data-name="${escapeHtml((emp?.name || '').toLowerCase())}"
        >
          <div class="employee-card-top">
            <div>
              <h3 class="employee-name">${nameDisplay}</h3>
              <p class="employee-role">${jobDisplay}</p>
            </div>
            <span class="employee-status-dot"></span>
          </div>

          <div class="employee-card-middle">
            <div class="employee-salary-group">
              <label class="employee-salary-label" for="${escapeHtml(salaryFieldId)}">Base Salary</label>
              <div class="employee-salary-input-wrapper">
                <span class="employee-salary-icon">💳</span>
                <input
                  type="number"
                  id="${escapeHtml(salaryFieldId)}"
                  class="employee-salary-input"
                  value="${escapeHtml(String(inputValue))}"
                  data-salary-input
                  min="0"
                  step="0.01"
                />
                <span class="employee-salary-currency">MMK</span>
              </div>
            </div>

            <button
              type="button"
              class="employee-save-button"
              onclick="saveSalary('${escapeHtml(employeeId)}', this)"
              ${isSavingThisEmployee ? 'disabled' : ''}
            >
              ${isSavingThisEmployee ? 'Saving…' : '✓ Save'}
            </button>
          </div>

          <p class="employee-updated">${escapeHtml(updatedText)}</p>
        </article>
      `;
    })
    .join('');

  financeTableBody.innerHTML = cards;
  if (financeEmptyState) {
    financeEmptyState.classList.add('hidden');
  }
  applyFinanceSearchFilter();
}

function renderPayrollSummary() {
  if (!payrollSummaryBody) return;
  const summaries = Array.isArray(financeState.payrollSummary)
    ? financeState.payrollSummary
    : [];

  if (payrollSummaryMonth) {
    payrollSummaryMonth.textContent = financeState.month || getCurrentPayrollMonthValue();
  }

  if (!summaries.length) {
    payrollSummaryBody.innerHTML = '';
    if (payrollSummaryEmpty) {
      payrollSummaryEmpty.classList.remove('hidden');
    }
    return;
  }

  const rows = summaries
    .map(summary => {
      const salaryDisplay = formatSalaryAmount(getPayrollSalaryAmount(summary));
      const bankName = summary?.bankAccountName?.trim()
        ? summary.bankAccountName.trim()
        : '—';
      const bankNumber = summary?.bankAccountNumber?.trim()
        ? summary.bankAccountNumber.trim()
        : '—';

      return `
        <tr>
          <td>${escapeHtml(summary?.name || 'Unknown')}</td>
          <td class="payroll-summary-amount">${escapeHtml(salaryDisplay)}</td>
          <td>${escapeHtml(bankName)}</td>
          <td>${escapeHtml(bankNumber)}</td>
        </tr>
      `;
    })
    .join('');

  payrollSummaryBody.innerHTML = rows;
  if (payrollSummaryEmpty) {
    payrollSummaryEmpty.classList.add('hidden');
  }
}

function exportPayrollToXlsx() {
  if (!isSuperAdmin(currentUser)) return;
  const summaries = Array.isArray(financeState.payrollSummary)
    ? financeState.payrollSummary
    : [];
  if (!summaries.length) {
    showToast('Payroll summary is empty for the selected month.', 'warning');
    return;
  }
  const month = financeState.month || getCurrentPayrollMonthValue();
  const rows = buildPayrollExportRows(summaries, month);

  if (typeof XLSX !== 'undefined' && XLSX.utils) {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!cols'] = [
      { wch: 28 },
      { wch: 16 },
      { wch: 26 },
      { wch: 22 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Payroll');

    const fileName = `payroll-${String(month || 'month').replace(/\s+/g, '-')}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    showToast('Payroll exported successfully.', 'success');
    return;
  }

  downloadPayrollCsv(rows, month);
}

function buildPayrollExportRows(summaries = [], month = '') {
  const headerRows = [
    ['Payroll Summary'],
    ['Month', month],
    ['Generated', new Date().toLocaleString()],
    []
  ];

  const tableRows = [
    ['Employee', 'Salary (MMK)', 'Bank Account Name', 'Bank Account Number'],
    ...summaries.map(summary => [
      summary?.name || 'Unknown',
      getPayrollSalaryAmount(summary) ?? '',
      summary?.bankAccountName?.trim() || '',
      summary?.bankAccountNumber?.trim() || ''
    ])
  ];

  return [...headerRows, ...tableRows];
}

function downloadPayrollCsv(rows = [], month = '') {
  if (!Array.isArray(rows) || !rows.length) return;

  const csvContent = rows
    .map(row =>
      row
        .map(value => {
          if (value === null || value === undefined) return '';
          const stringValue = String(value);
          if (/[",\n]/.test(stringValue)) {
            return `"${stringValue.replace(/"/g, '""')}"`;
          }
          return stringValue;
        })
        .join(',')
    )
    .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const fileName = `payroll-${String(month || 'month').replace(/\s+/g, '-')}.csv`;
  if (window.navigator.msSaveOrOpenBlob) {
    window.navigator.msSaveOrOpenBlob(blob, fileName);
  } else {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  showToast('Payroll CSV exported successfully.', 'success');
}

function applyFinanceSearchFilter() {
  if (!financeTableBody) return;
  const cards = Array.from(financeTableBody.querySelectorAll('.employee-card'));
  const normalizedTerm = (financeSearchTerm || '').trim().toLowerCase();
  let visibleCount = 0;

  cards.forEach(card => {
    const nameFromAttr = (card.getAttribute('data-name') || '').toLowerCase();
    const name = nameFromAttr || (card.querySelector('.employee-name')?.textContent || '').toLowerCase();
    const isVisible = !normalizedTerm || name.includes(normalizedTerm);
    card.style.display = isVisible ? '' : 'none';
    if (isVisible) visibleCount += 1;
  });

  if (financeEmptyState) {
    const emptyText = financeEmptyState.querySelector('p');
    const hasEmployees = cards.length > 0;
    if (!hasEmployees) {
      if (emptyText) emptyText.textContent = 'All active employees will appear here when available.';
      financeEmptyState.classList.remove('hidden');
    } else if (visibleCount === 0) {
      if (emptyText) emptyText.textContent = 'No employees found.';
      financeEmptyState.classList.remove('hidden');
    } else {
      financeEmptyState.classList.add('hidden');
    }
  }
}

function updatePayrollSummaryState(salaryPayload = {}, employeeInfo = null) {
  if (!financeState || !Array.isArray(financeState.payrollSummary)) return;
  const normalizedId = salaryPayload?.employeeId
    || salaryPayload?.salary?.employeeId
    || employeeInfo?.employeeId;
  const employeeId = normalizedId ? String(normalizedId) : null;
  if (!employeeId) return;

  const grossPay = typeof salaryPayload.grossPay === 'number' && Number.isFinite(salaryPayload.grossPay)
    ? salaryPayload.grossPay
    : typeof salaryPayload?.salary?.grossPay === 'number' && Number.isFinite(salaryPayload.salary.grossPay)
      ? salaryPayload.salary.grossPay
      : null;
  const amount = typeof salaryPayload.amount === 'number' && Number.isFinite(salaryPayload.amount)
    ? salaryPayload.amount
    : typeof salaryPayload?.salary?.amount === 'number' && Number.isFinite(salaryPayload.salary.amount)
      ? salaryPayload.salary.amount
      : null;
  const salary = salaryPayload.salary && typeof salaryPayload.salary === 'object'
    ? { ...salaryPayload.salary }
    : {
        employeeId,
        month: salaryPayload.month || financeState.month,
        amount,
        currency: salaryPayload.currency || null,
        updatedAt: salaryPayload.updatedAt || new Date().toISOString()
      };

  const employeeFromList = Array.isArray(financeState.employees)
    ? financeState.employees.find(emp => String(emp.employeeId) === employeeId)
    : null;
  const existingSummary = financeState.payrollSummary.find(summary => String(summary.employeeId) === employeeId) || {};
  const summary = {
    employeeId,
    name: employeeInfo?.name || existingSummary.name || employeeFromList?.name || '',
    month: salary.month,
    salary,
    bankAccountName: employeeInfo?.bankAccountName
      || employeeFromList?.bankAccountName
      || existingSummary.bankAccountName
      || '',
    bankAccountNumber: employeeInfo?.bankAccountNumber
      || employeeFromList?.bankAccountNumber
      || existingSummary.bankAccountNumber
      || '',
    grossPay: grossPay !== null ? grossPay : existingSummary.grossPay || null
  };

  const index = financeState.payrollSummary.findIndex(summary => String(summary.employeeId) === employeeId);
  if (index === -1) {
    financeState.payrollSummary.push(summary);
  } else {
    financeState.payrollSummary[index] = summary;
  }
}

function updateFinanceStateWithSalary(salaryPayload = {}, employeeInfo = null, payrollPayload = null) {
  if (!financeState || !Array.isArray(financeState.employees)) return;
  const normalizedId = salaryPayload?.employeeId || employeeInfo?.employeeId;
  if (!normalizedId) return;
  const index = financeState.employees.findIndex(emp => String(emp.employeeId) === String(normalizedId));
  if (index === -1) return;
  const existing = financeState.employees[index];
  const amount = typeof salaryPayload.amount === 'number' && Number.isFinite(salaryPayload.amount)
    ? salaryPayload.amount
    : null;
  financeState.employees[index] = {
    ...existing,
    ...(employeeInfo ? {
      name: employeeInfo.name ?? existing.name,
      email: employeeInfo.email ?? existing.email,
      title: employeeInfo.title ?? existing.title,
      department: employeeInfo.department ?? existing.department,
      status: employeeInfo.status ?? existing.status,
      bankAccountName: employeeInfo.bankAccountName ?? existing.bankAccountName,
      bankAccountNumber: employeeInfo.bankAccountNumber ?? existing.bankAccountNumber
    } : {}),
    salary: {
      employeeId: normalizedId,
      month: salaryPayload.month || financeState.month,
      amount,
      currency: salaryPayload.currency || null,
      updatedAt: salaryPayload.updatedAt || new Date().toISOString()
    }
  };

  updatePayrollSummaryState(payrollPayload || salaryPayload, { ...employeeInfo, employeeId: normalizedId });
}

function onFinanceSalaryInputChange(event) {
  const input = event.target.closest('[data-salary-input]');
  if (!input) return;
  const card = input.closest('[data-employee-id]');
  const employeeId = card?.dataset?.employeeId;
  if (!employeeId) return;
  const rawValue = input.value;
  const amount = rawValue === '' ? 0 : Number(rawValue);
  if (!Number.isFinite(amount) || amount < 0) return;
  updateFinanceSalaryDraft(employeeId, amount);
}

function onFinanceSaveClick(event) {
  const button = event.target.closest('[data-save-employee]');
  if (!button) return;
  const card = button.closest('[data-employee-id]');
  const employeeId = card?.dataset?.employeeId;
  if (!employeeId) return;
  saveFinanceSalaryForEmployee(employeeId, button);
}

function saveSalary(employeeId, buttonEl) {
  if (!employeeId || !(buttonEl instanceof HTMLElement)) return;
  const card = buttonEl.closest('.employee-card');
  const input = card?.querySelector('.employee-salary-input');
  const salary = Number(input?.value) || 0;
  const updatedTextEl = card?.querySelector('.employee-updated');
  const originalText = buttonEl.textContent;

  buttonEl.disabled = true;
  buttonEl.textContent = 'Saving…';

  updateFinanceSalaryDraft(employeeId, salary);

  saveFinanceSalaryForEmployee(employeeId, buttonEl)
    .then(() => {
      const refreshedCard = financeTableBody
        ? Array.from(financeTableBody.querySelectorAll('.employee-card'))
          .find(el => String(el.dataset.employeeId) === String(employeeId))
        : card;
      const targetUpdatedText = refreshedCard?.querySelector('.employee-updated') || updatedTextEl;
      if (targetUpdatedText) {
        targetUpdatedText.textContent = 'Updated: just now';
      }
    })
    .finally(() => {
      const refreshedButton = financeTableBody
        ? Array.from(financeTableBody.querySelectorAll('.employee-card'))
          .find(el => String(el.dataset.employeeId) === String(employeeId))?.querySelector('.employee-save-button')
        : buttonEl;
      const buttonToRestore = refreshedButton || buttonEl;
      buttonToRestore.disabled = false;
      buttonToRestore.textContent = originalText || '✓ Save';
    });
}

function updateFinanceSalaryDraft(employeeId, amount) {
  if (!financeState || !Array.isArray(financeState.employees)) return;
  financeState.employees = financeState.employees.map(emp => {
    if (String(emp.employeeId) !== String(employeeId)) return emp;
    const baseSalary = typeof emp.salary === 'object' && emp.salary !== null
      ? { ...emp.salary }
      : { employeeId, month: financeState.month || getCurrentPayrollMonthValue(), amount: 0, updatedAt: null };
    return {
      ...emp,
      salary: {
        ...baseSalary,
        amount
      }
    };
  });
}

function setFinanceSavingState(isSaving, employeeId = null) {
  financeSaving = Boolean(isSaving);
  financeSavingId = isSaving ? employeeId : null;
  renderFinanceTable();
}

async function saveFinanceSalaryForEmployee(employeeId, button) {
  if (!isSuperAdmin(currentUser)) {
    showToast('You do not have permission to update salaries.', 'error');
    return;
  }
  if (!financeMonthInput) return;
  const employee = financeState.employees.find(emp => String(emp.employeeId) === String(employeeId));
  if (!employee) {
    showToast('Employee not found.', 'error');
    return;
  }

  const amount = typeof employee?.salary?.amount === 'number' && Number.isFinite(employee.salary.amount)
    ? employee.salary.amount
    : 0;
  if (amount < 0) {
    showToast('Salary must be a non-negative number.', 'error');
    return;
  }

  const month = financeMonthInput.value || getCurrentPayrollMonthValue();
  financeMonthInput.value = month;
  setFinanceSavingState(true, employeeId);
  if (button) {
    setButtonLoading(button, true);
  }
  try {
    const res = await apiFetch('/api/finance/salaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, month, amount })
    });
    if (!res.ok) {
      throw new Error(`Failed to save salary for employee ${employeeId}`);
    }
    const data = await res.json();
    financeState.month = data?.payroll?.month || data?.salary?.month || month;
    if (financeMonthInput) {
      financeMonthInput.value = financeState.month;
    }
    updateFinanceStateWithSalary(data?.salary, data?.employee, data?.payroll);
    renderFinanceTable();
    renderPayrollSummary();
    showToast('Salary saved.', 'success');
  } catch (error) {
    console.error('Failed to save salary', error);
    showToast('Failed to save salary. Please try again.', 'error');
  } finally {
    if (button) {
      setButtonLoading(button, false);
    }
    setFinanceSavingState(false, null);
  }
}

function setProfileSummaryField(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = value && String(value).trim() ? String(value).trim() : '-';
  el.textContent = text;
  if (text === '-') {
    el.classList.add('text-muted');
  } else {
    el.classList.remove('text-muted');
  }
}

function renderProfileSection(section) {
  if (!section || !Array.isArray(section.fields) || !section.fields.length) {
    return '';
  }
  const icon = PROFILE_SECTION_ICONS[section.id] || 'info';
  const title = escapeHtml(section.title || 'Details');
  const sectionId = escapeHtml(section.id || Math.random().toString(36).slice(2, 8));
  const hasEditable = section.fields.some(field => field && field.editable);
  const fieldsMarkup = section.fields.map(field => {
    if (!field || !field.key) return '';
    const label = escapeHtml(field.label || field.key);
    const key = String(field.key);
    const normalizedKey = key.toLowerCase();
    const rawValue = field.value === null || typeof field.value === 'undefined' ? '' : field.value;
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue);
    if (field.editable) {
      const inputId = makeDynamicFieldId('profile', key);
      const requiredAttr = field.required ? 'required' : '';
      const isTextArea = field.type === 'textarea' || field.input === 'textarea' || normalizedKey.includes('address');
      if (isTextArea) {
        return `
          <div class="md-field">
            <label class="md-label" for="${escapeHtml(inputId)}">${label}</label>
            <textarea class="md-textarea" id="${escapeHtml(inputId)}" name="${escapeHtml(key)}" rows="3" data-editable-field ${requiredAttr}>${escapeHtml(value)}</textarea>
          </div>
        `;
      }
      const inputType = field.type && field.type !== 'textarea' ? escapeHtml(field.type) : 'text';
      return `
        <div class="md-field">
          <label class="md-label" for="${escapeHtml(inputId)}">${label}</label>
          <div class="md-input-wrapper">
            <input class="md-input" id="${escapeHtml(inputId)}" name="${escapeHtml(key)}" type="${inputType}" value="${escapeHtml(value)}" data-editable-field ${requiredAttr}>
          </div>
        </div>
      `;
    }
    const inputId = makeDynamicFieldId('profile', `${key}-readonly`);
    const hasValue = value && value.trim() !== '';
    const displayValue = hasValue ? escapeHtml(value) : 'Not provided';
    const valueAttr = ` value="${displayValue}"`;
    const emptyClass = hasValue ? '' : ' md-input--empty';
    return `
      <div class="md-field md-field--readonly">
        <label class="md-label" for="${escapeHtml(inputId)}">${label}</label>
        <div class="md-input-wrapper md-input-wrapper--readonly">
          <input class="md-input${emptyClass}" id="${escapeHtml(inputId)}" type="text"${valueAttr} disabled>
        </div>
      </div>
    `;
  }).join('');
  const bodyMarkup = fieldsMarkup || '<p class="text-muted" style="font-style: italic;">No information captured yet.</p>';
  const headerMarkup = `
    <div class="card-title">
      <span class="material-symbols-rounded">${icon}</span>
      ${title}
    </div>
  `;
  if (hasEditable) {
    return `
      <form class="md-card profile-section-form" data-section="${sectionId}">
        ${headerMarkup}
        ${bodyMarkup}
        <div class="profile-form-actions">
          <button type="submit" class="md-button md-button--filled md-button--small">
            <span class="material-symbols-rounded">save</span>
            Save Changes
          </button>
        </div>
        <div class="profile-feedback hidden" data-feedback></div>
      </form>
    `;
  }
  return `
    <div class="md-card" data-section="${sectionId}">
      ${headerMarkup}
      ${bodyMarkup}
    </div>
  `;
}

function getProfileSalaryDetails() {
  const payrollSalary = profileData?.payroll?.grossPay;
  const baseSalary = profileData?.salary?.amount;

  const amount = Number.isFinite(payrollSalary)
    ? payrollSalary
    : Number.isFinite(baseSalary)
      ? baseSalary
      : null;
  const currency = profileData?.salary?.currency || 'MMK';
  const month = profileData?.salary?.month || profileData?.payroll?.month || null;

  return { amount, currency, month };
}

function setPayslipFeedback(message, type = 'success') {
  const feedback = document.getElementById('profilePayslipFeedback');
  if (!feedback) return;
  feedback.textContent = message || '';
  feedback.classList.toggle('hidden', !message);
  feedback.classList.toggle('error', type === 'error');
}

function renderProfilePayslipCard() {
  const statusEl = document.getElementById('profilePayslipStatus');
  const button = document.getElementById('profilePayslipButton');
  if (!statusEl || !button) return;

  const { amount, currency, month } = getProfileSalaryDetails();
  const hasSalary = Number.isFinite(amount) && amount > 0;

  if (hasSalary) {
    const formattedAmount = formatSalaryAmount(amount, currency);
    const monthLabel = month ? ` for ${month}` : '';
    statusEl.textContent = `Salary detected${monthLabel}: ${formattedAmount}.`;
    button.disabled = false;
    button.title = 'Generate a PDF payslip using your salary data.';
  } else {
    statusEl.textContent = 'Payslip generation is unavailable until a salary above 0 is set.';
    button.disabled = true;
    button.title = 'Salary details are required to generate a payslip.';
  }

  setPayslipFeedback('');
}

function getPayslipFilename(disposition, fallback = 'payslip.pdf') {
  if (typeof disposition !== 'string') return fallback;
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

async function onGeneratePayslipClick() {
  const button = document.getElementById('profilePayslipButton');
  const { month } = getProfileSalaryDetails();
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  setPayslipFeedback('');
  if (button) button.disabled = true;

  try {
    const res = await apiFetch(`/api/my-payslip${query}`);
    const contentType = res.headers.get('Content-Type') || '';
    if (!res.ok) {
      let errorMessage = 'Unable to generate payslip right now.';
      if (contentType.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        if (data?.error) errorMessage = data.error;
      }
      throw new Error(errorMessage);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const filename = getPayslipFilename(res.headers.get('Content-Disposition'), month ? `payslip-${month}.pdf` : 'payslip.pdf');
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setPayslipFeedback('Payslip generated and downloaded.');
  } catch (err) {
    setPayslipFeedback(err.message || 'Unable to download payslip.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function renderMyProfile() {
  if (!profileData) return;
  const {
    name,
    email,
    summary = {},
    leaveBalances = {},
    availableLeaveBalances = null,
    sections = [],
    message = '',
    messageType = 'success'
  } = profileData;

  setProfileSummaryField('profileSummaryName', name);
  setProfileSummaryField('profileSummaryEmail', email);
  setProfileSummaryField('profileSummaryTitle', summary.title);
  setProfileSummaryField('profileSummaryDepartment', summary.department);
  setProfileSummaryField('profileSummaryManager', summary.manager);
  setProfileSummaryField('profileSummaryStatus', summary.status);

  const balancesForDisplay = availableLeaveBalances || leaveBalances;
  const normalizedBalances = normalizeLeaveBalanceMap(balancesForDisplay);
  setBalanceValue('profileBalAnnual', normalizedBalances.annual);
  setBalanceValue('profileBalCasual', normalizedBalances.casual);
  setBalanceValue('profileBalMedical', normalizedBalances.medical);

  const container = document.getElementById('profileSections');
  if (container) {
    if (!sections.length) {
      container.innerHTML = `
        <div class="md-card">
          <div class="card-title">
            <span class="material-symbols-rounded">info</span>
            Profile Details
          </div>
          <p class="text-muted" style="font-style: italic;">No profile information recorded yet.</p>
        </div>
      `;
    } else {
      container.innerHTML = sections.map(renderProfileSection).join('');
      container.querySelectorAll('.profile-section-form').forEach(form => {
        form.addEventListener('submit', onProfileSectionSubmit);
      });
    }
  }

  renderProfilePayslipCard();

  const feedback = document.getElementById('profileGlobalFeedback');
  if (feedback) {
    if (message) {
      feedback.textContent = message;
      feedback.classList.remove('hidden');
      if (messageType === 'error') {
        feedback.classList.add('error');
      } else {
        feedback.classList.remove('error');
      }
    } else {
      feedback.textContent = '';
      feedback.classList.add('hidden');
      feedback.classList.remove('error');
    }
  }
}

async function loadMyProfile({ force = false } = {}) {
  const container = document.getElementById('profileSections');
  if (!container) return;

  if (!force && profileData && !profileLoading) {
    renderMyProfile();
    return;
  }

  if (profileLoading && !force) {
    return profileLoading;
  }

  container.innerHTML = `
    <div class="md-card">
      <div class="card-title">
        <span class="material-symbols-rounded">info</span>
        Profile Details
      </div>
      <p class="text-muted" style="font-style: italic;">Loading profile information...</p>
    </div>
  `;

  const request = (async () => {
    try {
      const [profileRes, approvedApps] = await Promise.all([
        apiFetch('/api/my-profile'),
        getJSON('/applications?status=approved')
      ]);

      const data = await profileRes.json().catch(() => ({}));
      if (!profileRes.ok) {
        throw new Error(data.error || 'Unable to load profile information.');
      }
      const { available, usage } = buildAvailableLeaveState(
        data.leaveBalances,
        Array.isArray(approvedApps) ? approvedApps : []
      );
      profileData = {
        ...data,
        availableLeaveBalances: available,
        leaveUsage: usage
      };
      renderMyProfile();
      return data;
    } catch (err) {
      console.error('Failed to load profile information', err);
      profileData = null;
      container.innerHTML = `
        <div class="md-card">
          <div class="card-title">
            <span class="material-symbols-rounded">error</span>
            Profile Details
          </div>
          <p class="text-muted" style="font-style: italic; color:#b3261e;">${escapeHtml(err.message || 'Unable to load profile information.')}</p>
        </div>
      `;
      const feedback = document.getElementById('profileGlobalFeedback');
      if (feedback) {
        feedback.textContent = '';
        feedback.classList.add('hidden');
        feedback.classList.remove('error');
      }
      return null;
    } finally {
      profileLoading = null;
    }
  })();
  profileLoading = request;
  return request;
}

async function onProfileSectionSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const feedback = form.querySelector('[data-feedback]');
  if (feedback) {
    feedback.textContent = '';
    feedback.classList.add('hidden');
    feedback.classList.remove('error');
  }

  const updates = {};
  form.querySelectorAll('[data-editable-field]').forEach(input => {
    if (!input.name) return;
    updates[input.name] = input.value;
  });

  const updateKeys = Object.keys(updates);
  if (!updateKeys.length) {
    if (feedback) {
      feedback.textContent = 'No editable fields in this section.';
      feedback.classList.remove('hidden');
      feedback.classList.add('error');
    }
    return;
  }

  try {
    if (submitBtn) submitBtn.disabled = true;
    const res = await apiFetch('/api/my-profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update profile.');
    }
    profileData = data;
    renderMyProfile();
  } catch (err) {
    console.error('Failed to update profile', err);
    if (feedback) {
      feedback.textContent = err.message || 'Unable to save changes right now.';
      feedback.classList.remove('hidden');
      feedback.classList.add('error');
    } else {
      alert(err.message || 'Unable to save changes right now.');
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function formatHolidayDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatHolidayWeekday(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}

async function fetchHolidays({ force = false } = {}) {
  if (!force && holidaysLoaded && !holidaysLoading) {
    return companyHolidays;
  }
  if (!force && holidaysLoading) {
    return holidaysLoading;
  }
  const request = (async () => {
    try {
      const res = await apiFetch('/holidays');
      if (!res.ok) throw new Error('Failed to load holidays');
      const data = await res.json();
      companyHolidays = Array.isArray(data) ? data.slice() : [];
      companyHolidays.sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
      holidaysLoaded = true;
      return companyHolidays;
    } catch (err) {
      holidaysLoaded = false;
      throw err;
    } finally {
      holidaysLoading = null;
    }
  })();
  holidaysLoading = request;
  return request;
}

function renderHolidayHighlights(options = {}) {
  const container = document.getElementById('holidayHighlights');
  if (!container) return;
  const { error } = options;
  if (error) {
    container.innerHTML = `<p class="text-muted" style="font-style: italic; color:#b3261e;">${escapeHtml(error)}</p>`;
    return;
  }
  const holidays = Array.isArray(companyHolidays) ? companyHolidays.slice() : [];
  if (!holidays.length) {
    container.innerHTML = '<p class="text-muted" style="font-style: italic;">No upcoming holidays recorded.</p>';
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const upcoming = holidays.filter(holiday => {
    if (!holiday || !holiday.date) return false;
    const parsed = new Date(holiday.date);
    if (Number.isNaN(parsed.getTime())) return false;
    parsed.setHours(0, 0, 0, 0);
    return parsed >= today;
  });
  const source = upcoming.length ? upcoming : holidays;
  const limit = 5;
  const display = source.slice(0, limit);
  if (!display.length) {
    container.innerHTML = '<p class="text-muted" style="font-style: italic;">No upcoming holidays recorded.</p>';
    return;
  }
  const remainder = source.length - display.length;
  const needsFallbackNotice = upcoming.length === 0;
  const items = display.map(holiday => {
    const nameText = holiday?.name ? String(holiday.name) : 'Holiday';
    const safeName = escapeHtml(nameText);
    const dateValue = holiday?.date ? String(holiday.date) : '';
    const parsed = dateValue ? new Date(dateValue) : null;
    const hasValidDate = parsed && !Number.isNaN(parsed.getTime());
    let monthLabel = '';
    let dayLabel = '';
    const detailParts = [];
    if (hasValidDate) {
      monthLabel = parsed.toLocaleString(undefined, { month: 'short' });
      dayLabel = String(parsed.getDate()).padStart(2, '0');
      const pretty = formatHolidayDate(dateValue);
      if (pretty && pretty !== '-') detailParts.push(pretty);
      const weekday = formatHolidayWeekday(dateValue);
      if (weekday) detailParts.push(weekday);
    } else if (dateValue) {
      detailParts.push(dateValue);
    }
    const dateMarkup = hasValidDate
      ? `<div class="holiday-preview-date"><span class="holiday-preview-date__month">${escapeHtml(monthLabel)}</span><span class="holiday-preview-date__day">${escapeHtml(dayLabel)}</span></div>`
      : `<div class="holiday-preview-date holiday-preview-date--text">${escapeHtml(dateValue || '-')}</div>`;
    const metaMarkup = detailParts.length
      ? `<div class="holiday-preview-meta">${escapeHtml(detailParts.join(' • '))}</div>`
      : '';
    return `<div class="holiday-preview-item">${dateMarkup}<div class="holiday-preview-info"><div class="holiday-preview-name">${safeName}</div>${metaMarkup}</div></div>`;
  }).join('');
  const fallbackNotice = needsFallbackNotice
    ? '<p class="holiday-preview-empty text-muted">No upcoming holidays scheduled. Showing the most recent entries.</p>'
    : '';
  const moreMarkup = remainder > 0
    ? `<div class="holiday-preview-more text-quiet">+${remainder} more holiday${remainder === 1 ? '' : 's'} scheduled</div>`
    : '';
  container.innerHTML = fallbackNotice + items + moreMarkup;
}

async function loadHolidays(options = {}) {
  if (!currentUser || !isManagerRole(currentUser)) return;
  const { force = true } = options;
  const list = document.getElementById('holidayList');
  if (list && !list.dataset.persist) {
    list.innerHTML = '<p class="text-muted" style="font-style: italic;">Loading holidays...</p>';
  }
  try {
    await fetchHolidays({ force });
    renderHolidayList();
  } catch (err) {
    console.error('Failed to load holidays', err);
    if (list) {
      list.innerHTML = '<p class="text-muted" style="font-style: italic; color:#b3261e;">Unable to load holidays.</p>';
      list.dataset.persist = 'true';
    }
    renderHolidayHighlights({ error: 'Unable to load holidays.' });
  }
}

function renderHolidayList() {
  const list = document.getElementById('holidayList');
  if (list) {
    list.dataset.persist = 'true';
    if (!Array.isArray(companyHolidays) || companyHolidays.length === 0) {
      list.innerHTML = '<p class="text-muted" style="font-style: italic;">No holidays added yet.</p>';
      renderHolidayHighlights();
      return;
    }
    const items = companyHolidays.map(holiday => {
      const id = holiday?.id ? escapeHtml(String(holiday.id)) : '';
      const name = holiday?.name ? escapeHtml(String(holiday.name)) : '';
      const iso = holiday?.date ? escapeHtml(String(holiday.date)) : '';
      const formatted = escapeHtml(formatHolidayDate(holiday?.date));
      return `
        <div class="holiday-item">
          <div class="holiday-item__meta">
            <div class="holiday-item__date">${formatted}</div>
            <div class="holiday-item__name">${name}</div>
            <div class="holiday-item__iso text-quiet">${iso}</div>
          </div>
          <button type="button" class="md-button md-button--text md-button--small holiday-item__delete" data-action="delete-holiday" data-id="${id}">
            <span class="material-symbols-rounded">delete</span>
            Remove
          </button>
        </div>
      `;
    });
    list.innerHTML = items.join('');
  }
  renderHolidayHighlights();
}

async function onHolidaySubmit(ev) {
  ev.preventDefault();
  if (!currentUser || !isManagerRole(currentUser)) return;
  const dateInput = document.getElementById('holidayDate');
  const nameInput = document.getElementById('holidayName');
  const dateValue = dateInput?.value;
  const nameValue = nameInput?.value?.trim();
  if (!dateValue) {
    alert('Please choose a holiday date.');
    return;
  }
  if (!nameValue) {
    alert('Please enter a holiday name.');
    return;
  }
  try {
    const res = await apiFetch('/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateValue, name: nameValue })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to add holiday.');
    }
    if (Array.isArray(companyHolidays)) {
      companyHolidays = [...companyHolidays, data];
      companyHolidays.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    } else {
      companyHolidays = [data];
    }
    holidaysLoaded = true;
    renderHolidayList();
    if (dateInput) dateInput.value = '';
    if (nameInput) nameInput.value = '';
    const reportPanel = document.getElementById('leaveReportPanel');
    if (isManagerRole(currentUser) && reportPanel && !reportPanel.classList.contains('hidden')) {
      await loadLeaveCalendar();
    }
  } catch (err) {
    console.error('Failed to add holiday', err);
    alert(err.message || 'Failed to add holiday.');
  }
}

async function onHolidayListClick(ev) {
  const button = ev.target.closest('[data-action="delete-holiday"]');
  if (!button) return;
  const id = button.getAttribute('data-id');
  if (!id) return;
  if (!confirm('Remove this holiday?')) return;
  try {
    const res = await apiFetch('/holidays/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to delete holiday.');
    }
    companyHolidays = Array.isArray(companyHolidays) ? companyHolidays.filter(h => h.id !== id) : [];
    holidaysLoaded = true;
    renderHolidayList();
    const reportPanel = document.getElementById('leaveReportPanel');
    if (isManagerRole(currentUser) && reportPanel && !reportPanel.classList.contains('hidden')) {
      await loadLeaveCalendar();
    }
  } catch (err) {
    console.error('Failed to delete holiday', err);
    alert(err.message || 'Failed to delete holiday.');
  }
}

function setEmailSettingsStatus(message, type = 'info') {
  const statusEl = document.getElementById('emailSettingsStatus');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.remove('settings-status--error', 'settings-status--success');
  if (!message) {
    statusEl.classList.add('text-muted');
    return;
  }
  statusEl.classList.remove('text-muted');
  if (type === 'error') {
    statusEl.classList.add('settings-status--error');
  } else if (type === 'success') {
    statusEl.classList.add('settings-status--success');
  }
}

function rememberCustomEmailSettings() {
  const form = document.getElementById('emailSettingsForm');
  const providerSelect = document.getElementById('emailProvider');
  if (!form || !providerSelect || providerSelect.value === 'office365') return;
  const hostInput = document.getElementById('emailHost');
  const portInput = document.getElementById('emailPort');
  const secureCheckbox = document.getElementById('emailSecure');
  if (hostInput) form.dataset.customHost = hostInput.value;
  if (portInput) form.dataset.customPort = portInput.value;
  if (secureCheckbox) form.dataset.customSecure = secureCheckbox.checked ? 'true' : 'false';
}

function updateEmailSettingsFormState() {
  const form = document.getElementById('emailSettingsForm');
  const providerSelect = document.getElementById('emailProvider');
  const hostInput = document.getElementById('emailHost');
  const portInput = document.getElementById('emailPort');
  const secureCheckbox = document.getElementById('emailSecure');
  const authTypeSelect = document.getElementById('emailAuthType');
  if (!form || !providerSelect) return;
  const isOffice = providerSelect.value === 'office365';
  const previousProvider = form.dataset.provider || 'custom';
  const authType = authTypeSelect ? authTypeSelect.value : 'basic';

  if (isOffice) {
    if (hostInput) {
      if (previousProvider !== 'office365') {
        form.dataset.customHost = hostInput.value;
      }
      hostInput.value = 'smtp.office365.com';
      hostInput.setAttribute('disabled', '');
    }
    if (portInput) {
      if (previousProvider !== 'office365') {
        form.dataset.customPort = portInput.value;
      }
      portInput.value = '587';
      portInput.setAttribute('disabled', '');
    }
    if (secureCheckbox) {
      if (previousProvider !== 'office365') {
        form.dataset.customSecure = secureCheckbox.checked ? 'true' : 'false';
      }
      secureCheckbox.checked = false;
      secureCheckbox.setAttribute('disabled', '');
    }
  } else {
    if (hostInput) {
      hostInput.removeAttribute('disabled');
      if (previousProvider === 'office365') {
        hostInput.value = form.dataset.customHost || '';
      }
    }
    if (portInput) {
      portInput.removeAttribute('disabled');
      if (previousProvider === 'office365') {
        portInput.value = form.dataset.customPort || '';
      }
    }
    if (secureCheckbox) {
      secureCheckbox.removeAttribute('disabled');
      if (previousProvider === 'office365') {
        secureCheckbox.checked = form.dataset.customSecure === 'true';
      }
    }
    rememberCustomEmailSettings();
  }

  form.dataset.provider = isOffice ? 'office365' : 'custom';

  const basicSections = document.querySelectorAll('.auth-section--basic');
  basicSections.forEach(section => {
    if (authType === 'basic') {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  });
  const oauthSections = document.querySelectorAll('.auth-section--oauth');
  oauthSections.forEach(section => {
    if (authType === 'oauth2') {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  });
}

function onEmailProviderChange() {
  const form = document.getElementById('emailSettingsForm');
  const providerSelect = document.getElementById('emailProvider');
  if (!form) return;
  const previousProvider = form.dataset.provider || 'custom';
  if (previousProvider !== 'office365') {
    rememberCustomEmailSettings();
  }
  const authTypeSelect = document.getElementById('emailAuthType');
  if (providerSelect && providerSelect.value === 'office365' && authTypeSelect && authTypeSelect.value !== 'oauth2') {
    authTypeSelect.value = 'oauth2';
  }
  updateEmailSettingsFormState();
  if (providerSelect) {
    const message = providerSelect.value === 'office365'
      ? 'Microsoft 365 defaults applied. Provide modern auth credentials or save to confirm the change.'
      : 'Custom SMTP selected. Update the fields and save to apply.';
    setEmailSettingsStatus(message);
  }
}

function onEmailAuthTypeChange() {
  updateEmailSettingsFormState();
  const authTypeSelect = document.getElementById('emailAuthType');
  if (!authTypeSelect) return;
  const message = authTypeSelect.value === 'oauth2'
    ? 'Modern authentication selected. Provide Azure AD OAuth credentials and save to enable notifications.'
    : 'Username & password authentication selected. Ensure basic authentication is allowed for your SMTP service.';
  setEmailSettingsStatus(message);
}

function renderEmailSettingsForm() {
  const form = document.getElementById('emailSettingsForm');
  if (!form) return;
  const enabledInput = document.getElementById('emailEnabled');
  const providerSelect = document.getElementById('emailProvider');
  const authTypeSelect = document.getElementById('emailAuthType');
  const hostInput = document.getElementById('emailHost');
  const portInput = document.getElementById('emailPort');
  const secureCheckbox = document.getElementById('emailSecure');
  const userInput = document.getElementById('emailUser');
  const fromInput = document.getElementById('emailFrom');
  const replyInput = document.getElementById('emailReplyTo');
  const passwordInput = document.getElementById('emailPassword');
  const oauthTenantInput = document.getElementById('emailOAuthTenant');
  const oauthClientIdInput = document.getElementById('emailOAuthClientId');
  const oauthScopeInput = document.getElementById('emailOAuthScope');
  const oauthClientSecretInput = document.getElementById('emailOAuthClientSecret');
  const oauthRefreshTokenInput = document.getElementById('emailOAuthRefreshToken');
  const recipientsContainer = document.getElementById('emailRecipients');
  const recipientsHelp = document.getElementById('emailRecipientsHelp');
  const help = document.getElementById('emailPasswordHelp');
  const oauthClientSecretHelp = document.getElementById('emailOAuthClientSecretHelp');
  const oauthRefreshTokenHelp = document.getElementById('emailOAuthRefreshTokenHelp');
  const templateRequestSubject = document.getElementById('emailTemplateRequestSubject');
  const templateRequestBody = document.getElementById('emailTemplateRequestBody');
  const templateApproveSubject = document.getElementById('emailTemplateApproveSubject');
  const templateApproveBody = document.getElementById('emailTemplateApproveBody');
  const templateRejectSubject = document.getElementById('emailTemplateRejectSubject');
  const templateRejectBody = document.getElementById('emailTemplateRejectBody');
  const templateCancelSubject = document.getElementById('emailTemplateCancelSubject');
  const templateCancelBody = document.getElementById('emailTemplateCancelBody');
  const settings = emailSettings || {};
  if (enabledInput) enabledInput.checked = Boolean(settings.enabled);
  const provider = settings.provider === 'office365' ? 'office365' : 'custom';
  if (providerSelect) providerSelect.value = provider;
  const authType = settings.authType === 'oauth2' ? 'oauth2' : 'basic';
  if (authTypeSelect) authTypeSelect.value = authType;
  if (hostInput) hostInput.value = settings.host || (provider === 'office365' ? 'smtp.office365.com' : '');
  if (portInput) portInput.value = settings.port != null ? settings.port : (provider === 'office365' ? 587 : '');
  if (secureCheckbox) secureCheckbox.checked = Boolean(settings.secure);
  if (userInput) userInput.value = settings.user || '';
  if (fromInput) fromInput.value = settings.from || '';
  if (replyInput) replyInput.value = settings.replyTo || '';
  if (oauthTenantInput) oauthTenantInput.value = settings.oauthTenant || '';
  if (oauthClientIdInput) oauthClientIdInput.value = settings.oauthClientId || '';
  if (oauthScopeInput) oauthScopeInput.value = settings.oauthScope || 'https://outlook.office365.com/.default';
  if (oauthClientSecretInput) {
    oauthClientSecretInput.value = '';
    oauthClientSecretInput.dataset.dirty = 'false';
  }
  if (oauthRefreshTokenInput) {
    oauthRefreshTokenInput.value = '';
    oauthRefreshTokenInput.dataset.dirty = 'false';
  }
  if (recipientsContainer) {
    const normalizedOptions = [];
    const seen = new Set();
    const addOption = (email, name = '') => {
      if (!email) return;
      const trimmed = typeof email === 'string' ? email.trim() : String(email || '').trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      normalizedOptions.push({ email: trimmed, name: name ? String(name).trim() : '' });
    };
    const baseOptions = Array.isArray(emailRecipientOptions) ? emailRecipientOptions : [];
    baseOptions.forEach(option => addOption(option?.email, option?.name));
    const selectedEmails = Array.isArray(settings.recipients)
      ? settings.recipients
          .map(value => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
          .filter(Boolean)
      : [];
    const selectedSet = new Set(selectedEmails.map(email => email.toLowerCase()));
    selectedEmails.forEach(email => addOption(email));
    if (!normalizedOptions.length) {
      recipientsContainer.innerHTML = '<p class="email-recipient-empty">No manager email addresses are available yet.</p>';
      if (recipientsHelp) {
        recipientsHelp.textContent = 'Add manager accounts with email addresses to enable notifications.';
      }
    } else {
      const items = normalizedOptions
        .map((option, index) => {
          const emailValue = option.email;
          if (!emailValue) return '';
          const inputId = `emailRecipient${index}`;
          const checked = selectedSet.has(emailValue.toLowerCase()) ? ' checked' : '';
          const labelText = option.name ? `${option.name} (${emailValue})` : emailValue;
          const safeValue = escapeHtml(emailValue);
          const safeLabel = escapeHtml(labelText);
          return `
            <label class="email-recipient-item" for="${inputId}">
              <input type="checkbox" id="${inputId}" name="emailRecipients" value="${safeValue}"${checked}>
              <span>${safeLabel}</span>
            </label>
          `;
        })
        .filter(Boolean)
        .join('');
      recipientsContainer.innerHTML = items || '<p class="email-recipient-empty">No manager email addresses are available yet.</p>';
      if (recipientsHelp) {
        recipientsHelp.textContent = 'Select which managers should receive leave notification emails.';
      }
    }
  } else if (recipientsHelp) {
    recipientsHelp.textContent = 'Select which managers should receive leave notification emails.';
  }
  if (passwordInput) {
    passwordInput.value = '';
    passwordInput.dataset.dirty = 'false';
  }
  if (help) {
    help.textContent = emailSettingsHasPassword
      ? 'Password is hidden. Enter a new value to update it.'
      : 'Provide the SMTP account password.';
  }
  if (oauthClientSecretHelp) {
    oauthClientSecretHelp.textContent = emailSettingsHasClientSecret
      ? 'Client secret is hidden. Enter a new value to update it.'
      : 'Provide the Azure AD application client secret.';
  }
  if (oauthRefreshTokenHelp) {
    oauthRefreshTokenHelp.textContent = emailSettingsHasRefreshToken
      ? 'Refresh token is hidden. Enter a new value to update it.'
      : 'Provide a delegated refresh token if your app uses delegated permissions.';
  }
  const templates = {
    ...DEFAULT_LEAVE_EMAIL_TEMPLATES,
    ...(settings.templates && typeof settings.templates === 'object' ? settings.templates : {})
  };
  if (templateRequestSubject) templateRequestSubject.value = templates.requestSubject || '';
  if (templateRequestBody) templateRequestBody.value = templates.requestBody || '';
  if (templateApproveSubject) templateApproveSubject.value = templates.approveSubject || '';
  if (templateApproveBody) templateApproveBody.value = templates.approveBody || '';
  if (templateRejectSubject) templateRejectSubject.value = templates.rejectSubject || '';
  if (templateRejectBody) templateRejectBody.value = templates.rejectBody || '';
  if (templateCancelSubject) templateCancelSubject.value = templates.cancelSubject || '';
  if (templateCancelBody) templateCancelBody.value = templates.cancelBody || '';
  if (provider !== 'office365') {
    rememberCustomEmailSettings();
  }
  updateEmailSettingsFormState();
}

async function fetchEmailSettings({ force = false } = {}) {
  if (!force && emailSettingsLoaded && !emailSettingsLoading) {
    return {
      settings: emailSettings,
      hasPassword: emailSettingsHasPassword,
      hasClientSecret: emailSettingsHasClientSecret,
      hasRefreshToken: emailSettingsHasRefreshToken
    };
  }
  if (!force && emailSettingsLoading) {
    return emailSettingsLoading;
  }
  const request = (async () => {
    try {
      const res = await apiFetch('/settings/email');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load email settings.');
      }
      const {
        recipientOptions: options = [],
        hasPassword = false,
        hasClientSecret = false,
        hasRefreshToken = false,
        ...settingsData
      } = data;
      emailRecipientOptions = Array.isArray(options) ? options : [];
      emailSettings = { ...settingsData };
      emailSettingsHasPassword = Boolean(hasPassword);
      emailSettingsHasClientSecret = Boolean(hasClientSecret);
      emailSettingsHasRefreshToken = Boolean(hasRefreshToken);
      emailSettingsLoaded = true;
      return {
        settings: emailSettings,
        hasPassword: emailSettingsHasPassword,
        hasClientSecret: emailSettingsHasClientSecret,
        hasRefreshToken: emailSettingsHasRefreshToken
      };
    } catch (err) {
      emailSettingsLoaded = false;
      throw err;
    } finally {
      emailSettingsLoading = null;
    }
  })();
  emailSettingsLoading = request;
  return request;
}

async function loadEmailSettingsConfig({ force = false } = {}) {
  if (!currentUser || !isManagerRole(currentUser)) return;
  if (!force && emailSettingsLoaded) {
    renderEmailSettingsForm();
    const statusMessage = emailSettings?.enabled
      ? 'Email notifications are enabled.'
      : 'Email notifications are currently disabled.';
    setEmailSettingsStatus(statusMessage);
    return;
  }
  setEmailSettingsStatus('Loading email settings...');
  try {
    const result = await fetchEmailSettings({ force });
    emailSettings = result.settings;
    emailSettingsHasPassword = Boolean(result.hasPassword);
    emailSettingsHasClientSecret = Boolean(result.hasClientSecret);
    emailSettingsHasRefreshToken = Boolean(result.hasRefreshToken);
    renderEmailSettingsForm();
    const statusMessage = emailSettings?.enabled
      ? 'Email notifications are enabled.'
      : 'Email notifications are currently disabled.';
    setEmailSettingsStatus(statusMessage);
  } catch (err) {
    console.error('Failed to load email settings', err);
    setEmailSettingsStatus(err.message || 'Unable to load email settings.', 'error');
  }
}

async function onEmailSettingsSubmit(ev) {
  ev.preventDefault();
  if (!currentUser || !isManagerRole(currentUser)) return;
  const form = ev.currentTarget;
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setEmailSettingsStatus('Saving email settings...');
  try {
    const providerSelect = document.getElementById('emailProvider');
    const authTypeSelect = document.getElementById('emailAuthType');
    const passwordInput = document.getElementById('emailPassword');
    const oauthTenantInput = document.getElementById('emailOAuthTenant');
    const oauthClientIdInput = document.getElementById('emailOAuthClientId');
    const oauthScopeInput = document.getElementById('emailOAuthScope');
    const oauthClientSecretInput = document.getElementById('emailOAuthClientSecret');
    const oauthRefreshTokenInput = document.getElementById('emailOAuthRefreshToken');
    const templateRequestSubject = document.getElementById('emailTemplateRequestSubject');
    const templateRequestBody = document.getElementById('emailTemplateRequestBody');
    const templateApproveSubject = document.getElementById('emailTemplateApproveSubject');
    const templateApproveBody = document.getElementById('emailTemplateApproveBody');
    const templateRejectSubject = document.getElementById('emailTemplateRejectSubject');
    const templateRejectBody = document.getElementById('emailTemplateRejectBody');
    const templateCancelSubject = document.getElementById('emailTemplateCancelSubject');
    const templateCancelBody = document.getElementById('emailTemplateCancelBody');
    const recipientInputs = Array.from(document.querySelectorAll('input[name="emailRecipients"]'));
    const selectedRecipients = recipientInputs
      .filter(input => input instanceof HTMLInputElement && input.checked)
      .map(input => input.value?.trim())
      .filter(Boolean);
    const payload = {
      enabled: document.getElementById('emailEnabled')?.checked ?? false,
      provider: providerSelect && providerSelect.value === 'office365' ? 'office365' : 'custom',
      host: document.getElementById('emailHost')?.value?.trim() || '',
      port: Number(document.getElementById('emailPort')?.value || 0),
      secure: document.getElementById('emailSecure')?.checked || false,
      user: document.getElementById('emailUser')?.value?.trim() || '',
      from: document.getElementById('emailFrom')?.value?.trim() || '',
      replyTo: document.getElementById('emailReplyTo')?.value?.trim() || '',
      updatePassword: passwordInput?.dataset?.dirty === 'true',
      password: passwordInput?.value || '',
      recipients: selectedRecipients,
      authType: authTypeSelect && authTypeSelect.value === 'oauth2' ? 'oauth2' : 'basic',
      oauthTenant: oauthTenantInput?.value?.trim() || '',
      oauthClientId: oauthClientIdInput?.value?.trim() || '',
      oauthScope: oauthScopeInput?.value?.trim() || '',
      updateClientSecret: oauthClientSecretInput?.dataset?.dirty === 'true',
      oauthClientSecret: oauthClientSecretInput?.value || '',
      updateRefreshToken: oauthRefreshTokenInput?.dataset?.dirty === 'true',
      oauthRefreshToken: oauthRefreshTokenInput?.value || '',
      templates: {
        requestSubject: templateRequestSubject?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.requestSubject,
        requestBody: templateRequestBody?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.requestBody,
        approveSubject: templateApproveSubject?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.approveSubject,
        approveBody: templateApproveBody?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.approveBody,
        rejectSubject: templateRejectSubject?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.rejectSubject,
        rejectBody: templateRejectBody?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.rejectBody,
        cancelSubject: templateCancelSubject?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.cancelSubject,
        cancelBody: templateCancelBody?.value?.trim() || DEFAULT_LEAVE_EMAIL_TEMPLATES.cancelBody
      }
    };
    const wantsRefreshToken = payload.updateRefreshToken
      ? Boolean(payload.oauthRefreshToken)
      : emailSettingsHasRefreshToken;
    payload.oauthGrantType = wantsRefreshToken ? 'refresh_token' : 'client_credentials';
    if (!payload.updatePassword) {
      delete payload.password;
    }
    if (!payload.updateClientSecret) {
      delete payload.oauthClientSecret;
    }
    if (!payload.updateRefreshToken) {
      delete payload.oauthRefreshToken;
    }
    const res = await apiFetch('/settings/email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save email settings.');
    }
    const {
      recipientOptions: updatedOptions = [],
      hasPassword = false,
      hasClientSecret = false,
      hasRefreshToken = false,
      ...settingsData
    } = data;
    if (Array.isArray(updatedOptions)) {
      emailRecipientOptions = updatedOptions;
    }
    emailSettings = { ...settingsData };
    emailSettingsHasPassword = Boolean(hasPassword);
    emailSettingsHasClientSecret = Boolean(hasClientSecret);
    emailSettingsHasRefreshToken = Boolean(hasRefreshToken);
    emailSettingsLoaded = true;
    renderEmailSettingsForm();
    setEmailSettingsStatus('Email settings saved successfully.', 'success');
  } catch (err) {
    console.error('Failed to save email settings', err);
    setEmailSettingsStatus(err.message || 'Unable to save email settings.', 'error');
  } finally {
    const passwordInput = document.getElementById('emailPassword');
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.dataset.dirty = 'false';
      const help = document.getElementById('emailPasswordHelp');
      if (help) {
        help.textContent = emailSettingsHasPassword
          ? 'Password is hidden. Enter a new value to update it.'
          : 'Provide the SMTP account password.';
      }
    }
    const oauthClientSecretInputFinal = document.getElementById('emailOAuthClientSecret');
    if (oauthClientSecretInputFinal) {
      oauthClientSecretInputFinal.value = '';
      oauthClientSecretInputFinal.dataset.dirty = 'false';
      const help = document.getElementById('emailOAuthClientSecretHelp');
      if (help) {
        help.textContent = emailSettingsHasClientSecret
          ? 'Client secret is hidden. Enter a new value to update it.'
          : 'Provide the Azure AD application client secret.';
      }
    }
    const oauthRefreshTokenInputFinal = document.getElementById('emailOAuthRefreshToken');
    if (oauthRefreshTokenInputFinal) {
      oauthRefreshTokenInputFinal.value = '';
      oauthRefreshTokenInputFinal.dataset.dirty = 'false';
      const help = document.getElementById('emailOAuthRefreshTokenHelp');
      if (help) {
        help.textContent = emailSettingsHasRefreshToken
          ? 'Refresh token is hidden. Enter a new value to update it.'
          : 'Provide a delegated refresh token if your app uses delegated permissions.';
      }
    }
    if (submitBtn) submitBtn.disabled = false;
  }
}

function setAiSettingsStatus(message, type = 'info') {
  const statusEl = document.getElementById('aiSettingsStatus');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.remove('settings-status--error', 'settings-status--success');
  if (!message) {
    statusEl.classList.add('text-muted');
    return;
  }
  statusEl.classList.remove('text-muted');
  if (type === 'error') {
    statusEl.classList.add('settings-status--error');
  } else if (type === 'success') {
    statusEl.classList.add('settings-status--success');
  }
}

function renderAiSettingsForm() {
  const modelSelect = document.getElementById('aiModel');
  if (modelSelect) {
    modelSelect.innerHTML = (aiModelOptions || [])
      .map(option => `<option value="${option.value}">${option.label || option.value}</option>`)
      .join('');
    const preferredModel = aiSettings?.model || aiModelOptions?.[0]?.value || '';
    modelSelect.value = preferredModel;
  }

  const questionPromptInput = document.getElementById('aiQuestionPrompt');
  if (questionPromptInput) {
    questionPromptInput.value = aiSettings?.questionPrompt || '';
  }

  const screeningPromptInput = document.getElementById('aiScreeningPrompt');
  if (screeningPromptInput) {
    screeningPromptInput.value = aiSettings?.screeningPrompt || '';
  }
}

async function fetchAiSettings({ force = false } = {}) {
  if (!force && aiSettingsLoaded && !aiSettingsLoading) {
    return { settings: aiSettings, modelOptions: aiModelOptions };
  }
  if (!force && aiSettingsLoading) {
    return aiSettingsLoading;
  }

  const request = (async () => {
    const res = await apiFetch('/settings/ai');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Unable to load AI settings.');
    }
    const settings = data.settings || {};
    const modelOptions = Array.isArray(data.modelOptions) ? data.modelOptions : [];
    return { settings, modelOptions };
  })();

  aiSettingsLoading = request;

  try {
    const result = await request;
    aiSettings = result.settings || {};
    aiModelOptions = result.modelOptions && result.modelOptions.length ? result.modelOptions : aiModelOptions;
    aiSettingsLoaded = true;
    return result;
  } finally {
    aiSettingsLoading = null;
  }
}

async function loadAiSettingsConfig({ force = false } = {}) {
  if (!currentUser || !isManagerRole(currentUser)) return;
  if (!force && aiSettingsLoaded) {
    renderAiSettingsForm();
    setAiSettingsStatus('AI settings loaded.');
    return;
  }
  setAiSettingsStatus('Loading AI settings...');
  try {
    const result = await fetchAiSettings({ force });
    aiSettings = result.settings || {};
    aiModelOptions = result.modelOptions && result.modelOptions.length ? result.modelOptions : aiModelOptions;
    aiSettingsLoaded = true;
    renderAiSettingsForm();
    setAiSettingsStatus('AI settings loaded.');
  } catch (err) {
    console.error('Unable to load AI settings', err);
    setAiSettingsStatus(err.message || 'Unable to load AI settings.', 'error');
  }
}

async function onAiSettingsSubmit(ev) {
  ev.preventDefault();
  if (!currentUser || !isManagerRole(currentUser)) return;
  const form = ev.currentTarget;
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setAiSettingsStatus('Saving AI settings...');
  try {
    const payload = {
      model: document.getElementById('aiModel')?.value || '',
      questionPrompt: document.getElementById('aiQuestionPrompt')?.value || '',
      screeningPrompt: document.getElementById('aiScreeningPrompt')?.value || ''
    };
    const res = await apiFetch('/settings/ai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save AI settings.');
    }
    aiSettings = data.settings || payload;
    aiModelOptions = Array.isArray(data.modelOptions) && data.modelOptions.length ? data.modelOptions : aiModelOptions;
    aiSettingsLoaded = true;
    renderAiSettingsForm();
    setAiSettingsStatus('AI settings saved successfully.', 'success');
  } catch (err) {
    console.error('Failed to save AI settings', err);
    setAiSettingsStatus(err.message || 'Unable to save AI settings.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function setChatWidgetSettingsStatus(message, type = 'info') {
  const statusEl = document.getElementById('chatWidgetSettingsStatus');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.remove('settings-status--error', 'settings-status--success');
  if (!message) {
    statusEl.classList.add('text-muted');
    return;
  }
  statusEl.classList.remove('text-muted');
  if (type === 'error') {
    statusEl.classList.add('settings-status--error');
  } else if (type === 'success') {
    statusEl.classList.add('settings-status--success');
  }
}

function renderChatWidgetSettingsForm() {
  const urlInput = document.getElementById('chatWidgetUrl');
  const helpText = document.getElementById('chatWidgetUrlHelp');
  if (urlInput) {
    urlInput.value = chatWidgetSettings?.hasCustom ? chatWidgetSettings.url : '';
    urlInput.placeholder = chatWidgetSettings?.defaultUrl || DEFAULT_CHAT_WIDGET_URL;
  }
  if (helpText) {
    const defaultUrl = chatWidgetSettings?.defaultUrl || DEFAULT_CHAT_WIDGET_URL;
    helpText.textContent = `Default widget URL: ${defaultUrl}`;
  }
}

function resetChatWidgetUrlToDefault() {
  const urlInput = document.getElementById('chatWidgetUrl');
  if (urlInput) {
    urlInput.value = '';
    urlInput.placeholder = chatWidgetSettings?.defaultUrl || DEFAULT_CHAT_WIDGET_URL;
  }
  setChatWidgetSettingsStatus('Default widget URL will be used after saving.');
}

async function fetchChatWidgetSettings({ force = false } = {}) {
  if (!force && chatWidgetSettingsLoaded && !chatWidgetSettingsLoading) {
    return chatWidgetSettings;
  }
  if (!force && chatWidgetSettingsLoading) {
    return chatWidgetSettingsLoading;
  }

  const request = (async () => {
    const res = await apiFetch('/settings/widget');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Unable to load chat widget settings.');
    }
    return data;
  })();

  chatWidgetSettingsLoading = request;

  try {
    const settings = await request;
    chatWidgetSettings = settings || {};
    chatWidgetSettingsLoaded = true;
    return settings;
  } finally {
    chatWidgetSettingsLoading = null;
  }
}

async function loadChatWidgetSettings({ force = false, silent = false } = {}) {
  if (!currentUser) return;
  if (!force && chatWidgetSettingsLoaded) {
    renderChatWidgetSettingsForm();
    if (!silent) setChatWidgetSettingsStatus('Chat widget settings loaded.');
    updateChatWidgetUser(currentUser?.employeeId);
    return;
  }
  if (!silent) setChatWidgetSettingsStatus('Loading chat widget settings...');
  try {
    const settings = await fetchChatWidgetSettings({ force });
    chatWidgetSettings = settings || {};
    chatWidgetSettingsLoaded = true;
    renderChatWidgetSettingsForm();
    if (!silent) setChatWidgetSettingsStatus('Chat widget settings loaded.');
  } catch (err) {
    console.error('Unable to load chat widget settings', err);
    if (!silent) {
      setChatWidgetSettingsStatus(err.message || 'Unable to load chat widget settings.', 'error');
    }
  } finally {
    updateChatWidgetUser(currentUser?.employeeId);
  }
}

async function onChatWidgetSettingsSubmit(ev) {
  ev.preventDefault();
  if (!currentUser || !isManagerRole(currentUser)) return;
  const form = ev.currentTarget;
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setChatWidgetSettingsStatus('Saving chat widget settings...');
  try {
    const urlInput = document.getElementById('chatWidgetUrl');
    const urlValue = urlInput?.value ? urlInput.value.trim() : '';
    const payload = { url: urlValue };
    const res = await apiFetch('/settings/widget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save chat widget settings.');
    }
    chatWidgetSettings = data || payload;
    chatWidgetSettingsLoaded = true;
    renderChatWidgetSettingsForm();
    updateChatWidgetUser(currentUser?.employeeId);
    setChatWidgetSettingsStatus('Chat widget settings saved successfully.', 'success');
  } catch (err) {
    console.error('Failed to save chat widget settings', err);
    setChatWidgetSettingsStatus(err.message || 'Unable to save chat widget settings.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function setPostLoginSettingsStatus(message, type = 'info') {
  const statusEl = document.getElementById('postLoginSettingsStatus');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.classList.remove('settings-status--error', 'settings-status--success');
  if (!message) {
    statusEl.classList.add('text-muted');
    return;
  }
  statusEl.classList.remove('text-muted');
  if (type === 'error') {
    statusEl.classList.add('settings-status--error');
  } else if (type === 'success') {
    statusEl.classList.add('settings-status--success');
  }
}

function renderPostLoginSettingsForm() {
  const urlInput = document.getElementById('postLoginUrl');
  const tokenInput = document.getElementById('postLoginToken');
  const helpText = document.getElementById('postLoginSettingsHelp');
  if (urlInput) {
    urlInput.value = postLoginSettings?.hasCustomUrl ? postLoginSettings.url : '';
    urlInput.placeholder = postLoginSettings?.defaultUrl || DEFAULT_POST_LOGIN_URL;
  }
  if (tokenInput) {
    tokenInput.value = postLoginSettings?.hasCustomToken ? postLoginSettings.token : '';
    tokenInput.placeholder = postLoginSettings?.hasCustomToken
      ? ''
      : 'Using default authorization token';
  }
  if (helpText) {
    const defaultUrl = postLoginSettings?.defaultUrl || DEFAULT_POST_LOGIN_URL;
    helpText.textContent = `Default sync URL: ${defaultUrl}`;
  }
}

function resetPostLoginSettingsToDefault() {
  const urlInput = document.getElementById('postLoginUrl');
  const tokenInput = document.getElementById('postLoginToken');
  if (urlInput) {
    urlInput.value = '';
    urlInput.placeholder = postLoginSettings?.defaultUrl || DEFAULT_POST_LOGIN_URL;
  }
  if (tokenInput) {
    tokenInput.value = '';
    tokenInput.placeholder = 'Using default authorization token';
  }
  setPostLoginSettingsStatus('Default post-login settings will be used after saving.');
}

async function fetchPostLoginSettings({ force = false } = {}) {
  if (!force && postLoginSettingsLoaded && !postLoginSettingsLoading) {
    return postLoginSettings;
  }
  if (!force && postLoginSettingsLoading) {
    return postLoginSettingsLoading;
  }

  const request = (async () => {
    const res = await apiFetch('/settings/post-login');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Unable to load post-login settings.');
    }
    return data;
  })();

  postLoginSettingsLoading = request;

  try {
    const settings = await request;
    postLoginSettings = settings || {};
    postLoginSettingsLoaded = true;
    return settings;
  } finally {
    postLoginSettingsLoading = null;
  }
}

async function loadPostLoginSettings({ force = false, silent = false } = {}) {
  if (!currentUser) return null;
  if (!force && postLoginSettingsLoaded) {
    renderPostLoginSettingsForm();
    if (!silent) setPostLoginSettingsStatus('Post-login settings loaded.');
    return postLoginSettings;
  }
  if (!silent) setPostLoginSettingsStatus('Loading post-login settings...');
  try {
    const settings = await fetchPostLoginSettings({ force });
    postLoginSettings = settings || {};
    postLoginSettingsLoaded = true;
    renderPostLoginSettingsForm();
    if (!silent) setPostLoginSettingsStatus('Post-login settings loaded.');
    return postLoginSettings;
  } catch (err) {
    console.error('Unable to load post-login settings', err);
    if (!silent) {
      setPostLoginSettingsStatus(err.message || 'Unable to load post-login settings.', 'error');
    }
    return null;
  }
}

async function onPostLoginSettingsSubmit(ev) {
  ev.preventDefault();
  if (!currentUser || !isManagerRole(currentUser)) return;
  const form = ev.currentTarget;
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  setPostLoginSettingsStatus('Saving post-login settings...');
  try {
    const urlInput = document.getElementById('postLoginUrl');
    const tokenInput = document.getElementById('postLoginToken');
    const payload = {
      url: urlInput?.value ? urlInput.value.trim() : '',
      token: tokenInput?.value ? tokenInput.value.trim() : ''
    };
    const res = await apiFetch('/settings/post-login', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save post-login settings.');
    }
    postLoginSettings = data || payload;
    postLoginSettingsLoaded = true;
    renderPostLoginSettingsForm();
    setPostLoginSettingsStatus('Post-login settings saved successfully.', 'success');
  } catch (err) {
    console.error('Failed to save post-login settings', err);
    setPostLoginSettingsStatus(err.message || 'Unable to save post-login settings.', 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function initRecruitment() {
  if (!currentUser || !isManagerRole(currentUser)) return;
  if (recruitmentInitialized) return;
  recruitmentInitialized = true;

  if (recruitmentSubtabButtons.length) {
    recruitmentSubtabButtons.forEach(button => {
      button.addEventListener('click', () => {
        updateRecruitmentSubtab(button.dataset.recruitmentSubtab);
      });
    });
  }
  updateRecruitmentSubtab(recruitmentActiveSubtab);

  const positionForm = document.getElementById('positionForm');
  if (positionForm) positionForm.addEventListener('submit', onPositionSubmit);

  const positionCancelBtn = document.getElementById('positionCancelEditBtn');
  if (positionCancelBtn) positionCancelBtn.addEventListener('click', onPositionEditCancel);

  const candidateForm = document.getElementById('candidateForm');
  if (candidateForm) candidateForm.addEventListener('submit', onCandidateSubmit);

  const candidateCancelBtn = document.getElementById('candidateCancelEditBtn');
  if (candidateCancelBtn) candidateCancelBtn.addEventListener('click', onCandidateEditCancel);

  const positionSelect = document.getElementById('candidatePositionSelect');
  if (positionSelect) positionSelect.addEventListener('change', onCandidatePositionChange);

  const positionsContainer = document.getElementById('positionsList');
  if (positionsContainer) positionsContainer.addEventListener('click', onPositionsListClick);

  const candidateTable = document.getElementById('candidateTableBody');
  if (candidateTable) {
    candidateTable.addEventListener('change', onCandidateStatusChange);
    candidateTable.addEventListener('click', onCandidateTableClick);
  }

  const candidateSearchInput = document.getElementById('candidateSearchInput');
  if (candidateSearchInput) candidateSearchInput.addEventListener('input', onCandidateSearchInput);

  const candidateSearchResults = document.getElementById('candidateSearchResults');
  if (candidateSearchResults) candidateSearchResults.addEventListener('click', onCandidateSearchResultsClick);

  const commentsList = document.getElementById('commentsList');
  if (commentsList) commentsList.addEventListener('click', onCommentsListClick);

  const commentFormEl = document.getElementById('commentForm');
  if (commentFormEl) commentFormEl.addEventListener('submit', onCommentSubmit);
  setCommentFormEnabled(false);

  const aiQuestionsList = document.getElementById('aiQuestionsList');
  if (aiQuestionsList) {
    aiQuestionsList.addEventListener('input', onAiQuestionListInput);
    aiQuestionsList.addEventListener('click', onAiQuestionListClick);
  }

  const addAiQuestionBtn = document.getElementById('addAiQuestionBtn');
  if (addAiQuestionBtn) addAiQuestionBtn.addEventListener('click', onAddAiQuestionClick);

  const generateAiQuestionsBtn = document.getElementById('generateAiQuestionsBtn');
  if (generateAiQuestionsBtn) {
    generateAiQuestionsBtn.addEventListener('click', onGenerateAiQuestionsClick);
  }

  renderRecruitmentPositionQuestions();

  const detailsCloseBtn = document.getElementById('candidateDetailsCloseBtn');
  if (detailsCloseBtn) detailsCloseBtn.onclick = closeCandidateDetailsModal;

  const detailsModal = document.getElementById('candidateDetailsModal');
  if (detailsModal) {
    detailsModal.addEventListener('click', ev => {
      if (ev.target === detailsModal) closeCandidateDetailsModal();
    });
  }

  const detailsDownloadBtn = document.getElementById('candidateDetailsDownloadBtn');
  if (detailsDownloadBtn) detailsDownloadBtn.addEventListener('click', onCandidateDetailsDownloadClick);

  const aiInterviewPanel = document.getElementById('candidateAiInterviewPanel');
  if (aiInterviewPanel) aiInterviewPanel.addEventListener('click', onCandidateAiPanelClick);

  const runAiScreeningBtn = document.getElementById('runAiScreeningBtn');
  if (runAiScreeningBtn) runAiScreeningBtn.addEventListener('click', onRunAiScreeningClick);

  const hireCloseBtn = document.getElementById('candidateHireCloseBtn');
  if (hireCloseBtn) hireCloseBtn.onclick = closeCandidateHireModal;

  const hireCancelBtn = document.getElementById('candidateHireCancelBtn');
  if (hireCancelBtn) hireCancelBtn.onclick = closeCandidateHireModal;

  const hireForm = document.getElementById('candidateHireForm');
  if (hireForm) hireForm.addEventListener('submit', onCandidateHireSubmit);

  const hireModal = document.getElementById('candidateHireModal');
  if (hireModal) {
    hireModal.addEventListener('click', ev => {
      if (ev.target === hireModal) closeCandidateHireModal();
    });
  }

  const candidateCvModal = document.getElementById('candidateCvModal');
  if (candidateCvModal) {
    candidateCvModal.addEventListener('click', ev => {
      if (ev.target === candidateCvModal) closeCandidateCvModal();
    });
  }

  const candidateCvModalCloseBtn = document.getElementById('candidateCvModalCloseBtn');
  if (candidateCvModalCloseBtn) candidateCvModalCloseBtn.onclick = closeCandidateCvModal;

  const candidateCvModalDownloadBtn = document.getElementById('candidateCvModalDownloadBtn');
  if (candidateCvModalDownloadBtn) candidateCvModalDownloadBtn.addEventListener('click', onCandidateCvModalDownload);

  await loadRecruitmentPositions();
  renderCandidateSearchResults();
}

async function loadRecruitmentPositions() {
  if (!currentUser || !isManagerRole(currentUser)) return;
  const data = await getJSON('/recruitment/positions');
  recruitmentPositions = Array.isArray(data)
    ? data.map(pos => ({ ...pos, status: normalizePositionStatus(pos.status) }))
    : [];
  recruitmentPositions.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  if (recruitmentEditingPositionId) {
    const stillExists = recruitmentPositions.some(p => p.id == recruitmentEditingPositionId);
    if (!stillExists) {
      resetPositionForm();
    }
  }

  if (recruitmentPositions.length) {
    const exists = recruitmentPositions.some(p => p.id == recruitmentActivePositionId);
    recruitmentActivePositionId = exists ? recruitmentActivePositionId : recruitmentPositions[0].id;
  } else {
    recruitmentActivePositionId = null;
  }

  renderRecruitmentPositions();
  updateCandidatePositionSelect();

  if (recruitmentEditingPositionId) {
    const editingPosition = recruitmentPositions.find(p => p.id == recruitmentEditingPositionId);
    if (editingPosition) {
      fillPositionForm(editingPosition);
    } else {
      resetPositionForm();
    }
  }

  if (recruitmentActivePositionId) {
    await loadRecruitmentCandidates(recruitmentActivePositionId);
  } else {
    recruitmentCandidates = [];
    renderRecruitmentCandidates();
  }
}

function renderRecruitmentPositions() {
  const container = document.getElementById('positionsList');
  if (!container) return;
  if (!recruitmentPositions.length) {
    container.innerHTML = '<p class="text-muted" style="font-style: italic;">No positions yet. Add your first opening to start sourcing talent.</p>';
    updateCandidateFormAvailability();
    return;
  }
  const markup = recruitmentPositions.map(pos => {
    const isActive = pos.id == recruitmentActivePositionId;
    const status = normalizePositionStatus(pos.status);
    const statusClass = status === 'Closed' ? 'position-item__status--closed' : 'position-item__status--open';
    const statusBadge = `<span class="position-item__status ${statusClass}">${status}</span>`;
    const created = formatRecruitmentDate(pos.createdAt);
    const metaParts = [];
    if (pos.department) metaParts.push(escapeHtml(pos.department));
    if (created) metaParts.push(escapeHtml(created));
    const meta = metaParts.length ? `<div class="position-item__meta">${metaParts.join(' • ')}</div>` : '';
    return `
      <div class="position-item${isActive ? ' position-item--active' : ''}" data-position-id="${pos.id}">
        <button type="button" class="position-item__select" data-action="select-position" data-position-id="${pos.id}">
          <span class="material-symbols-rounded position-item__icon">work</span>
          <div class="position-item__content">
            <div class="position-item__title-row">
              <div class="position-item__title">${escapeHtml(pos.title)}</div>
              ${statusBadge}
            </div>
            ${meta}
          </div>
          <span class="material-symbols-rounded position-item__chevron">chevron_right</span>
        </button>
        <div class="position-item__actions">
          <button type="button" class="md-button md-button--text md-button--small" data-action="edit-position" data-position-id="${pos.id}">
            <span class="material-symbols-rounded">edit</span>
            Edit
          </button>
        </div>
      </div>
    `;
  }).join('');
  container.innerHTML = markup;
  updateCandidateFormAvailability();
}

function fillPositionForm(position) {
  const titleEl = document.getElementById('positionTitle');
  if (titleEl) titleEl.value = position?.title || '';
  const deptEl = document.getElementById('positionDepartment');
  if (deptEl) deptEl.value = position?.department || '';
  const statusEl = document.getElementById('positionStatus');
  if (statusEl) statusEl.value = normalizePositionStatus(position?.status);
  const descEl = document.getElementById('positionDescription');
  if (descEl) descEl.value = position?.description || '';
  setRecruitmentPositionQuestions(position?.aiInterviewQuestions || []);
}

function startPositionEdit(position) {
  if (!position) return;
  recruitmentEditingPositionId = position.id;
  const form = document.getElementById('positionForm');
  if (form) form.dataset.editId = position.id;
  fillPositionForm(position);
  const submitLabel = document.querySelector('#positionSubmitBtn .position-submit-label');
  if (submitLabel) submitLabel.textContent = 'Update Position';
  const icon = document.getElementById('positionSubmitIcon');
  if (icon) icon.textContent = 'edit';
  const cancelBtn = document.getElementById('positionCancelEditBtn');
  if (cancelBtn) cancelBtn.classList.remove('hidden');
  const titleEl = document.getElementById('positionTitle');
  if (titleEl) {
    titleEl.focus();
    titleEl.setSelectionRange(titleEl.value.length, titleEl.value.length);
  }
}

function resetPositionForm() {
  const wasEditing = Boolean(recruitmentEditingPositionId);
  recruitmentEditingPositionId = null;
  const form = document.getElementById('positionForm');
  if (form && wasEditing) {
    form.reset();
  }
  if (form) delete form.dataset.editId;
  const submitLabel = document.querySelector('#positionSubmitBtn .position-submit-label');
  if (submitLabel) submitLabel.textContent = 'Save Position';
  const icon = document.getElementById('positionSubmitIcon');
  if (icon) icon.textContent = 'save';
  const cancelBtn = document.getElementById('positionCancelEditBtn');
  if (cancelBtn) cancelBtn.classList.add('hidden');
  const statusEl = document.getElementById('positionStatus');
  if (statusEl) statusEl.value = 'Open';
  setRecruitmentPositionQuestions([]);
}

function onPositionEditCancel() {
  resetPositionForm();
}

function updateCandidatePositionSelect() {
  const select = document.getElementById('candidatePositionSelect');
  if (!select) return;
  if (!recruitmentPositions.length) {
    select.innerHTML = '<option value="">No positions available</option>';
    select.value = '';
    return;
  }
  const options = recruitmentPositions.map(pos => {
    const status = normalizePositionStatus(pos.status);
    const statusSuffix = status === 'Closed' ? ' (Closed)' : '';
    const label = pos.department ? `${escapeHtml(pos.title)} • ${escapeHtml(pos.department)}` : escapeHtml(pos.title);
    return `<option value="${pos.id}">${label}${statusSuffix}</option>`;
  }).join('');
  select.innerHTML = options;
  if (recruitmentActivePositionId) {
    select.value = recruitmentActivePositionId;
  } else {
    select.selectedIndex = 0;
    recruitmentActivePositionId = Number(select.value);
  }
}

function updateCandidateFormAvailability() {
  const form = document.getElementById('candidateForm');
  if (!form) return;
  const hasPositions = recruitmentPositions.length > 0;
  form.querySelectorAll('input, select, button').forEach(el => {
    el.disabled = !hasPositions;
  });
}

function onPositionsListClick(ev) {
  const editBtn = ev.target.closest('[data-action="edit-position"]');
  if (editBtn) {
    const id = Number(editBtn.getAttribute('data-position-id'));
    if (Number.isNaN(id)) return;
    const position = recruitmentPositions.find(p => p.id == id);
    if (!position) return;
    startPositionEdit(position);
    return;
  }
  const selectTarget = ev.target.closest('[data-action="select-position"]');
  const container = ev.target.closest('.position-item');
  const idSource = selectTarget || container;
  if (!idSource) return;
  const id = Number(idSource.getAttribute('data-position-id'));
  if (Number.isNaN(id)) return;
  recruitmentActivePositionId = id;
  updateCandidatePositionSelect();
  renderRecruitmentPositions();
  loadRecruitmentCandidates(recruitmentActivePositionId);
}

function onCandidatePositionChange(ev) {
  const id = Number(ev.target.value);
  recruitmentActivePositionId = Number.isNaN(id) ? null : id;
  renderRecruitmentPositions();
  if (recruitmentActivePositionId) {
    loadRecruitmentCandidates(recruitmentActivePositionId);
  } else {
    recruitmentCandidates = [];
    renderRecruitmentCandidates();
  }
}

async function onPositionSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const formData = new FormData(form);
  const aiInterviewQuestions = recruitmentPositionQuestions
    .filter(q => q.text && q.text.trim().length > 0)
    .map((q, index) => ({
      id: q.id || `q${index + 1}`,
      text: q.text.trim()
    }));
  const payload = {
    title: (formData.get('title') || '').toString().trim(),
    department: (formData.get('department') || '').toString().trim(),
    description: (formData.get('description') || '').toString().trim(),
    status: normalizePositionStatus(formData.get('status')),
    aiInterviewQuestions
  };
  if (!payload.title) {
    alert('Position title is required');
    return;
  }
  try {
    const editingId = recruitmentEditingPositionId;
    const endpoint = editingId ? `/recruitment/positions/${editingId}` : '/recruitment/positions';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await apiFetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed');
    if (editingId) {
      recruitmentActivePositionId = editingId;
      resetPositionForm();
    } else {
      form.reset();
      setRecruitmentPositionQuestions([]);
    }
    await loadRecruitmentPositions();
  } catch (err) {
    alert('Failed to save position. Please try again.');
  }
}

async function onCandidateSubmit(ev) {
  ev.preventDefault();
  if (!recruitmentPositions.length) {
    alert('Create a position before adding candidates.');
    return;
  }
  const form = ev.target;
  const formData = new FormData(form);
  const positionId = Number(formData.get('positionId'));
  const name = (formData.get('name') || '').toString().trim();
  const contact = (formData.get('contact') || '').toString().trim();
  const file = formData.get('cv');
  if (!positionId || Number.isNaN(positionId)) {
    alert('Please choose a position.');
    return;
  }
  if (!name) {
    alert('Candidate name is required.');
    return;
  }
  if (!contact) {
    alert('Contact details are required.');
    return;
  }
  const editingId = recruitmentEditingCandidateId;
  const selectedPosition = recruitmentPositions.find(pos => pos.id == positionId);
  const positionStatus = normalizePositionStatus(selectedPosition?.status);
  if (!editingId && positionStatus === 'Closed') {
    alert('This position is closed. Reopen it before adding new candidates.');
    return;
  }
  const hasNewCv = file && file.size;
  if (!editingId && !hasNewCv) {
    alert('Please upload a CV.');
    return;
  }
  try {
    const payload = {
      positionId,
      name,
      contact
    };
    if (hasNewCv) {
      const base64 = await fileToBase64(file);
      payload.cv = {
        filename: file.name,
        contentType: file.type,
        data: base64
      };
    }
    const endpoint = editingId ? `/recruitment/candidates/${editingId}` : '/recruitment/candidates';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await apiFetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed');
    recruitmentActivePositionId = positionId;
    if (editingId) {
      resetCandidateForm();
    } else {
      form.reset();
      updateCandidatePositionSelect();
    }
    renderRecruitmentPositions();
    await loadRecruitmentCandidates(positionId);
  } catch (err) {
    alert('Failed to add candidate. Please try again.');
  }
}

async function loadRecruitmentCandidates(positionId) {
  if (!positionId) {
    recruitmentCandidates = [];
    renderRecruitmentCandidates();
    return;
  }
  const data = await getJSON(`/recruitment/candidates?positionId=${encodeURIComponent(positionId)}`);
  recruitmentCandidates = Array.isArray(data) ? data : [];
  recruitmentCandidates.forEach(cacheCandidateDetails);
  if (recruitmentEditingCandidateId) {
    const editingCandidate = recruitmentCandidates.find(c => c.id == recruitmentEditingCandidateId);
    if (editingCandidate) {
      fillCandidateForm(editingCandidate);
    } else {
      resetCandidateForm();
    }
  }
  renderRecruitmentCandidates();
}

function renderRecruitmentCandidates() {
  const body = document.getElementById('candidateTableBody');
  if (!body) return;
  if (!recruitmentActivePositionId) {
    body.innerHTML = '<tr><td colspan="4" class="text-muted" style="padding:16px; font-style: italic;">Select a position to view candidates.</td></tr>';
    closeCandidateDetailsModal();
    return;
  }
  if (!recruitmentCandidates.length) {
    body.innerHTML = '<tr><td colspan="4" class="text-muted" style="padding:16px; font-style: italic;">No candidates yet for this position.</td></tr>';
    closeCandidateDetailsModal();
    return;
  }
  const rows = recruitmentCandidates.map(candidate => {
    const statusOptions = PIPELINE_STATUSES.map(status => `<option value="${status}" ${status === candidate.status ? 'selected' : ''}>${status}</option>`).join('');
    const contact = candidate.contact ? escapeHtml(candidate.contact) : '<span class="text-muted">Not provided</span>';
    const sourceLabel = candidate.source
      ? `<div class="text-muted" style="font-size:12px;">Source: ${escapeHtml(formatCandidateSource(candidate.source))}</div>`
      : '';
    const aiInterviewButton = candidate.applicationId && candidate.positionId
      ? `
            <button type="button" class="md-button md-button--text md-button--small" data-action="send-ai-interview" data-application-id="${candidate.applicationId}" data-candidate-id="${candidate.id}">
              <span class="material-symbols-rounded">smart_toy</span>
              Send AI Interview
            </button>`
      : '';
    return `
      <tr>
        <td>
          <div class="candidate-name-cell">
            <div class="candidate-name">${escapeHtml(candidate.name)}</div>
            ${sourceLabel}
            <button type="button" class="md-button md-button--text candidate-details" data-candidate-id="${candidate.id}">
              <span class="material-symbols-rounded">info</span>
              View details
            </button>
          </div>
        </td>
        <td>${contact}</td>
        <td>
          <select class="md-select candidate-status" data-candidate-id="${candidate.id}">
            ${statusOptions}
          </select>
        </td>
        <td>
          <div class="candidate-actions">
            ${aiInterviewButton}
            <button type="button" class="md-button md-button--text md-button--small" data-action="edit-candidate" data-candidate-id="${candidate.id}">
              <span class="material-symbols-rounded">edit</span>
              Edit
            </button>
            <button type="button" class="md-button md-button--text md-button--small" data-action="delete-candidate" data-candidate-id="${candidate.id}">
              <span class="material-symbols-rounded">delete</span>
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  body.innerHTML = rows;
  body.querySelectorAll('.candidate-status').forEach(select => {
    const candidateId = select.getAttribute('data-candidate-id');
    const candidate = recruitmentCandidates.find(c => c.id == candidateId);
    if (candidate) {
      select.dataset.currentStatus = candidate.status;
    }
  });
  refreshCandidateDetailsModal();
}

function fillCandidateForm(candidate) {
  const positionSelect = document.getElementById('candidatePositionSelect');
  if (positionSelect) {
    const value = candidate && candidate.positionId != null ? String(candidate.positionId) : '';
    positionSelect.value = value;
  }
  const nameEl = document.getElementById('candidateName');
  if (nameEl) nameEl.value = candidate?.name || '';
  const contactEl = document.getElementById('candidateContact');
  if (contactEl) contactEl.value = candidate?.contact || '';
  const cvInput = document.getElementById('candidateCv');
  if (cvInput) cvInput.value = '';
}

function startCandidateEdit(candidate) {
  if (!candidate) return;
  recruitmentEditingCandidateId = candidate.id;
  const form = document.getElementById('candidateForm');
  if (form) form.dataset.editId = candidate.id;
  fillCandidateForm(candidate);
  const submitLabel = document.querySelector('#candidateSubmitBtn .candidate-submit-label');
  if (submitLabel) submitLabel.textContent = 'Update Candidate';
  const icon = document.getElementById('candidateSubmitIcon');
  if (icon) icon.textContent = 'save';
  const cancelBtn = document.getElementById('candidateCancelEditBtn');
  if (cancelBtn) cancelBtn.classList.remove('hidden');
  const cvInput = document.getElementById('candidateCv');
  if (cvInput) {
    cvInput.removeAttribute('required');
    cvInput.value = '';
  }
  const helpText = document.getElementById('candidateCvHelpText');
  if (helpText) helpText.textContent = CANDIDATE_CV_HELP_EDIT;
  const nameEl = document.getElementById('candidateName');
  if (nameEl) {
    nameEl.focus();
    nameEl.setSelectionRange(nameEl.value.length, nameEl.value.length);
  }
}

function resetCandidateForm() {
  const wasEditing = Boolean(recruitmentEditingCandidateId);
  recruitmentEditingCandidateId = null;
  const form = document.getElementById('candidateForm');
  if (form && wasEditing) {
    form.reset();
  }
  if (form) delete form.dataset.editId;
  const submitLabel = document.querySelector('#candidateSubmitBtn .candidate-submit-label');
  if (submitLabel) submitLabel.textContent = 'Add to Pipeline';
  const icon = document.getElementById('candidateSubmitIcon');
  if (icon) icon.textContent = 'upload_file';
  const cancelBtn = document.getElementById('candidateCancelEditBtn');
  if (cancelBtn) cancelBtn.classList.add('hidden');
  const cvInput = document.getElementById('candidateCv');
  if (cvInput) {
    cvInput.value = '';
    cvInput.setAttribute('required', '');
  }
  const helpText = document.getElementById('candidateCvHelpText');
  if (helpText) helpText.textContent = CANDIDATE_CV_HELP_DEFAULT;
  updateCandidatePositionSelect();
}

function onCandidateEditCancel() {
  resetCandidateForm();
}

async function handleCandidateDelete(id) {
  if (!id) return;
  const candidate = recruitmentCandidates.find(c => c.id == id);
  if (!candidate) return;
  const confirmed = window.confirm('Remove this candidate from the pipeline?');
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/recruitment/candidates/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed');
  } catch (err) {
    alert('Failed to delete candidate. Please try again.');
    return;
  }
  if (recruitmentActiveDetailsCandidateId == id) {
    closeCandidateDetailsModal();
  }
  if (recruitmentEditingCandidateId == id) {
    resetCandidateForm();
  }
  await loadRecruitmentCandidates(recruitmentActivePositionId);
}

function onCandidateSearchInput(ev) {
  const value = ev.target.value.trim();
  recruitmentCandidateSearchQuery = value;
  if (recruitmentCandidateSearchTimer) {
    clearTimeout(recruitmentCandidateSearchTimer);
    recruitmentCandidateSearchTimer = null;
  }
  if (recruitmentCandidateSearchAbort) {
    recruitmentCandidateSearchAbort.abort();
    recruitmentCandidateSearchAbort = null;
  }
  if (!value) {
    recruitmentCandidateSearchResults = [];
    recruitmentCandidateSearchLoading = false;
    recruitmentCandidateSearchError = null;
    renderCandidateSearchResults();
    return;
  }
  recruitmentCandidateSearchLoading = true;
  recruitmentCandidateSearchError = null;
  renderCandidateSearchResults();
  recruitmentCandidateSearchTimer = setTimeout(() => {
    performCandidateSearch(value);
  }, 300);
}

async function performCandidateSearch(query) {
  if (!query) return;
  recruitmentCandidateSearchTimer = null;
  if (recruitmentCandidateSearchAbort) {
    recruitmentCandidateSearchAbort.abort();
  }
  const controller = new AbortController();
  recruitmentCandidateSearchAbort = controller;
  let data;
  try {
    const res = await apiFetch(`/recruitment/candidates/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
    if (!res.ok) throw new Error('Failed');
    data = await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (recruitmentCandidateSearchQuery !== query) return;
    recruitmentCandidateSearchError = 'Unable to search candidates right now.';
    recruitmentCandidateSearchResults = [];
    recruitmentCandidateSearchLoading = false;
    recruitmentCandidateSearchAbort = null;
    renderCandidateSearchResults();
    return;
  }
  recruitmentCandidateSearchAbort = null;
  if (recruitmentCandidateSearchQuery !== query) {
    return;
  }
  recruitmentCandidateSearchResults = Array.isArray(data) ? data : [];
  recruitmentCandidateSearchLoading = false;
  recruitmentCandidateSearchError = null;
  renderCandidateSearchResults();
}

function renderCandidateSearchResults() {
  const container = document.getElementById('candidateSearchResults');
  if (!container) return;
  if (!recruitmentCandidateSearchQuery) {
    container.classList.add('text-muted');
    container.innerHTML = 'Start typing to look up existing applicants.';
    return;
  }
  container.classList.remove('text-muted');
  if (recruitmentCandidateSearchLoading) {
    container.innerHTML = `
      <div class="candidate-search-loading">
        <span class="material-symbols-rounded">progress_activity</span>
        Searching...
      </div>
    `;
    return;
  }
  if (recruitmentCandidateSearchError) {
    container.innerHTML = `<div class="candidate-search-empty" style="color:#b3261e;">${escapeHtml(recruitmentCandidateSearchError)}</div>`;
    return;
  }
  if (!recruitmentCandidateSearchResults.length) {
    container.innerHTML = '<div class="candidate-search-empty text-muted">No matching candidates found.</div>';
    return;
  }
  const items = recruitmentCandidateSearchResults.map(result => {
    const name = escapeHtml(result?.name || 'Unknown candidate');
    const status = result?.status
      ? `<div class="candidate-search-item__status">${escapeHtml(result.status)}</div>`
      : '<div class="candidate-search-item__status candidate-search-item__status--muted">No status</div>';
    const detailItems = [];
    if (result?.contact) {
      detailItems.push({
        label: 'Contact',
        value: escapeHtml(result.contact)
      });
    }
    if (result?.positionTitle) {
      detailItems.push({
        label: 'Position',
        value: escapeHtml(result.positionTitle)
      });
    }
    const applied = formatRecruitmentDate(result?.createdAt);
    if (applied) {
      detailItems.push({
        label: 'Applied',
        value: escapeHtml(applied)
      });
    }
    const details = detailItems.length
      ? `
        <div class="candidate-search-item__details">
          ${detailItems
            .map(
              item => `
                <div class="candidate-search-item__detail">
                  <div class="candidate-search-item__detail-label">${item.label}</div>
                  <div class="candidate-search-item__detail-value">${item.value}</div>
                </div>
              `
            )
            .join('')}
        </div>
      `
      : '';
    const hasCv = !!result?.hasCv;
    const actions = hasCv
      ? `<button type="button" class="md-button md-button--text md-button--small candidate-search-item__view-btn" data-action="view-candidate-cv" data-candidate-id="${escapeHtml(String(result.id))}"><span class="material-symbols-rounded">picture_as_pdf</span>View CV</button>`
      : '<div class="candidate-search-item__no-cv">No CV uploaded</div>';
    return `
      <div class="candidate-search-item">
        <div class="candidate-search-item__content">
          <div class="candidate-search-item__name">${name}</div>
          ${details}
        </div>
        <div class="candidate-search-item__actions">
          ${status}
          ${actions}
        </div>
      </div>
    `;
  }).join('');
  container.innerHTML = items;
}

function resetCandidateCvModal(message = 'Select a candidate to preview their CV.') {
  const iframe = document.getElementById('candidateCvModalIframe');
  const messageEl = document.getElementById('candidateCvModalMessage');
  if (iframe) {
    iframe.classList.add('hidden');
    iframe.removeAttribute('src');
  }
  if (messageEl) {
    messageEl.textContent = message;
    messageEl.classList.remove('hidden');
  }
}

function setCandidateCvModalUrl(url) {
  const iframe = document.getElementById('candidateCvModalIframe');
  const messageEl = document.getElementById('candidateCvModalMessage');
  if (!iframe || !messageEl) return;
  iframe.src = url;
  iframe.classList.remove('hidden');
  messageEl.classList.add('hidden');
}

async function loadCandidateSearchCvPreview(candidateId) {
  const iframe = document.getElementById('candidateCvModalIframe');
  const messageEl = document.getElementById('candidateCvModalMessage');
  if (!iframe || !messageEl) return;
  const normalizedId = normalizeCandidateId(candidateId);
  if (normalizedId == null) {
    resetCandidateCvModal('Unable to load this CV.');
    return;
  }
  messageEl.textContent = 'Loading CV preview...';
  messageEl.classList.remove('hidden');
  iframe.classList.add('hidden');
  try {
    const res = await apiFetch(
      `/api/recruitment/candidates/${encodeURIComponent(normalizedId)}/cv`
    );
    if (!res.ok) throw new Error('Failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (candidateCvModalCandidateId !== normalizedId) {
      URL.revokeObjectURL(url);
      return;
    }
    candidateCvPreviewUrls.set(normalizedId, url);
    setCandidateCvModalUrl(url);
  } catch (err) {
    if (candidateCvModalCandidateId !== normalizedId) return;
    resetCandidateCvModal('Unable to load CV preview right now. Use the download button to access the CV.');
  }
}

function openCandidateCvModal(candidateId) {
  const modal = document.getElementById('candidateCvModal');
  if (!modal) return;
  const candidate = recruitmentCandidateSearchResults.find(c => String(c.id) === String(candidateId));
  if (!candidate) return;
  const normalizedId = normalizeCandidateId(candidate.id);
  candidateCvModalCandidateId = normalizedId;
  modal.classList.remove('hidden');
  const titleText = document.getElementById('candidateCvModalTitleText');
  if (titleText) {
    titleText.textContent = candidate?.name ? `CV Preview · ${candidate.name}` : 'CV Preview';
  }
  const downloadBtn = document.getElementById('candidateCvModalDownloadBtn');
  if (downloadBtn) {
    const hasCv = !!candidate?.hasCv;
    downloadBtn.classList.toggle('hidden', !hasCv);
    downloadBtn.dataset.candidateId = hasCv ? String(candidate.id) : '';
    downloadBtn.disabled = !hasCv;
  }
  if (!candidate?.hasCv) {
    resetCandidateCvModal('No CV uploaded for this candidate.');
    return;
  }
  const contentType = String(candidate.cvContentType || '').toLowerCase();
  if (!contentType.includes('pdf')) {
    resetCandidateCvModal('CV preview is available only for PDF files. Use the download button to open this document.');
    return;
  }
  const cachedUrl = candidateCvPreviewUrls.get(normalizedId);
  if (cachedUrl) {
    setCandidateCvModalUrl(cachedUrl);
    return;
  }
  resetCandidateCvModal('Loading CV preview...');
  loadCandidateSearchCvPreview(normalizedId);
}

function closeCandidateCvModal() {
  const modal = document.getElementById('candidateCvModal');
  if (!modal) return;
  modal.classList.add('hidden');
  candidateCvModalCandidateId = null;
  const titleText = document.getElementById('candidateCvModalTitleText');
  if (titleText) {
    titleText.textContent = 'CV Preview';
  }
  const downloadBtn = document.getElementById('candidateCvModalDownloadBtn');
  if (downloadBtn) {
    downloadBtn.classList.add('hidden');
    downloadBtn.dataset.candidateId = '';
    downloadBtn.disabled = false;
  }
  resetCandidateCvModal('Select a candidate to preview their CV.');
}

async function onCandidateCvModalDownload(ev) {
  const button = ev.currentTarget;
  if (!button || button.disabled) return;
  const id = button.dataset.candidateId;
  if (!id) return;
  button.disabled = true;
  try {
    await downloadCandidateCv(id);
  } catch (err) {
    alert('Unable to download CV at the moment.');
  } finally {
    button.disabled = false;
  }
}

function onCandidateSearchResultsClick(ev) {
  const button = ev.target.closest('[data-action="view-candidate-cv"]');
  if (!button) return;
  const id = button.getAttribute('data-candidate-id');
  if (!id) return;
  const result = recruitmentCandidateSearchResults.find(candidate => String(candidate.id) === String(id));
  const adapted = adaptSearchResultToCandidate(result);
  if (adapted) cacheCandidateDetails(adapted);
  openCandidateDetailsModal(id);
}

async function onCandidateStatusChange(ev) {
  const select = ev.target.closest('.candidate-status');
  if (!select) return;
  const id = select.getAttribute('data-candidate-id');
  const status = select.value;
  if (!id || !status) return;
  const candidate = recruitmentCandidates.find(c => c.id == id);
  const fallbackStatus = candidate?.status || PIPELINE_STATUSES[0];
  const previousStatus = select.dataset.currentStatus || fallbackStatus;
  if (status === previousStatus) return;
  if (status === 'Hired') {
    if (!candidate) {
      select.value = previousStatus;
      return;
    }
    select.value = previousStatus;
    openCandidateHireModal(candidate, select, previousStatus);
    return;
  }
  try {
    const res = await apiFetch(`/recruitment/candidates/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Failed');
    select.dataset.currentStatus = status;
    await loadRecruitmentCandidates(recruitmentActivePositionId);
  } catch (err) {
    alert('Failed to update candidate status.');
    select.value = previousStatus;
    await loadRecruitmentCandidates(recruitmentActivePositionId);
  }
}

async function onCandidateTableClick(ev) {
  const aiInterviewBtn = ev.target.closest('[data-action="send-ai-interview"]');
  if (aiInterviewBtn) {
    const applicationId = aiInterviewBtn.getAttribute('data-application-id');
    const candidateId = aiInterviewBtn.getAttribute('data-candidate-id');
    if (applicationId) {
      await createAiInterviewSession(applicationId, aiInterviewBtn, candidateId);
    }
    return;
  }
  const deleteBtn = ev.target.closest('[data-action="delete-candidate"]');
  if (deleteBtn) {
    const id = Number(deleteBtn.getAttribute('data-candidate-id'));
    if (!Number.isNaN(id)) {
      await handleCandidateDelete(id);
    }
    return;
  }
  const editBtn = ev.target.closest('[data-action="edit-candidate"]');
  if (editBtn) {
    const id = Number(editBtn.getAttribute('data-candidate-id'));
    if (!Number.isNaN(id)) {
      const candidate = recruitmentCandidates.find(c => c.id == id);
      if (candidate) {
        startCandidateEdit(candidate);
      }
    }
    return;
  }
  const detailsButton = ev.target.closest('.candidate-details');
  if (!detailsButton) return;
  const id = Number(detailsButton.getAttribute('data-candidate-id'));
  if (!id) return;
  openCandidateDetailsModal(id);
}

async function createAiInterviewSession(applicationId, triggerButton, candidateId) {
  if (!applicationId) return;
  const button = triggerButton || null;
  if (button) button.disabled = true;
  try {
    const res = await apiFetch('/api/hr/ai-interview/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = data?.error || 'Failed to create AI interview session.';
      throw new Error(message);
    }
    const path = data?.interviewPath || '';
    const candidateEmail = data?.candidateEmail || '';
    const details = [];
    if (path) details.push(`Link: ${path}`);
    if (candidateEmail) details.push(`Candidate Email: ${candidateEmail}`);
    const info = details.length ? `\n${details.join('\n')}` : '';
    alert(`AI Interview session created.${info}`);
    aiInterviewCache.delete(applicationId);
    if (candidateId && recruitmentActiveDetailsCandidateId == candidateId) {
      const candidate = getCachedCandidate(candidateId);
      if (candidate) {
        loadCandidateAiInterview(candidate, { force: true });
      }
    }
  } catch (err) {
    alert(err?.message || 'Failed to create AI interview session.');
  } finally {
    if (button) button.disabled = false;
  }
}

async function updateCandidateStatusAndRefresh(candidateId, status) {
  if (!candidateId || !status) return;
  try {
    const res = await apiFetch(`/recruitment/candidates/${candidateId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Failed');
    const updated = await res.json();
    cacheCandidateDetails(updated);
    await loadRecruitmentCandidates(recruitmentActivePositionId);
  } catch (err) {
    alert('Failed to update candidate status.');
  }
}

async function onCandidateAiPanelClick(ev) {
  const sendBtn = ev.target.closest('[data-action="ai-send-interview"]');
  if (sendBtn) {
    const applicationId = sendBtn.getAttribute('data-application-id');
    const candidateId = sendBtn.getAttribute('data-candidate-id');
    if (applicationId) {
      await createAiInterviewSession(applicationId, sendBtn, candidateId);
    }
    return;
  }

  const moveBtn = ev.target.closest('[data-action="ai-move-human"]');
  if (moveBtn) {
    const candidateId = moveBtn.getAttribute('data-candidate-id');
    await updateCandidateStatusAndRefresh(candidateId, 'Selected for Interview');
    return;
  }

  const rejectBtn = ev.target.closest('[data-action="ai-reject"]');
  if (rejectBtn) {
    const candidateId = rejectBtn.getAttribute('data-candidate-id');
    await updateCandidateStatusAndRefresh(candidateId, 'Rejected');
  }
}

async function downloadCandidateCv(id) {
  const normalizedId = normalizeCandidateId(id);
  if (normalizedId == null) throw new Error('Invalid candidate id');
  const res = await apiFetch(`/api/recruitment/candidates/${encodeURIComponent(normalizedId)}/cv`);
  if (!res.ok) throw new Error('Failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const candidate = recruitmentCandidates.find(c => c.id == id) ||
    recruitmentCandidateSearchResults.find(c => String(c.id) === String(id)) ||
    (normalizedId != null ? candidateDetailsCache.get(normalizedId) : null);
  const filename = candidate?.cv?.filename || candidate?.cvFilename || `candidate-${id}`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function resetCandidateCvPreview(message = 'Select a candidate to view their CV.') {
  const messageEl = document.getElementById('candidateCvPreviewMessage');
  const iframe = document.getElementById('candidateCvIframe');
  if (iframe) {
    iframe.classList.add('hidden');
    iframe.removeAttribute('src');
  }
  if (messageEl) {
    messageEl.textContent = message;
    messageEl.classList.remove('hidden');
  }
}

function setCandidateCvPreviewUrl(url) {
  const messageEl = document.getElementById('candidateCvPreviewMessage');
  const iframe = document.getElementById('candidateCvIframe');
  if (!iframe || !messageEl) return;
  iframe.src = url;
  iframe.classList.remove('hidden');
  messageEl.classList.add('hidden');
}

async function loadCandidateCvPreview(candidate) {
  if (!candidate) {
    resetCandidateCvPreview();
    return;
  }
  if (!candidate?.cv?.filename) {
    resetCandidateCvPreview('No CV uploaded for this candidate.');
    return;
  }
  const contentType = String(candidate.cv.contentType || '').toLowerCase();
  if (!contentType.includes('pdf')) {
    resetCandidateCvPreview('CV preview is available only for PDF files. Use the download button to open this document.');
    return;
  }
  const messageEl = document.getElementById('candidateCvPreviewMessage');
  const iframe = document.getElementById('candidateCvIframe');
  if (!messageEl || !iframe) return;
  const candidateId = normalizeCandidateId(candidate.id);
  if (candidateId == null) {
    resetCandidateCvPreview('Unable to load this CV.');
    return;
  }
  const cachedUrl = candidateCvPreviewUrls.get(candidateId);
  if (cachedUrl) {
    setCandidateCvPreviewUrl(cachedUrl);
    return;
  }
  messageEl.textContent = 'Loading CV preview...';
  messageEl.classList.remove('hidden');
  iframe.classList.add('hidden');
  try {
    const res = await apiFetch(
      `/api/recruitment/candidates/${encodeURIComponent(candidateId)}/cv`
    );
    if (!res.ok) throw new Error('Failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    candidateCvPreviewUrls.set(candidateId, url);
    if (recruitmentActiveDetailsCandidateId !== candidate.id) return;
    setCandidateCvPreviewUrl(url);
  } catch (err) {
    if (recruitmentActiveDetailsCandidateId !== candidate?.id) return;
    resetCandidateCvPreview('Unable to load CV preview right now. Use the download button to access the CV.');
  }
}

function updateAiScreeningTriggerBadge(application) {
  const badge = document.getElementById('aiScreeningTriggerBadge');
  if (!badge) return;

  if (!application || !application.aiScreeningResult) {
    badge.classList.add('hidden');
    return;
  }

  const manuallyTriggered = Boolean(application.aiScreeningManualTriggered);
  badge.textContent = manuallyTriggered ? '(Manually triggered)' : '(Auto screening)';
  badge.classList.toggle('hidden', false);
  badge.classList.remove('text-green-600', 'text-yellow-600');
  badge.classList.add(manuallyTriggered ? 'text-yellow-600' : 'text-green-600');
}

function updateRunAiScreeningButton(application) {
  const runBtn = document.getElementById('runAiScreeningBtn');
  if (!runBtn) return;

  const hasApplication = Boolean(application && (application._id || application.id));
  const hasResult = Boolean(application && application.aiScreeningResult);

  runBtn.innerText = hasResult ? 'Re-run AI Screening' : 'Run AI Screening';
  runBtn.disabled = !hasApplication;
  runBtn.dataset.applicationId = hasApplication ? (application._id || application.id) : '';
  runBtn.classList.toggle('opacity-60', !hasApplication);
}

function renderAiCvScreening(application) {
  const panel = document.getElementById('ai-cv-screening');
  if (!panel) return;

  updateRunAiScreeningButton(application);
  updateAiScreeningTriggerBadge(application);

  if (!panel.querySelector('#aiFitLevel') && aiCvScreeningTemplate) {
    panel.innerHTML = aiCvScreeningTemplate;
  }

  if (!application || !application.aiScreeningResult) {
    const fitLevelEl = document.getElementById('aiFitLevel');
    const fitScoreEl = document.getElementById('aiFitScore');
    const summaryEl = document.getElementById('aiSummary');
    const strengthsUl = document.getElementById('aiStrengths');
    const concernsUl = document.getElementById('aiConcerns');
    const rec = document.getElementById('aiRecommendation');
    if (fitLevelEl) fitLevelEl.innerText = '-';
    if (fitScoreEl) fitScoreEl.innerText = '';
    if (summaryEl) summaryEl.innerText = 'No AI screening result available.';
    if (strengthsUl) strengthsUl.innerHTML = '';
    if (concernsUl) concernsUl.innerHTML = '';
    if (rec) {
      rec.innerText = '';
      rec.classList.remove('bg-green-600', 'bg-yellow-600', 'bg-red-600');
    }
    return;
  }

  const r = application.aiScreeningResult;

  const fitLevelEl = document.getElementById('aiFitLevel');
  const fitScoreEl = document.getElementById('aiFitScore');
  const summaryEl = document.getElementById('aiSummary');
  const strengthsUl = document.getElementById('aiStrengths');
  const concernsUl = document.getElementById('aiConcerns');
  const rec = document.getElementById('aiRecommendation');

  if (!fitLevelEl || !fitScoreEl || !summaryEl || !strengthsUl || !concernsUl || !rec) return;

  fitLevelEl.innerText = r.fitLevel;
  fitScoreEl.innerText = r.fitScore != null ? r.fitScore.toFixed(1) : '';

  summaryEl.innerText = r.summary || '';

  strengthsUl.innerHTML = '';
  (r.strengths || []).forEach(s => {
    const li = document.createElement('li');
    li.innerText = s;
    strengthsUl.appendChild(li);
  });

  concernsUl.innerHTML = '';
  (r.concerns || []).forEach(c => {
    const li = document.createElement('li');
    li.innerText = c;
    concernsUl.appendChild(li);
  });

  rec.innerText = r.recommendation;
  rec.classList.remove('bg-green-600', 'bg-yellow-600', 'bg-red-600');
  rec.classList.add(
    r.recommendation === 'proceed_to_ai_interview' ? 'bg-green-600' :
    r.recommendation === 'manual_review' ? 'bg-yellow-600' :
    'bg-red-600'
  );
}

async function onRunAiScreeningClick() {
  const runBtn = document.getElementById('runAiScreeningBtn');
  const candidate = recruitmentActiveDetailsCandidateId
    ? getCachedCandidate(recruitmentActiveDetailsCandidateId)
    : null;
  const application = candidate?.application;
  const applicationId = runBtn?.dataset?.applicationId;

  if (!runBtn || runBtn.disabled) return;
  if (!application || !applicationId) {
    alert('No application found for AI screening.');
    return;
  }

  runBtn.disabled = true;
  try {
    const res = await fetch(`/api/hr/applications/${applicationId}/ai-screening/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    const data = await res.json();

    if (!data.success) {
      alert('AI Screening failed: ' + (data.error || ''));
      return;
    }

    alert('AI Screening finished successfully!');
    application.aiScreeningResult = data.aiScreeningResult;
    application.aiScreeningManualTriggered = true;
    application.aiScreeningAt = new Date().toISOString();
    if (candidate) {
      cacheCandidateDetails({ ...candidate, application, applicationId });
    }
    renderAiCvScreening(application);
  } catch (err) {
    alert('Error running AI Screening.');
    console.error(err);
  } finally {
    runBtn.disabled = false;
  }
}

function setCommentFormEnabled(enabled) {
  const textarea = document.getElementById('commentText');
  const submitBtn = document.getElementById('commentSubmitBtn');
  [textarea, submitBtn].forEach(el => {
    if (el) el.disabled = !enabled;
  });
}

function updateCandidateCommentsCount(count, candidate) {
  const countEl = document.getElementById('candidateDetailsCommentsCount');
  if (!countEl) return;
  let value = Number.isFinite(count) ? Number(count) : 0;
  if (candidate && candidate.id === recruitmentActiveCommentCandidateId && Array.isArray(recruitmentCandidateComments)) {
    value = recruitmentCandidateComments.length;
  }
  countEl.textContent = value;
}

function prepareCandidateCommentsSection(candidate) {
  const list = document.getElementById('commentsList');
  if (list) {
    list.classList.add('text-muted');
    list.innerHTML = '<p style="font-style: italic;">Loading comments...</p>';
  }
  const metaEl = document.getElementById('candidateDetailsCommentsMeta');
  if (metaEl) {
    metaEl.textContent = candidate?.name
      ? `Collaborate on interview notes for ${candidate.name}.`
      : 'Share feedback with your hiring team.';
  }
  const textarea = document.getElementById('commentText');
  if (textarea) textarea.value = '';
  updateCandidateCommentsCount(candidate?.commentCount, candidate);
  updateCommentSubmitLabel();
}

async function loadCandidateComments(candidateId) {
  const list = document.getElementById('commentsList');
  recruitmentCandidateComments = [];
  recruitmentEditingCommentId = null;
  updateCommentSubmitLabel();
  if (list) {
    list.classList.add('text-muted');
    list.innerHTML = '<p style="font-style: italic;">Loading comments...</p>';
  }
  try {
    const res = await apiFetch(`/recruitment/candidates/${candidateId}/comments`);
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    recruitmentCandidateComments = Array.isArray(data) ? data : [];
  } catch (err) {
    if (recruitmentActiveCommentCandidateId !== candidateId) return;
    if (list) {
      list.innerHTML = '<p style="font-style: italic;">Unable to load comments right now.</p>';
    }
    updateCandidateCommentsCount(recruitmentCandidateComments.length);
    return;
  }
  if (recruitmentActiveCommentCandidateId !== candidateId) return;
  recruitmentCandidateComments.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const normalizedId = normalizeCandidateId(candidateId);
  const candidate = normalizedId != null
    ? recruitmentCandidates.find(c => c.id == normalizedId) || candidateDetailsCache.get(normalizedId)
    : null;
  if (candidate) {
    candidate.commentCount = recruitmentCandidateComments.length;
    cacheCandidateDetails(candidate);
  }
  renderCandidateComments();
  updateCandidateCommentsCount(recruitmentCandidateComments.length, candidate);
  refreshCandidateDetailsModal();
}

function openCandidateDetailsModal(candidateId) {
  const candidate = getCachedCandidate(candidateId);
  if (!candidate) {
    alert('Unable to load candidate details right now. Please try again.');
    return;
  }
  cacheCandidateDetails(candidate);
  recruitmentActiveDetailsCandidateId = candidate.id;
  recruitmentActiveCommentCandidateId = candidate.id;
  prepareCandidateCommentsSection(candidate);
  setCommentFormEnabled(true);
  populateCandidateDetails(candidate);
  loadCandidateComments(candidate.id);
  loadCandidateCvPreview(candidate);
  const modal = document.getElementById('candidateDetailsModal');
  if (modal) modal.classList.remove('hidden');
  const textarea = document.getElementById('commentText');
  if (textarea) textarea.focus();
}

function closeCandidateDetailsModal() {
  const modal = document.getElementById('candidateDetailsModal');
  if (modal) modal.classList.add('hidden');
  recruitmentActiveDetailsCandidateId = null;
  recruitmentActiveCommentCandidateId = null;
  recruitmentCandidateComments = [];
  recruitmentEditingCommentId = null;
  updateCommentSubmitLabel();
  setCommentFormEnabled(false);
  resetCandidateCvPreview();
  renderAiCvScreening(null);
  const list = document.getElementById('commentsList');
  if (list) {
    list.classList.add('text-muted');
    list.innerHTML = '<p style="font-style: italic;">Select a candidate to load comments.</p>';
  }
  const metaEl = document.getElementById('candidateDetailsCommentsMeta');
  if (metaEl) metaEl.textContent = 'Share feedback with your hiring team.';
  updateCandidateCommentsCount(0);
  const textarea = document.getElementById('commentText');
  if (textarea) textarea.value = '';
  ['Name', 'Contact', 'Status', 'Created'].forEach(field => {
    const el = document.getElementById(`candidateDetails${field}`);
    if (el) el.textContent = '-';
  });
  const cvEl = document.getElementById('candidateDetailsCvFilename');
  if (cvEl) cvEl.textContent = '-';
  const downloadBtn = document.getElementById('candidateDetailsDownloadBtn');
  if (downloadBtn) {
    delete downloadBtn.dataset.candidateId;
    downloadBtn.disabled = true;
  }
  activeAiInterviewApplicationId = null;
  renderCandidateAiInterviewPanel(null);
}

function populateCandidateDetails(candidate) {
  const nameEl = document.getElementById('candidateDetailsName');
  if (nameEl) nameEl.textContent = candidate?.name ? candidate.name : '-';

  const contactEl = document.getElementById('candidateDetailsContact');
  if (contactEl) contactEl.textContent = candidate?.contact ? candidate.contact : 'Not provided';

  const statusEl = document.getElementById('candidateDetailsStatus');
  if (statusEl) statusEl.textContent = candidate?.status || '-';

  const createdEl = document.getElementById('candidateDetailsCreated');
  if (createdEl) {
    const created = formatRecruitmentDateTime(candidate?.createdAt) || '-';
    const source = candidate?.source ? ` • Source: ${formatCandidateSource(candidate.source)}` : '';
    createdEl.textContent = `${created}${source}`;
  }

  const cvEl = document.getElementById('candidateDetailsCvFilename');
  const hasCv = !!candidate?.cv?.filename;
  if (cvEl) cvEl.textContent = hasCv ? candidate.cv.filename : 'No CV uploaded';

  const downloadBtn = document.getElementById('candidateDetailsDownloadBtn');
  if (downloadBtn) {
    downloadBtn.dataset.candidateId = candidate?.id;
    downloadBtn.disabled = !hasCv;
  }
  updateCandidateCommentsCount(candidate?.commentCount, candidate);
  renderAiCvScreening(candidate?.application);
  const cachedAiInterview = candidate?.applicationId ? aiInterviewCache.get(candidate.applicationId) : null;
  renderCandidateAiInterviewPanel(candidate, { data: cachedAiInterview });
  loadCandidateAiInterview(candidate);
}

function refreshCandidateDetailsModal() {
  if (!recruitmentActiveDetailsCandidateId) return;
  const candidate = getCachedCandidate(recruitmentActiveDetailsCandidateId);
  if (!candidate) {
    closeCandidateDetailsModal();
    return;
  }
  populateCandidateDetails(candidate);
}

function formatAiInterviewStatus(info) {
  if (!info || info.hasSession === false) {
    return { label: 'Not sent', description: 'Send the AI interview to notify the candidate.' };
  }

  const sessionStatus = info.session?.status;

  if (info.result) {
    return {
      label: 'Completed',
      description: 'Candidate completed the AI interview and analysis is ready.'
    };
  }

  if (sessionStatus === 'completed') {
    return {
      label: 'Completed',
      description: 'Candidate finished their interview. AI analysis will appear once ready.'
    };
  }

  return {
    label: 'AI Interview Sent',
    description: 'Waiting for the candidate to finish the interview.'
  };
}

function renderCandidateAiInterviewPanel(candidate, options = {}) {
  const panel = document.getElementById('candidateAiInterviewPanel');
  const contentEl = document.getElementById('candidateAiInterviewContent');
  const actionsEl = document.getElementById('candidateAiInterviewActions');
  if (!panel || !contentEl || !actionsEl) return;

  const { data = null, loading = false, error = null } = options;
  actionsEl.innerHTML = '';

  if (!candidate) {
    contentEl.textContent = 'Select a candidate to view AI interview details.';
    return;
  }

  if (!candidate.applicationId) {
    contentEl.textContent = 'This candidate is not linked to an application yet. AI interview is unavailable.';
    return;
  }

  if (loading) {
    contentEl.textContent = 'Loading AI interview details...';
    return;
  }

  if (error) {
    contentEl.innerHTML = `<p class="text-red-600 text-xs">${escapeHtml(error)}</p>`;
    return;
  }

  const actions = [];

  if (!data || data.hasSession === false) {
    contentEl.innerHTML = '<p class="text-xs text-gray-700">AI Interview not sent yet.</p>';
    actions.push(
      `<button type="button" class="md-button md-button--filled md-button--small" data-action="ai-send-interview" data-application-id="${
        candidate.applicationId
      }" data-candidate-id="${candidate.id}">
        <span class="material-symbols-rounded">smart_toy</span>
        Send AI Interview
      </button>`
    );
    actionsEl.innerHTML = actions.join('');
    return;
  }

  const status = formatAiInterviewStatus(data);
  const verdictLabel = data.result?.verdict ? `Verdict: ${escapeHtml(data.result.verdict)}` : '';
  const candidateEmail = candidate?.email || candidate?.contact || 'Not provided';
  const displayEmail = candidateEmail ? String(candidateEmail) : 'Not provided';

  let html = `
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="px-2 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700">${escapeHtml(
          status.label
        )}</span>
        ${verdictLabel
          ? `<span class="px-2 py-1 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-800">${verdictLabel}</span>`
          : ''}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-gray-700">
        <div>
          <div class="text-[11px] uppercase tracking-wide text-gray-500">Candidate Email</div>
          <div class="text-sm text-gray-900">${escapeHtml(displayEmail)}</div>
        </div>
        <div>
          <div class="text-[11px] uppercase tracking-wide text-gray-500">Invitation Status</div>
          <div class="text-sm text-gray-900">${escapeHtml(status.description)}</div>
        </div>
      </div>
    </div>`;

  if (!data.result) {
    const pendingMessage =
      data.session?.status === 'completed'
        ? 'Candidate finished the AI interview. Analysis is being generated and the recruiter will receive an email update.'
        : 'AI interview sent. Waiting for the candidate to complete the interview. The recruiter will be notified automatically.';
    html += `<p class="text-xs text-gray-700">${escapeHtml(pendingMessage)}</p>`;
  } else {
    const { result } = data;
    const scores = result.scores || {};
    const scoreItems = [];
    if (scores.overall != null) scoreItems.push({ label: 'Overall', value: `${scores.overall} / 5` });
    if (scores.communication != null) scoreItems.push({ label: 'Communication', value: scores.communication });
    if (scores.technical != null) scoreItems.push({ label: 'Technical', value: scores.technical });
    if (scores.cultureFit != null) scoreItems.push({ label: 'Culture Fit', value: scores.cultureFit });
    if (scoreItems.length) {
      const scoreList = scoreItems
        .map(
          item => `
            <li class="flex items-center justify-between gap-2 py-1">
              <span class="font-semibold text-gray-800">${escapeHtml(item.label)}</span>
              <span class="text-gray-700">${escapeHtml(String(item.value))}</span>
            </li>`
        )
        .join('');
      html += `
        <div class="border-t border-gray-100 pt-2">
          <h4 class="text-xs font-semibold text-gray-800 mb-1">Scores</h4>
          <ul class="text-xs text-gray-700">${scoreList}</ul>
        </div>`;
    }

    if (result.summary) {
      html += `
        <div class="mb-2">
          <h4 class="text-xs font-semibold text-gray-700 mb-1">AI Summary</h4>
          <p class="text-xs text-gray-700 whitespace-pre-line">${escapeHtml(result.summary)}</p>
        </div>`;
    }

    const strengths = Array.isArray(result.strengths) ? result.strengths : [];
    const risks = Array.isArray(result.risks) ? result.risks : [];
    if (strengths.length || risks.length) {
      const strengthsList = strengths.map(item => `<li>${escapeHtml(item)}</li>`).join('');
      const risksList = risks.map(item => `<li>${escapeHtml(item)}</li>`).join('');
      html += `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
          <div>
            <h4 class="text-xs font-semibold text-green-700 mb-1">Strengths</h4>
            <ul class="text-xs text-gray-700 list-disc list-inside">${strengthsList || '<li class="text-muted">None noted</li>'}</ul>
          </div>
          <div>
            <h4 class="text-xs font-semibold text-red-700 mb-1">Risks</h4>
            <ul class="text-xs text-gray-700 list-disc list-inside">${risksList || '<li class="text-muted">None noted</li>'}</ul>
          </div>
        </div>`;
    }

    const nextSteps = Array.isArray(result.recommendedNextSteps) ? result.recommendedNextSteps : [];
    if (nextSteps.length) {
      const stepsList = nextSteps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
      html += `
        <div class="mt-2">
          <h4 class="text-xs font-semibold text-gray-700 mb-1">Recommended Next Steps</h4>
          <ul class="text-xs text-gray-700 list-disc list-inside">${stepsList}</ul>
        </div>`;
    }

    html += `
      <div class="mt-3 bg-blue-50 border border-blue-100 rounded-md p-3 text-[11px] text-blue-800 flex gap-2">
        <span class="material-symbols-rounded text-base">groups</span>
        <div>
          Update the pipeline using <strong>Move to Human Interview</strong> or <strong>Reject Candidate</strong> to keep the team in sync.
        </div>
      </div>`;

    if (candidate?.id != null) {
      actions.push(
        `<button type="button" class="md-button md-button--outlined md-button--small" data-action="ai-move-human" data-candidate-id="${candidate.id}">
          <span class="material-symbols-rounded">groups</span>
          Move to Human Interview
        </button>`
      );
      actions.push(
        `<button type="button" class="md-button md-button--text md-button--small" data-action="ai-reject" data-candidate-id="${candidate.id}">
          <span class="material-symbols-rounded">block</span>
          Reject Candidate
        </button>`
      );
    }
  }

  contentEl.innerHTML = html;
  actionsEl.innerHTML = actions.join('');
}

async function fetchAiInterviewInfo(applicationId, { force = false } = {}) {
  if (!applicationId) return null;
  if (!force && aiInterviewCache.has(applicationId)) {
    return aiInterviewCache.get(applicationId);
  }
  const res = await apiFetch(`/api/hr/ai-interview/application/${applicationId}`);
  if (!res.ok) throw new Error('Unable to load AI interview details.');
  const data = await res.json();
  aiInterviewCache.set(applicationId, data);
  return data;
}

async function loadCandidateAiInterview(candidate, options = {}) {
  const applicationId = candidate?.applicationId;
  if (!applicationId) {
    activeAiInterviewApplicationId = null;
    if (candidate) {
      renderCandidateAiInterviewPanel(candidate, { data: null });
    }
    return;
  }

  activeAiInterviewApplicationId = applicationId;
  const cached = !options.force ? aiInterviewCache.get(applicationId) : null;
  if (cached && !options.force) {
    renderCandidateAiInterviewPanel(candidate, { data: cached });
    return;
  }
  renderCandidateAiInterviewPanel(candidate, { data: cached || null, loading: true });
  try {
    const data = await fetchAiInterviewInfo(applicationId, { force: options.force });
    if (activeAiInterviewApplicationId !== applicationId) return;
    renderCandidateAiInterviewPanel(candidate, { data });
  } catch (err) {
    if (activeAiInterviewApplicationId !== applicationId) return;
    renderCandidateAiInterviewPanel(candidate, { data: cached || null, error: err?.message || 'Unable to load AI interview.' });
  }
}

function deriveHireInitialValues(candidate, fields = []) {
  const initial = {};
  const position = recruitmentPositions.find(pos => pos.id == candidate.positionId);
  fields.forEach(field => {
    const keyLower = String(field.key || '').toLowerCase();
    if (keyLower === 'name' && candidate?.name) {
      initial[field.key] = candidate.name;
      return;
    }
    if (position && keyLower === 'title' && position.title) {
      initial[field.key] = position.title;
      return;
    }
    if (position && position.department && keyLower.includes('department')) {
      initial[field.key] = position.department;
      return;
    }
    if (candidate?.contact) {
      const contact = candidate.contact;
      const lowerContact = contact.toLowerCase();
      if (lowerContact.includes('@') && keyLower.includes('email')) {
        initial[field.key] = contact;
        return;
      }
      if (!lowerContact.includes('@') && (keyLower.includes('phone') || keyLower.includes('mobile'))) {
        initial[field.key] = contact;
        return;
      }
      if (keyLower.includes('contact')) {
        initial[field.key] = contact;
        return;
      }
    }
    if (field.type === 'select' && Array.isArray(field.options)) {
      const activeOption = field.options.find(opt => String(opt).toLowerCase() === 'active');
      if (activeOption && typeof initial[field.key] === 'undefined') {
        initial[field.key] = activeOption;
        return;
      }
    }
    if (field.isLeaveBalance && typeof initial[field.key] === 'undefined') {
      initial[field.key] = 0;
    }
  });
  return initial;
}

async function openCandidateHireModal(candidate, select, previousStatus) {
  if (!candidate) return;
  hireModalState = { candidateId: candidate.id, select, previousStatus, candidate };
  currentHireFields = [];
  const modal = document.getElementById('candidateHireModal');
  const form = document.getElementById('candidateHireForm');
  const fieldsContainer = document.getElementById('candidateHireFields');
  const titleTextEl = document.getElementById('candidateHireTitleText');
  const subtitleEl = document.getElementById('candidateHireSubtitle');
  if (form) form.reset();
  if (titleTextEl) {
    titleTextEl.textContent = candidate.name ? `Complete record for ${candidate.name}` : 'Complete Employee Record';
  }
  if (subtitleEl) {
    subtitleEl.textContent = candidate.name
      ? `Provide the mandatory employee information to onboard ${candidate.name}.`
      : 'Provide the mandatory employee information before marking this candidate as hired.';
  }
  if (fieldsContainer) {
    fieldsContainer.innerHTML = '<p class="text-muted" style="font-style: italic;">Loading employee fields...</p>';
  }
  if (modal) {
    modal.classList.remove('hidden');
  }
  try {
    const fields = await getDynamicEmployeeFields();
    if (!hireModalState.candidateId || hireModalState.candidateId !== candidate.id) return;
    currentHireFields = Array.isArray(fields) ? fields : [];
    const initialValues = deriveHireInitialValues(candidate, currentHireFields);
    if (fieldsContainer) {
      if (currentHireFields.length) {
        fieldsContainer.innerHTML = buildDynamicFieldsHtml(currentHireFields, initialValues, 'hire');
      } else {
        fieldsContainer.innerHTML = '<p class="text-muted" style="font-style: italic;">No employee fields configured yet. Please add an employee template in Employee Management.</p>';
      }
    }
    setTimeout(() => {
      const focusTarget = document.querySelector('#candidateHireFields input, #candidateHireFields select, #candidateHireFields textarea');
      if (focusTarget) focusTarget.focus();
    }, 50);
  } catch (err) {
    if (fieldsContainer) {
      fieldsContainer.innerHTML = '<p style="color:#dc2626;">Unable to load employee fields. Please try again.</p>';
    }
  }
}

function closeCandidateHireModal() {
  const modal = document.getElementById('candidateHireModal');
  if (modal) modal.classList.add('hidden');
  const form = document.getElementById('candidateHireForm');
  if (form) form.reset();
  const fieldsContainer = document.getElementById('candidateHireFields');
  if (fieldsContainer) fieldsContainer.innerHTML = '';
  currentHireFields = [];
  hireModalState = { candidateId: null, select: null, previousStatus: null, candidate: null };
}

async function onCandidateHireSubmit(ev) {
  ev.preventDefault();
  if (!hireModalState.candidateId) {
    alert('Select a candidate to hire.');
    return;
  }
  const form = ev.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const cancelBtn = document.getElementById('candidateHireCancelBtn');
  [submitBtn, cancelBtn].forEach(btn => { if (btn) btn.disabled = true; });
  let employeeCreated = false;
  try {
    const payload = buildEmployeePayload(form, currentHireFields);
    const ensureValue = (keyName, value, overwriteEmpty = false) => {
      if (!value) return;
      const matchKey = Object.keys(payload).find(k => k.toLowerCase() === keyName.toLowerCase());
      if (matchKey) {
        if (overwriteEmpty) {
          const current = payload[matchKey];
          if (current === '' || current === null || typeof current === 'undefined') {
            payload[matchKey] = value;
          }
        }
      } else {
        payload[keyName] = value;
      }
    };
    ensureValue('name', hireModalState.candidate?.name, true);
    ensureValue('status', 'active', true);
    if (hireModalState.candidate?.contact) {
      const contact = hireModalState.candidate.contact;
      if (contact.includes('@')) {
        ensureValue('email', contact, true);
      }
    }
    const res = await apiFetch('/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to create employee record.');
    }
    employeeCreated = true;
    const candidateId = hireModalState.candidateId;
    const statusRes = await apiFetch(`/recruitment/candidates/${candidateId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Hired' })
    });
    if (!statusRes.ok) {
      const err = await statusRes.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update candidate status.');
    }
    if (hireModalState.select) {
      hireModalState.select.value = 'Hired';
      hireModalState.select.dataset.currentStatus = 'Hired';
    }
    closeCandidateHireModal();
    alert('Candidate added to Employee Management and marked as hired.');
    await Promise.all([
      loadRecruitmentCandidates(recruitmentActivePositionId),
      loadEmployeesManage(),
      loadEmployeesPortal()
    ]);
  } catch (err) {
    if (employeeCreated) {
      const message = err.message ? `${err.message} Please update the candidate status manually.` : 'Employee record created but the candidate status was not updated. Please update it manually.';
      alert(message);
      if (hireModalState.select) {
        const revert = hireModalState.previousStatus || hireModalState.select.dataset.currentStatus || PIPELINE_STATUSES[0];
        hireModalState.select.value = revert;
        hireModalState.select.dataset.currentStatus = revert;
      }
      closeCandidateHireModal();
      await Promise.all([
        loadEmployeesManage(),
        loadEmployeesPortal(),
        loadRecruitmentCandidates(recruitmentActivePositionId)
      ]);
    } else {
      alert(err.message || 'Failed to complete hiring. Please try again.');
    }
  } finally {
    [submitBtn, cancelBtn].forEach(btn => { if (btn) btn.disabled = false; });
  }
}

async function onCandidateDetailsDownloadClick(ev) {
  const button = ev.currentTarget;
  if (!button?.dataset?.candidateId || button.disabled) return;
  const id = Number(button.dataset.candidateId);
  if (!id) return;
  button.disabled = true;
  try {
    await downloadCandidateCv(id);
  } catch (err) {
    alert('Unable to download CV at the moment.');
  } finally {
    const candidate = recruitmentCandidates.find(c => c.id == id);
    const hasCv = !!candidate?.cv?.filename;
    button.disabled = !hasCv;
  }
}

function renderCandidateComments() {
  const list = document.getElementById('commentsList');
  if (!list) return;
  if (!recruitmentCandidateComments.length) {
    list.classList.add('text-muted');
    list.innerHTML = '<p style="font-style: italic;">No comments yet. Be the first to add one.</p>';
    updateCandidateCommentsCount(0);
    return;
  }
  list.classList.remove('text-muted');
  const markup = recruitmentCandidateComments.map(comment => {
    const authorEmail = escapeHtml(comment.author?.email || 'Unknown');
    const timestamp = formatRecruitmentDateTime(comment.updatedAt || comment.createdAt);
    const edited = comment.updatedAt && comment.updatedAt !== comment.createdAt ? ' (edited)' : '';
    const commentText = escapeHtml(comment.text || '').replace(/\n/g, '<br>');
    const ownClass = comment.canEdit ? ' own-comment' : '';
    const editButton = comment.canEdit ? `
      <div class="comment-actions">
        <button type="button" class="comment-edit" data-comment-id="${comment.id}">
          <span class="material-symbols-rounded">edit</span>
          Edit
        </button>
      </div>
    ` : '';
    return `
      <div class="comment-item${ownClass}">
        <div class="comment-item-meta">
          <span>${authorEmail}</span>
          <span>${timestamp || ''}${edited}</span>
        </div>
        <div class="comment-text">${commentText || '<span class="text-muted">(No content)</span>'}</div>
        ${editButton}
      </div>
    `;
  }).join('');
  list.innerHTML = markup;
  updateCandidateCommentsCount(recruitmentCandidateComments.length);
}

function updateCommentSubmitLabel() {
  const label = document.querySelector('#commentSubmitBtn .comment-submit-label');
  if (!label) return;
  label.textContent = recruitmentEditingCommentId ? 'Update Comment' : 'Add Comment';
}

async function onCommentSubmit(ev) {
  ev.preventDefault();
  if (!recruitmentActiveCommentCandidateId) return;
  const textarea = document.getElementById('commentText');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) {
    alert('Please enter a comment before submitting.');
    return;
  }
  const payload = { text };
  const candidateId = recruitmentActiveCommentCandidateId;
  const commentId = recruitmentEditingCommentId;
  const endpoint = commentId ? `/recruitment/candidates/${candidateId}/comments/${commentId}` : `/recruitment/candidates/${candidateId}/comments`;
  const method = commentId ? 'PATCH' : 'POST';
  let data;
  try {
    const res = await apiFetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed');
    data = await res.json();
  } catch (err) {
    alert('Unable to save the comment right now. Please try again.');
    return;
  }
  if (data?.comment) {
    const idx = recruitmentCandidateComments.findIndex(c => c.id == data.comment.id);
    if (idx >= 0) {
      recruitmentCandidateComments[idx] = data.comment;
    } else {
      recruitmentCandidateComments.push(data.comment);
    }
    recruitmentCandidateComments.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  }
  if (typeof data?.commentCount === 'number') {
    const normalizedId = normalizeCandidateId(candidateId);
    let shouldRender = false;
    if (normalizedId != null) {
      const candidate = recruitmentCandidates.find(c => c.id == normalizedId);
      if (candidate) {
        candidate.commentCount = data.commentCount;
        cacheCandidateDetails(candidate);
        shouldRender = true;
      }
      const cached = candidateDetailsCache.get(normalizedId);
      if (cached && cached !== candidate) {
        cached.commentCount = data.commentCount;
        cacheCandidateDetails(cached);
      }
    }
    if (shouldRender) {
      renderRecruitmentCandidates();
    }
  }
  textarea.value = '';
  recruitmentEditingCommentId = null;
  updateCommentSubmitLabel();
  renderCandidateComments();
  refreshCandidateDetailsModal();
}

function onCommentsListClick(ev) {
  const editBtn = ev.target.closest('.comment-edit');
  if (!editBtn) return;
  const commentId = editBtn.getAttribute('data-comment-id');
  if (!commentId) return;
  const comment = recruitmentCandidateComments.find(c => c.id == commentId);
  if (!comment || !comment.canEdit) return;
  recruitmentEditingCommentId = comment.id;
  const textarea = document.getElementById('commentText');
  if (textarea) {
    textarea.value = comment.text || '';
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
  updateCommentSubmitLabel();
}

function formatRecruitmentDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRecruitmentDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        const base64 = result.split(',')[1] || '';
        resolve(base64);
      } else {
        resolve('');
      }
    };
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

let pendingApply = null;
let editId = null;
let drawerEditId = null;
let empModalKeydownHandler = null;
let currentLeaveBalances = {};

async function init() {
  document.getElementById('employeeSelect').addEventListener('change', onEmployeeChange);
  document.getElementById('applyForm').addEventListener('submit', onApplySubmit);
  document.getElementById('modalCloseBtn').onclick = closeReasonModal;
  document.getElementById('reasonForm').onsubmit = onReasonSubmit;

  const profileTabBtn = document.getElementById('tabProfile');
  if (profileTabBtn) profileTabBtn.onclick = () => showPanel('profile');
  document.getElementById('tabPortal').onclick = () => showPanel('portal');
  const performanceTab = document.getElementById('tabPerformance');
  if (performanceTab) performanceTab.onclick = () => showPanel('performance');
  const learningHubTab = document.getElementById('tabLearningHub');
  if (learningHubTab) learningHubTab.onclick = () => showPanel('learningHub');
  const learningReportsTab = document.getElementById('tabLearningReports');
  if (learningReportsTab) learningReportsTab.onclick = () => showPanel('learningReports');
  const learningAdminTab = document.getElementById('tabLearningAdmin');
  if (learningAdminTab) learningAdminTab.onclick = () => showPanel('learningAdmin');
  document.getElementById('tabManage').onclick = () => showPanel('manage');
  const recruitmentTab = document.getElementById('tabRecruitment');
  if (recruitmentTab) recruitmentTab.onclick = () => showPanel('recruitment');
  const managerTab = document.getElementById('tabManagerApps');
  if (managerTab) managerTab.onclick = () => showPanel('managerApps');
  const reportTab = document.getElementById('tabLeaveReport');
  if (reportTab) reportTab.onclick = () => showPanel('leaveReport');
  const locationTab = document.getElementById('tabLocationInsights');
  if (locationTab) locationTab.onclick = () => showPanel('location');
  const settingsTab = document.getElementById('tabSettings');
  if (settingsTab) settingsTab.onclick = () => showPanel('settings');
  const financeTab = document.getElementById('tabFinance');
  if (financeTab) financeTab.onclick = () => showPanel('finance');
  const primaryTabSelect = document.getElementById('primaryTabSelect');
  const payslipBtn = document.getElementById('profilePayslipButton');
  if (payslipBtn) payslipBtn.addEventListener('click', onGeneratePayslipClick);
  if (primaryTabSelect) {
    primaryTabSelect.addEventListener('change', event => {
      showPanel(event.target.value);
    });
  }
  const defaultPanel = currentUser
    ? isSuperAdmin(currentUser)
      ? 'finance'
      : isManagerRole(currentUser.role)
        ? 'portal'
        : 'profile'
    : 'portal';
  showPanel(defaultPanel);

  document.getElementById('empTableBody').addEventListener('click', onEmpTableClick);
  document.getElementById('empTableBody').addEventListener('change', onInternFlagChange);

  const emailForm = document.getElementById('emailSettingsForm');
  if (emailForm) emailForm.addEventListener('submit', onEmailSettingsSubmit);
  const aiForm = document.getElementById('aiSettingsForm');
  if (aiForm) aiForm.addEventListener('submit', onAiSettingsSubmit);
  const chatWidgetForm = document.getElementById('chatWidgetSettingsForm');
  if (chatWidgetForm) chatWidgetForm.addEventListener('submit', onChatWidgetSettingsSubmit);
  const chatWidgetDefaultBtn = document.getElementById('chatWidgetUseDefault');
  if (chatWidgetDefaultBtn) chatWidgetDefaultBtn.addEventListener('click', resetChatWidgetUrlToDefault);
  const postLoginForm = document.getElementById('postLoginSettingsForm');
  if (postLoginForm) postLoginForm.addEventListener('submit', onPostLoginSettingsSubmit);
  const postLoginDefaultBtn = document.getElementById('postLoginUseDefault');
  if (postLoginDefaultBtn) postLoginDefaultBtn.addEventListener('click', resetPostLoginSettingsToDefault);
  const emailProviderSelect = document.getElementById('emailProvider');
  if (emailProviderSelect) {
    emailProviderSelect.addEventListener('change', onEmailProviderChange);
  }
  const emailAuthTypeSelect = document.getElementById('emailAuthType');
  if (emailAuthTypeSelect) {
    emailAuthTypeSelect.addEventListener('change', onEmailAuthTypeChange);
  }
  const emailEnabledToggle = document.getElementById('emailEnabled');
  if (emailEnabledToggle) {
    emailEnabledToggle.addEventListener('change', () => {
      updateEmailSettingsFormState();
      const message = emailEnabledToggle.checked
        ? 'Email notifications will be enabled after you save.'
        : 'Email notifications will be disabled after you save.';
      setEmailSettingsStatus(message);
    });
  }
  const emailPasswordInput = document.getElementById('emailPassword');
  if (emailPasswordInput) {
    emailPasswordInput.addEventListener('input', () => {
      emailPasswordInput.dataset.dirty = 'true';
      const help = document.getElementById('emailPasswordHelp');
      if (help) {
        help.textContent = emailPasswordInput.value
          ? 'Password will be updated when you save.'
          : emailSettingsHasPassword
            ? 'Password is hidden. Enter a new value to update it.'
            : 'Provide the SMTP account password.';
      }
    });
  }
  const emailOAuthClientSecretInput = document.getElementById('emailOAuthClientSecret');
  if (emailOAuthClientSecretInput) {
    emailOAuthClientSecretInput.addEventListener('input', () => {
      emailOAuthClientSecretInput.dataset.dirty = 'true';
      const help = document.getElementById('emailOAuthClientSecretHelp');
      if (help) {
        help.textContent = emailOAuthClientSecretInput.value
          ? 'Client secret will be updated when you save.'
          : emailSettingsHasClientSecret
            ? 'Client secret is hidden. Enter a new value to update it.'
            : 'Provide the Azure AD application client secret.';
      }
    });
  }
  const emailOAuthRefreshTokenInput = document.getElementById('emailOAuthRefreshToken');
  if (emailOAuthRefreshTokenInput) {
    emailOAuthRefreshTokenInput.addEventListener('input', () => {
      emailOAuthRefreshTokenInput.dataset.dirty = 'true';
      const help = document.getElementById('emailOAuthRefreshTokenHelp');
      if (help) {
        help.textContent = emailOAuthRefreshTokenInput.value
          ? 'Refresh token will be updated when you save.'
          : emailSettingsHasRefreshToken
            ? 'Refresh token is hidden. Enter a new value to update it.'
            : 'Provide a delegated refresh token if your app uses delegated permissions.';
      }
    });
  }
  ['emailHost', 'emailPort'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => {
        rememberCustomEmailSettings();
      });
    }
  });
  const emailSecureCheckbox = document.getElementById('emailSecure');
  if (emailSecureCheckbox) {
    emailSecureCheckbox.addEventListener('change', () => {
      rememberCustomEmailSettings();
    });
  }

  const empSearchInput = document.getElementById('empSearchInput');
  if (empSearchInput) {
    empSearchInput.addEventListener('input', () => {
      empSearchTerm = empSearchInput.value;
      employeeGridState.page = 1;
      loadEmployeesManage();
    });
  }

  const employeeStatusFilter = document.getElementById('employeeStatusFilter');
  if (employeeStatusFilter) {
    employeeStatusFilter.addEventListener('change', () => {
      employeeGridState.statusFilter = employeeStatusFilter.value;
      employeeGridState.page = 1;
      loadEmployeesManage();
    });
  }

  const employeeInternFilter = document.getElementById('employeeInternFilter');
  if (employeeInternFilter) {
    employeeInternFilter.addEventListener('change', () => {
      employeeGridState.internFilter = employeeInternFilter.value;
      employeeGridState.page = 1;
      loadEmployeesManage();
    });
  }

  const employeePageSize = document.getElementById('employeePageSize');
  if (employeePageSize) {
    employeePageSize.addEventListener('change', () => {
      employeeGridState.pageSize = Number(employeePageSize.value) || 8;
      employeeGridState.page = 1;
      loadEmployeesManage();
    });
  }

  const tableViewBtn = document.getElementById('tableViewBtn');
  const cardViewBtn = document.getElementById('cardViewBtn');
  if (tableViewBtn && cardViewBtn) {
    tableViewBtn.addEventListener('click', () => {
      employeeGridState.view = 'table';
      tableViewBtn.classList.add('view-toggle__btn--active');
      cardViewBtn.classList.remove('view-toggle__btn--active');
      document.getElementById('employeeCardWrapper')?.classList.add('hidden');
      document.querySelector('.data-grid-card')?.classList.remove('hidden');
      loadEmployeesManage();
    });
    cardViewBtn.addEventListener('click', () => {
      employeeGridState.view = 'cards';
      cardViewBtn.classList.add('view-toggle__btn--active');
      tableViewBtn.classList.remove('view-toggle__btn--active');
      document.getElementById('employeeCardWrapper')?.classList.remove('hidden');
      document.querySelector('.data-grid-card')?.classList.add('hidden');
      loadEmployeesManage();
    });
  }

  document.getElementById('addEmployeeBtn').onclick = async () => {
    const fields = await getDynamicEmployeeFields();
    openEmpDrawer({title: 'Add Employee', fields});
  };
  const csvBtn = document.getElementById('csvUploadBtn');
  const csvInput = document.getElementById('csvInput');
  if (csvBtn && csvInput) {
    csvBtn.onclick = () => csvInput.click();
    csvInput.onchange = async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      const text = await file.text();
      await fetch(API + '/employees/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text
      });
      ev.target.value = '';
      await loadEmployeesManage();
      await loadEmployeesPortal();
    };
  }
  const leaveCsvBtn = document.getElementById('leaveCsvUploadBtn');
  const leaveCsvInput = document.getElementById('leaveCsvInput');
  if (leaveCsvBtn && leaveCsvInput) {
    leaveCsvBtn.onclick = () => leaveCsvInput.click();
    leaveCsvInput.onchange = async ev => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await apiFetch('/applications/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv' },
          body: text
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to import leave data.');
        }
        const added = Number(data.added || 0);
        const skipped = Number(data.skipped || 0);
        const errors = Array.isArray(data.errors) ? data.errors : [];
        let message = `Imported ${added} leave record${added === 1 ? '' : 's'}.`;
        if (skipped) {
          message += ` Skipped ${skipped} row${skipped === 1 ? '' : 's'}.`;
        }
        if (errors.length) {
          message += `\n\nIssues:\n- ${errors.join('\n- ')}`;
        }
        alert(message);
        await onEmployeeChange();
        if (isManagerRole(currentUser)) {
          await loadLeaveReport();
          await loadLeaveCalendar();
        }
      } catch (err) {
        console.error('Leave CSV import failed', err);
        alert(err.message || 'Failed to import leave data.');
      } finally {
        ev.target.value = '';
      }
    };
  }
  const exportBtn = document.getElementById('exportLeavesBtn');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      try {
        const res = await apiFetch('/leave-report/export');
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'leave-report.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert('Failed to export leave report');
      }
    };
  }
  const holidayForm = document.getElementById('holidayForm');
  if (holidayForm) {
    holidayForm.addEventListener('submit', onHolidaySubmit);
  }
  const holidayList = document.getElementById('holidayList');
  if (holidayList) {
    holidayList.addEventListener('click', onHolidayListClick);
  }
  const reportApply = document.getElementById('reportApply');
  const reportWeek = document.getElementById('reportWeek');
  const reportMonth = document.getElementById('reportMonth');
  if (reportApply) {
    reportApply.onclick = () => {
      const s = document.getElementById('reportStart').value;
      const e = document.getElementById('reportEnd').value;
      loadLeaveRange(s, e);
    };
  }
  if (reportWeek) {
    reportWeek.onclick = () => {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 7);
      document.getElementById('reportStart').value = start.toISOString().substring(0,10);
      document.getElementById('reportEnd').value = end.toISOString().substring(0,10);
      loadLeaveRange(document.getElementById('reportStart').value, document.getElementById('reportEnd').value);
    };
  }
  if (reportMonth) {
    reportMonth.onclick = () => {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 30);
      document.getElementById('reportStart').value = start.toISOString().substring(0,10);
      document.getElementById('reportEnd').value = end.toISOString().substring(0,10);
      loadLeaveRange(document.getElementById('reportStart').value, document.getElementById('reportEnd').value);
    };
  }
  const empModal = document.getElementById('empModal');
  if (empModal) {
    empModal.addEventListener('click', ev => {
      if (ev.target === empModal) {
        closeEmpDrawer();
      }
    });
  }
  const empModalCancelBtn = document.getElementById('empModalCancelBtn');
  if (empModalCancelBtn) empModalCancelBtn.onclick = closeEmpDrawer;
  const empModalCloseBtn = document.getElementById('empModalCloseBtn');
  if (empModalCloseBtn) empModalCloseBtn.onclick = closeEmpDrawer;
  const empModalForm = document.getElementById('empModalForm');
  if (empModalForm) empModalForm.addEventListener('submit', onEmpDrawerSubmit);

  // Change password handlers
  document.getElementById('changePassBtn').onclick = openChangePassModal;
  document.getElementById('passModalClose').onclick = closeChangePassModal;
  document.getElementById('cancelPassChange').onclick = closeChangePassModal;
  document.getElementById('changePassForm').onsubmit = onChangePassSubmit;

  const empCancelBtn = document.getElementById('empCancelBtn');
  if (empCancelBtn) empCancelBtn.onclick = onEmpCancel;
  const empForm = document.getElementById('empForm');
  if (empForm) empForm.onsubmit = onEmpFormSubmit;

  if (isManagerRole(currentUser)) {
    await initRecruitment();
  }

  fetchHolidays().then(() => {
    renderHolidayHighlights();
  }).catch(err => {
    console.error('Failed to fetch holidays', err);
    renderHolidayHighlights({ error: 'Unable to load holidays.' });
  });

  await loadEmployeesPortal();
  await loadEmployeesManage();
  await onEmployeeChange();
}

// ----------- LEAVE PORTAL & REPORTS -----------
async function getJSON(path) {
  const res = await apiFetch(path);
  if (!res.ok) return [];
  return await res.json();
}

async function loadEmployeesPortal() {
  const emps = await getJSON('/employees');
  let filteredEmps = emps;
  if (currentUser && !isManagerRole(currentUser)) {
    filteredEmps = emps.filter(e => e.id == currentUser.employeeId);
  }
  ['employeeSelect', 'reportSelect'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">-- choose --</option>';
    filteredEmps.forEach(e => sel.add(new Option(e.name, e.id)));
  });
  if (filteredEmps.length === 1) {
    const empSel = document.getElementById('employeeSelect');
    const reportSel = document.getElementById('reportSelect');
    if (empSel) {
      empSel.value = filteredEmps[0].id;
      empSel.dispatchEvent(new Event('change'));
    }
    if (reportSel) {
      reportSel.value = filteredEmps[0].id;
      reportSel.dispatchEvent(new Event('change'));
    }
  }
}

async function onEmployeeChange() {
  const empId = document.getElementById('employeeSelect').value;
  const balAnnual = document.getElementById('balAnnual');
  const balCasual = document.getElementById('balCasual');
  const balMedical = document.getElementById('balMedical');
  const typeSel = document.getElementById('type');
  const applyBtn = document.querySelector('#applyForm button[type="submit"]');
  if (!empId) {
    [balAnnual, balCasual, balMedical].forEach(el => {
      if (el) {
        el.textContent = '-';
        el.classList.remove('balance-negative');
      }
    });
    currentLeaveBalances = {};
    populateLeaveTypeOptions(typeSel, currentLeaveBalances);
    updateBalanceWarning(currentLeaveBalances);
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.title = 'Select an employee to apply for leave.';
    }
    document.getElementById('prevLeaves').innerHTML = '';
    return;
  }
  // Fetch employee and applications
  const [emps, apps] = await Promise.all([
    getJSON('/employees'),
    getJSON(`/applications?employeeId=${empId}`)
  ]);
  const emp = emps.find(e => e.id == empId);
  if (!emp) return;

  const { available } = buildAvailableLeaveState(emp.leaveBalances, apps);
  currentLeaveBalances = available;

  setBalanceValue('balAnnual', currentLeaveBalances.annual);
  setBalanceValue('balCasual', currentLeaveBalances.casual);
  setBalanceValue('balMedical', currentLeaveBalances.medical);

  // Set leave type options and warning
  const { hasEnabled } = populateLeaveTypeOptions(typeSel, currentLeaveBalances);
  updateBalanceWarning(currentLeaveBalances);
  if (applyBtn) {
    applyBtn.disabled = !hasEnabled;
    applyBtn.title = hasEnabled ? '' : 'Applications are disabled until balances are non-negative.';
  }

  // Show previous leaves
  renderPreviousLeaves(apps, emp);
}

// ----------- LEAVE APPLICATION SUBMISSION -----------
function onApplySubmit(ev) {
  ev.preventDefault();
  const empId = document.getElementById('employeeSelect').value;
  const type = document.getElementById('type').value;
  const from = document.getElementById('from').value;
  const to = document.getElementById('to').value;
  const halfDay = document.getElementById('halfDay').checked;
  const halfDayPeriod = halfDay ? document.getElementById('halfDayPeriod').value : null;
  if (!empId || !type || !from || !to) {
    showToast('Please fill in all required leave details before continuing.', 'warning');
    return;
  }
  if (currentLeaveBalances[type] < 0 && !isManagerRole(currentUser?.role)) {
    showToast('This leave type is disabled because the balance is negative.', 'warning');
    return;
  }
  pendingApply = { employeeId: +empId, type, from, to, halfDay, halfDayPeriod };
  openReasonModal();
}

function openReasonModal() {
  document.getElementById('reasonInput').value = '';
  document.getElementById('reasonModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('reasonInput').focus(), 100);
}
function closeReasonModal() {
  document.getElementById('reasonModal').classList.add('hidden');
  pendingApply = null;
}

function openChangePassModal() {
  document.getElementById('changePassForm').reset();
  document.getElementById('changePassModal').classList.remove('hidden');
}

function closeChangePassModal() {
  document.getElementById('changePassModal').classList.add('hidden');
}

async function onChangePassSubmit(ev) {
  ev.preventDefault();
  const current = document.getElementById('currentPassword').value.trim();
  const np = document.getElementById('newPassword').value.trim();
  const cp = document.getElementById('confirmPassword').value.trim();
  if (np !== cp) {
    alert('Passwords do not match');
    return;
  }
  const res = await apiFetch('/change-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ currentPassword: current, newPassword: np })
  });
  if (res.ok) {
    alert('Password changed successfully');
    closeChangePassModal();
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Error changing password');
  }
}
async function onReasonSubmit(ev) {
  ev.preventDefault();
  if (!pendingApply) return;
  const reasonInput = document.getElementById('reasonInput');
  const reason = reasonInput.value.trim();
  if (!reason) {
    showToast('Please share a reason for your leave request.', 'warning');
    reasonInput.focus();
    return;
  }
  const submitBtn = ev.submitter || document.querySelector('#reasonForm button[type="submit"]');
  setButtonLoading(submitBtn, true);
  const payload = { ...pendingApply, reason };
  try {
    const res = await apiFetch('/applications', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('Leave applied successfully.', 'success');
      document.getElementById('applyForm').reset();
      closeReasonModal();
      await onEmployeeChange();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Error applying leave.', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('Unable to apply for leave right now. Please try again.', 'error');
  } finally {
    setButtonLoading(submitBtn, false);
  }
}

function renderPreviousLeaves(apps, emp) {
  const container = document.getElementById('prevLeaves');
  if (!apps.length) {
    container.innerHTML = '<div class="text-muted" style="font-style:italic;">No leave applications yet.</div>';
    return;
  }
  const typeIcon = { annual: 'beach_access', casual: 'sunny', medical: 'medical_information' };
  container.innerHTML = apps.sort((a,b)=>new Date(b.from)-new Date(a.from)).map(app => {
    let days = calculateLeaveDays(app.from, app.to, app.halfDay);
    let daysText = days;
    let typeLabel = capitalize(app.type) + ' Leave';
    if (app.halfDay) {
      typeLabel += ` (Half Day${app.halfDayPeriod ? ' ' + app.halfDayPeriod : ''})`;
    }
    const status = (app.status || 'pending').toLowerCase();
    const statusClass = status === 'approved' ? 'status-approved' : status === 'rejected' ? 'status-rejected' : 'status-pending';
    const icon = typeIcon[app.type] || 'event';
    return `
      <article class="history-card ${statusClass}">
        <div class="history-top-row">
          <div class="history-header">
            <span class="material-symbols-rounded">${icon}</span>
            <span>${typeLabel}</span>
          </div>
          <span class="status-badge">${capitalize(app.status||'pending')}</span>
        </div>
        <div class="history-body">
          <div class="text-muted"><strong>From:</strong> ${app.from}</div>
          <div class="text-muted"><strong>To:</strong> ${app.to}</div>
          <div class="text-muted"><strong>Days:</strong> ${daysText}</div>
          <div class="text-muted"><strong>Reason:</strong> <span class="text-quiet">${app.reason||'-'}</span></div>
          ${app.approvedBy ? `<div class="text-quiet">Approver: ${app.approvedBy}</div>` : ''}
          ${app.approverRemark ? `<div class="text-quiet">Remark: ${app.approverRemark}</div>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function calculateLeaveDays(from, to, halfDay) {
  const start = new Date(from);
  const end = new Date(to);
  if (halfDay) {
    const day = start.getDay();
    return (day === 0 || day === 6) ? 0 : 0.5;
  }
  let days = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}

// ========== MANAGER LEAVE APPLICATIONS TAB LOGIC ==========

async function loadManagerApplications() {
  // Get all pending applications
  const apps = await getJSON('/applications?status=pending');
  const emps = await getJSON('/employees');
  const list = document.getElementById('managerAppsList');
  if (!apps.length) {
    list.innerHTML = `<div class="text-muted" style="font-style:italic;">No pending leave applications.</div>`;
  } else {
    list.innerHTML = apps.map(app => {
      const emp = emps.find(e => e.id == app.employeeId);
      let days = calculateLeaveDays(app.from, app.to, app.halfDay);
      let daysText = days;
      let typeLabel = capitalize(app.type) + ' Leave';
      if (app.halfDay) {
        typeLabel += ` (Half Day${app.halfDayPeriod ? ' ' + app.halfDayPeriod : ''})`;
      }
      // Calculate cancel eligibility: current date before "from" date
      const now = new Date();
      const canCancel = new Date(app.from) > now;
      return `
        <article class="list-card">
          <div class="list-card__main">
            <div class="list-card__header">
              <span class="material-symbols-rounded">assignment_ind</span>
              <span>${emp ? emp.name : 'Unknown'}</span>
              <span class="chip chip--info">${typeLabel}</span>
            </div>
            <div class="text-muted"><strong>From:</strong> ${app.from} · <strong>To:</strong> ${app.to} · <strong>Days:</strong> ${daysText}</div>
            <div class="text-muted"><strong>Reason:</strong> <span class="text-quiet">${app.reason||'-'}</span></div>
          </div>
          <textarea id="remark-${app.id}" placeholder="Add an optional remark…"></textarea>
          <div class="list-card__actions">
            <button class="md-button md-button--success md-button--small" onclick="approveApp(${app.id}, true, this)">
              <span class="material-symbols-rounded">check</span>
              Approve
            </button>
            <button class="md-button md-button--danger md-button--small" onclick="approveApp(${app.id}, false, this)">
              <span class="material-symbols-rounded">close</span>
              Reject
            </button>
            ${canCancel ? `<button class="md-button md-button--outlined md-button--small" onclick="cancelApp(${app.id})"><span class="material-symbols-rounded">cancel_schedule_send</span>Cancel</button>` : ''}
          </div>
        </article>
      `;
    }).join('');
  }
  // show today leave employees
  await loadOnLeaveToday();  // <== 👈 keep this call

  // === NEW: Upcoming Approved Leaves (next 1 month) ===
  await loadManagerUpcomingLeaves();

  // Show cancel for future approved as well
  await loadManagerUpcomingLeaves(true);
}


async function loadOnLeaveToday() {
  const list = document.getElementById('onLeaveTodayList');
  list.innerHTML = `<div class="text-muted">Loading...</div>`;
  try {
    const [emps, apps] = await Promise.all([
      getJSON('/employees'),
      getJSON('/applications')
    ]);
    const today = new Date().toISOString().slice(0, 10);

    // Filter apps: status=approved AND today in [from, to]
    const onLeave = apps.filter(app =>
      app.status === 'approved' &&
      new Date(app.from) <= new Date(today) &&
      new Date(app.to) >= new Date(today)
    );

    if (!onLeave.length) {
      list.innerHTML = `<div class="text-muted" style="font-style:italic;">No one is on leave today.</div>`;
      return;
    }

    list.innerHTML = onLeave.map(app => {
      const emp = emps.find(e => e.id == app.employeeId);
      let typeLabel = capitalize(app.type) + ' Leave';
      if (app.halfDay) {
        typeLabel += ` (Half Day${app.halfDayPeriod ? ' ' + app.halfDayPeriod : ''})`;
      }
      return `
        <article class="history-card" style="background: rgba(255, 248, 230, 0.9); border-color: rgba(255, 211, 140, 0.45);">
          <div class="history-header">
            <span class="material-symbols-rounded">flight_takeoff</span>
            <span>${emp ? emp.name : 'Unknown'}</span>
            ${emp && emp.Project ? `<span class="chip chip--info">${emp.Project}</span>` : ''}
          </div>
          <div class="text-muted"><strong>Type:</strong> <span class="chip chip--approved">${typeLabel}</span></div>
          <div class="text-muted"><strong>From:</strong> ${app.from}</div>
          <div class="text-muted"><strong>To:</strong> ${app.to}</div>
          <div class="text-muted"><strong>Reason:</strong> <span class="text-quiet">${app.reason || '-'}</span></div>
        </article>
      `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="text-muted" style="color:#b3261e;">Failed to load on-leave data.</div>`;
    console.error(err);
  }
}

async function loadManagerUpcomingLeaves(showCancel = false) {
  const list = document.getElementById('managerUpcomingList');
  if (!list) return;
  const allApproved = await getJSON('/applications?status=approved');
  const emps = await getJSON('/employees');
  const now = new Date();
  const oneMonthLater = new Date();
  oneMonthLater.setMonth(now.getMonth() + 1);

  const filtered = allApproved.filter(app => {
    const from = new Date(app.from);
    const to = new Date(app.to);
    return (
      (from >= now && from <= oneMonthLater) ||
      (to >= now && to <= oneMonthLater) ||
      (from <= now && to >= now)
    );
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="text-muted" style="font-style:italic;">No upcoming approved leaves in the next 1 month.</div>`;
    return;
  }

  const typeIcon = { annual: 'beach_access', casual: 'sunny', medical: 'medical_information' };

  list.innerHTML = filtered.sort((a, b) => new Date(a.from) - new Date(b.from)).map(app => {
    const emp = emps.find(e => e.id == app.employeeId);
    let days = calculateLeaveDays(app.from, app.to, app.halfDay);
    let daysText = days;
    let typeLabel = capitalize(app.type) + ' Leave';
    if (app.halfDay) {
      typeLabel += ` (Half Day${app.halfDayPeriod ? ' ' + app.halfDayPeriod : ''})`;
    }
    // Show cancel if approved leave in future
    const canCancel = new Date(app.from) > now;
    const icon = typeIcon[app.type] || 'event_available';
    return `
      <article class="list-card">
        <div class="list-card__main">
          <div class="list-card__header">
            <span class="material-symbols-rounded">${icon}</span>
            <span>${typeLabel}</span>
            <span class="chip chip--approved">Approved</span>
          </div>
          <div class="text-muted"><strong>Name:</strong> ${emp ? emp.name : 'Unknown'}</div>
          <div class="text-muted"><strong>From:</strong> ${app.from} · <strong>To:</strong> ${app.to}</div>
          <div class="text-muted"><strong>Days:</strong> ${daysText}</div>
          <div class="text-muted"><strong>Reason:</strong> <span class="text-quiet">${app.reason||'-'}</span></div>
          <div class="text-quiet">By: ${app.approvedBy||'-'}</div>
          ${app.approverRemark ? `<div class="text-quiet">Remark: ${app.approverRemark}</div>` : ''}
          ${app.approvedAt ? `<div class="text-quiet">Approved At: ${app.approvedAt.substring(0,10)}</div>` : ''}
        </div>
        ${canCancel ? `<div class="list-card__actions"><button class="md-button md-button--outlined md-button--small" onclick="cancelApp(${app.id})"><span class="material-symbols-rounded">cancel</span>Cancel</button></div>` : ''}
      </article>
    `;
  }).join('');
}

window.approveApp = async function(id, approve, buttonEl) {
  const remark = document.getElementById(`remark-${id}`)?.value || '';
  const relatedButtons = buttonEl instanceof HTMLElement
    ? Array.from(buttonEl.closest('.list-card__actions')?.querySelectorAll('button') || []).filter(btn => btn !== buttonEl)
    : [];

  if (buttonEl instanceof HTMLElement) {
    setButtonLoading(buttonEl, true);
    relatedButtons.forEach(btn => (btn.disabled = true));
  }

  let success = false;

  try {
    const res = await apiFetch(`/applications/${id}/${approve ? 'approve' : 'reject'}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approver: currentUser ? currentUser.email : '',
        remark
      })
    });

    if (res.ok) {
      success = true;
      showToast(approve ? 'Leave approved.' : 'Leave rejected.', 'success');
      await loadManagerApplications();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Error updating leave.', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('Unable to update leave at the moment. Please try again.', 'error');
  } finally {
    if (!success) {
      setButtonLoading(buttonEl, false);
      relatedButtons.forEach(btn => (btn.disabled = false));
    }
  }
};

// NEW: Cancel Leave Functionality for Manager
window.cancelApp = async function(appId) {
  if (!confirm("Are you sure to cancel this leave application?")) return;
  const res = await apiFetch(`/applications/${appId}/cancel`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      manager: currentUser ? currentUser.email : ''
    })
  });
  if (res.ok) {
    alert('Leave cancelled.');
    await loadManagerApplications();
    await onEmployeeChange();
  } else {
    alert('Failed to cancel leave.');
  }
};

// ======== EMPLOYEE MANAGEMENT LOGIC ========

async function loadEmployeesManage() {
  const emps = await getJSON('/employees');
  const employees = Array.isArray(emps) ? emps : [];
  const head = document.getElementById('empTableHead');
  const body = document.getElementById('empTableBody');
  const pagination = document.getElementById('empPagination');
  const dataGridCard = document.querySelector('.data-grid-card');
  const cardsWrapper = document.getElementById('employeeCardWrapper');

  if (!head || !body) return;

  const internFlagKey = employees.length
    ? Object.keys(employees[0]).find(k => k.toLowerCase() === 'internflag') || 'internFlag'
    : 'internFlag';
  const internFlagKeyNormalized = internFlagKey.toLowerCase();
  const normalizedEmps = employees.map(emp => ({
    ...emp,
    [internFlagKey]: normalizeInternFlag(emp ? emp[internFlagKey] : false)
  }));

  const searchInput = document.getElementById('empSearchInput');
  if (searchInput && searchInput.value !== empSearchTerm) {
    searchInput.value = empSearchTerm;
  }
  const pageSizeSelect = document.getElementById('employeePageSize');
  if (pageSizeSelect && Number(pageSizeSelect.value) !== employeeGridState.pageSize) {
    pageSizeSelect.value = String(employeeGridState.pageSize);
  }
  const statusFilterSelect = document.getElementById('employeeStatusFilter');
  if (statusFilterSelect && statusFilterSelect.value !== employeeGridState.statusFilter) {
    statusFilterSelect.value = employeeGridState.statusFilter;
  }
  const internFilterSelect = document.getElementById('employeeInternFilter');
  if (internFilterSelect && internFilterSelect.value !== employeeGridState.internFilter) {
    internFilterSelect.value = employeeGridState.internFilter;
  }

  const sampleEmployee = normalizedEmps[0] || {};
  const findKey = (aliases, fallback = '') => {
    return Object.keys(sampleEmployee).find(k => aliases.includes(k.toLowerCase())) || fallback;
  };

  const nameKey = findKey(['name', 'employee name'], 'name');
  const statusKey = findKey(['status'], 'status');
  const roleKey = findKey(['role', 'position']);
  const titleKey = findKey(['title', 'jobtitle', 'job title']);
  const emailKey = findKey(['email', 'work email']);
  const supervisorKey = findKey([
    'supervisor',
    'manager',
    'reportingmanager',
    'reporting manager',
    'appraiser',
    'appariser'
  ]);
  const departmentKey = findKey(['department', 'dept']);
  const joinDateKey = findKey(['joindate', 'joiningdate', 'startdate', 'date of joining']);
  const employeeIdKey = findKey(['employeeid', 'employee_id', 'empid']);

  const metric = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const activeCount = normalizedEmps.filter(e => isActiveEmployeeStatus(e[statusKey])).length;
  const internCount = normalizedEmps.filter(e => normalizeInternFlag(e[internFlagKey])).length;
  const deptSet = new Set(
    normalizedEmps
      .map(e => (departmentKey ? (e[departmentKey] || 'Unassigned') : null))
      .filter(Boolean)
  );
  metric('totalEmployeesMetric', normalizedEmps.length);
  metric('activeCountNum', activeCount);
  metric('internCountMetric', internCount);
  metric('departmentCountMetric', deptSet.size);

  const baseHiddenKeys = new Set(['id', 'leavebalances', 'password']);
  const optionalKeys = Object.keys(sampleEmployee).filter(k => {
    const lower = k.toLowerCase();
    return ![
      nameKey.toLowerCase(),
      statusKey.toLowerCase(),
      internFlagKeyNormalized,
      (titleKey || '').toLowerCase(),
      (emailKey || '').toLowerCase(),
      (supervisorKey || '').toLowerCase(),
      (employeeIdKey || '').toLowerCase(),
      (departmentKey || '').toLowerCase()
    ].includes(lower) && !baseHiddenKeys.has(lower);
  });

  const buildColumns = () => {
    const cols = [
      { key: nameKey, label: 'Name', sticky: 'name', sortable: true, width: 220, truncate: true, alwaysVisible: true },
      { key: statusKey, label: 'Status', sticky: 'status', sortable: true, width: 150, type: 'status', alwaysVisible: true }
    ];
    if (titleKey) cols.push({ key: titleKey, label: 'Title', sortable: true, width: 170, type: 'title', truncate: true });
    cols.push({ key: internFlagKey, label: 'Intern', width: 120, type: 'intern' });
    if (emailKey) cols.push({ key: emailKey, label: 'Email', width: 220, truncate: true });
    if (supervisorKey) cols.push({ key: supervisorKey, label: 'Supervisor', width: 200, truncate: true });
    if (employeeIdKey) cols.push({ key: employeeIdKey, label: 'ID', width: 140, truncate: true });
    if (departmentKey) cols.push({ key: departmentKey, label: 'Department', sortable: true, width: 160 });
    optionalKeys.forEach(key => {
      cols.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), width: 160, truncate: true });
    });
    cols.push({ key: 'actions', label: 'Actions', sticky: 'actions', width: 230, type: 'actions', alwaysVisible: true });
    return cols;
  };

  const columns = buildColumns();
  columns.forEach(col => {
    if (employeeGridState.columnVisibility[col.key] === undefined) {
      employeeGridState.columnVisibility[col.key] = true;
    }
    if (employeeGridState.columnWidths[col.key] === undefined && col.width) {
      employeeGridState.columnWidths[col.key] = col.width;
    }
  });

  const searchValue = empSearchTerm.trim().toLowerCase();
  const filtered = normalizedEmps.filter(emp => {
    const statusValue = String(emp[statusKey] ?? '').toLowerCase();
    if (employeeGridState.statusFilter !== 'all' && statusValue !== employeeGridState.statusFilter) return false;
    const isIntern = normalizeInternFlag(emp[internFlagKey]);
    if (employeeGridState.internFilter === 'intern' && !isIntern) return false;
    if (employeeGridState.internFilter === 'fte' && isIntern) return false;
    if (!searchValue) return true;
    return Object.entries(emp).some(([key, value]) => {
      if (key.toLowerCase() === 'id') return false;
      if (value === null || typeof value === 'undefined') return false;
      if (typeof value === 'object') {
        try { return JSON.stringify(value).toLowerCase().includes(searchValue); } catch (e) { return false; }
      }
      return String(value).toLowerCase().includes(searchValue);
    });
  });

  const renderPills = () => {
    const pillContainer = document.getElementById('dataGridPills');
    if (!pillContainer) return;
    const pills = [];
    if (empSearchTerm.trim()) {
      pills.push(`<span class="data-grid__pill"><span class="material-symbols-rounded">search</span>${escapeHtml(empSearchTerm.trim())}</span>`);
    }
    if (employeeGridState.statusFilter !== 'all') {
      pills.push(`<span class="data-grid__pill"><span class="material-symbols-rounded">verified</span>Status: ${employeeGridState.statusFilter}</span>`);
    }
    if (employeeGridState.internFilter !== 'all') {
      const label = employeeGridState.internFilter === 'intern' ? 'Interns' : 'Full-time';
      pills.push(`<span class="data-grid__pill"><span class="material-symbols-rounded">workspace_premium</span>${label}</span>`);
    }
    pillContainer.innerHTML = pills.length ? pills.join('') : '<span class="text-muted">No filters applied</span>';
  };

  if (!employeeGridState.sort.key) {
    employeeGridState.sort = { key: nameKey, direction: 'asc' };
  }

  const compareValues = (a, b, key) => {
    const valA = a[key];
    const valB = b[key];
    if (typeof valA === 'number' && typeof valB === 'number') return valA - valB;
    return String(valA ?? '').localeCompare(String(valB ?? ''), undefined, { sensitivity: 'base' });
  };

  filtered.sort((a, b) => {
    const { key, direction } = employeeGridState.sort;
    if (!key || key === 'actions') return 0;
    const multiplier = direction === 'desc' ? -1 : 1;
    return compareValues(a, b, key) * multiplier;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / employeeGridState.pageSize));
  if (employeeGridState.page > totalPages) employeeGridState.page = totalPages;
  const startIdx = (employeeGridState.page - 1) * employeeGridState.pageSize;
  const pageRows = filtered.slice(startIdx, startIdx + employeeGridState.pageSize);

  const visibleColumns = columns.filter(col => col.alwaysVisible || employeeGridState.columnVisibility[col.key]);
  const nameWidth = employeeGridState.columnWidths[nameKey] || 220;
  const tableEl = document.getElementById('empTable');
  if (tableEl) {
    tableEl.style.setProperty('--name-col-width', `${nameWidth}px`);
  }

  const renderValue = (value) => {
    if (value === null || typeof value === 'undefined') return '';
    if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
    return escapeHtml(String(value));
  };

  const renderStatusBadge = status => {
    const normalized = String(status || '').toLowerCase();
    const active = normalized === 'active';
    const badgeClass = active ? 'badge--success' : 'badge--neutral';
    const label = status || 'Unknown';
    return `<span class="badge ${badgeClass}">${escapeHtml(label)}</span>`;
  };

  const renderTitleBadge = title => {
    if (!title) return '<span class="text-muted">-</span>';
    return `<span class="badge badge--info">${escapeHtml(title)}</span>`;
  };

  const renderHeader = () => {
    head.innerHTML = '<tr>' + visibleColumns.map(col => {
      const width = employeeGridState.columnWidths[col.key] || col.width || 160;
      const stickyClass = col.sticky ? `sticky-${col.sticky}` : '';
      const sortIcon = employeeGridState.sort.key === col.key
        ? `<span class="sort-indicator material-symbols-rounded">${employeeGridState.sort.direction === 'asc' ? 'north' : 'south'}</span>`
        : '';
      const sortable = col.type !== 'actions' && col.type !== 'intern';
      const sortAttrs = sortable ? `data-sortable="true" data-sort-key="${col.key}"` : '';
      return `<th data-col-key="${col.key}" class="${stickyClass}" style="min-width:${width}px;max-width:${width}px;width:${width}px;" ${sortAttrs}>
        <button type="button" class="sort-button" data-sort-toggle="${col.key}">
          <span>${escapeHtml(col.label)}</span>${sortIcon}
        </button>
        <span class="resize-handle" data-resize="${col.key}"><span></span></span>
      </th>`;
    }).join('') + '</tr>';
  };

  const renderBody = () => {
    if (!pageRows.length) {
      body.innerHTML = `<tr><td colspan="${visibleColumns.length}" class="table-empty">No employees match your search.</td></tr>`;
      return;
    }
    body.innerHTML = pageRows.map((emp, idx) => {
      const rowId = String(emp.id ?? idx);
      const expanded = employeeGridState.expanded.has(rowId);
      const cells = visibleColumns.map(col => {
        const width = employeeGridState.columnWidths[col.key] || col.width || 160;
        const stickyClass = col.sticky ? `sticky-${col.sticky}` : '';
        const value = emp[col.key];
        if (col.type === 'status') {
          return `<td data-col-key="${col.key}" class="${stickyClass}" style="min-width:${width}px;max-width:${width}px;width:${width}px;">${renderStatusBadge(value)}</td>`;
        }
        if (col.type === 'title') {
          return `<td data-col-key="${col.key}" class="${stickyClass}" style="min-width:${width}px;max-width:${width}px;width:${width}px;">${renderTitleBadge(value)}</td>`;
        }
        if (col.type === 'intern') {
          const isOn = normalizeInternFlag(value);
          return `<td data-col-key="${col.key}" style="min-width:${width}px;max-width:${width}px;width:${width}px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="badge ${isOn ? 'badge--warning' : 'badge--neutral'}">${isOn ? 'Intern' : 'Full-time'}</span>
              <label class="intern-toggle ${isOn ? 'is-on' : ''}">
                <input
                  type="checkbox"
                  class="intern-flag-toggle sr-only"
                  data-employee-id="${escapeHtml(String(emp.id ?? ''))}"
                  ${isOn ? 'checked' : ''}
                  aria-label="Toggle intern flag for ${escapeHtml(emp[nameKey] ?? 'employee')}"
                >
              </label>
            </div>
          </td>`;
        }
        if (col.type === 'actions') {
          return `<td data-col-key="${col.key}" class="${stickyClass}" style="min-width:${width}px;max-width:${width}px;width:${width}px;">
            <div class="table-actions">
              <button onclick="openEditEmployee('${emp.id}')">Edit</button>
              <button data-action="toggle" data-id="${emp.id}" class="${emp[statusKey]==='active' ? 'action-danger' : ''}">
                ${emp[statusKey] === 'active' ? 'Deactivate' : 'Activate'}
              </button>
              <button data-action="delete" data-id="${emp.id}" class="action-danger">Delete</button>
            </div>
          </td>`;
        }
        const content = renderValue(value);
        const ellipsis = col.truncate ? 'cell-ellipsis' : '';
        const tooltip = col.truncate ? `title="${content}"` : '';
        return `<td data-col-key="${col.key}" class="${ellipsis} ${stickyClass}" style="min-width:${width}px;max-width:${width}px;width:${width}px;" ${tooltip}>${content || '<span class="text-muted">-</span>'}</td>`;
      }).join('');

      const details = [
        { label: 'Supervisor', value: supervisorKey ? emp[supervisorKey] : '' },
        { label: 'Join Date', value: joinDateKey ? emp[joinDateKey] : '' },
        { label: 'Department', value: departmentKey ? emp[departmentKey] : '' },
        { label: 'Emergency Contact', value: emp.emergencyContact || emp.emergency || '' },
        { label: 'Email', value: emailKey ? emp[emailKey] : '' }
      ];

      return `
        <tr class="data-row" data-row-id="${rowId}">${cells}</tr>
        <tr class="detail-row ${expanded ? '' : 'hidden'}" data-detail-for="${rowId}">
          <td colspan="${visibleColumns.length}">
            <div class="detail-grid">
              ${details.map(item => `
                <div class="detail-grid__item">
                  <p class="detail-grid__label">${escapeHtml(item.label)}</p>
                  <p class="detail-grid__value">${renderValue(item.value) || '<span class="text-muted">-</span>'}</p>
                </div>
              `).join('')}
            </div>
          </td>
        </tr>`;
    }).join('');
  };

  const renderPagination = () => {
    if (!pagination) return;
    pagination.innerHTML = `
      <div class="data-grid__pill">
        <span class="material-symbols-rounded">group</span>
        ${filtered.length} of ${normalizedEmps.length} employees
      </div>
      <div class="pagination-buttons">
        <button data-page="prev" ${employeeGridState.page === 1 ? 'disabled' : ''}>Prev</button>
        <span>Page ${employeeGridState.page} / ${totalPages}</span>
        <button data-page="next" ${employeeGridState.page === totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;
    pagination.querySelector('[data-page="prev"]')?.addEventListener('click', () => {
      if (employeeGridState.page > 1) {
        employeeGridState.page -= 1;
        loadEmployeesManage();
      }
    });
    pagination.querySelector('[data-page="next"]')?.addEventListener('click', () => {
      if (employeeGridState.page < totalPages) {
        employeeGridState.page += 1;
        loadEmployeesManage();
      }
    });
  };

  const renderColumnToggle = () => {
    const menu = document.querySelector('#columnTogglePanel .column-visibility__menu');
    if (!menu) return;
    menu.innerHTML = columns
      .filter(col => !col.alwaysVisible)
      .map(col => {
        const checked = employeeGridState.columnVisibility[col.key] !== false;
        return `<label>
          <input type="checkbox" data-column-toggle="${col.key}" ${checked ? 'checked' : ''}>
          ${escapeHtml(col.label)}
        </label>`;
      }).join('');

    menu.querySelectorAll('input[data-column-toggle]').forEach(input => {
      input.addEventListener('change', ev => {
        const key = ev.target.getAttribute('data-column-toggle');
        employeeGridState.columnVisibility[key] = ev.target.checked;
        loadEmployeesManage();
      });
    });
  };

  renderPills();
  renderHeader();
  renderBody();
  renderPagination();
  renderColumnToggle();

  const columnMenu = document.querySelector('#columnTogglePanel .column-visibility__menu');
  const columnTrigger = document.querySelector('#columnTogglePanel .column-visibility__trigger');
  if (columnTrigger && columnMenu && !columnTrigger.dataset.bound) {
    columnTrigger.dataset.bound = 'true';
    columnTrigger.addEventListener('click', () => columnMenu.classList.toggle('is-open'));
    document.addEventListener('click', e => {
      if (!columnMenu.contains(e.target) && !columnTrigger.contains(e.target)) {
        columnMenu.classList.remove('is-open');
      }
    });
  }

  const enableSorting = () => {
    head.querySelectorAll('[data-sort-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-sort-toggle');
        if (employeeGridState.sort.key === key) {
          employeeGridState.sort.direction = employeeGridState.sort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          employeeGridState.sort = { key, direction: 'asc' };
        }
        loadEmployeesManage();
      });
    });
  };

  const enableResizing = () => {
    let activeKey = null;
    let startX = 0;
    let startWidth = 0;

    const onMove = e => {
      if (!activeKey) return;
      const delta = e.pageX - startX;
      const newWidth = Math.max(120, startWidth + delta);
      employeeGridState.columnWidths[activeKey] = newWidth;
      loadEmployeesManage();
    };

    const onUp = () => {
      activeKey = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    head.querySelectorAll('[data-resize]').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        activeKey = handle.getAttribute('data-resize');
        startX = e.pageX;
        const th = handle.closest('th');
        startWidth = th ? th.offsetWidth : 160;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  };

  const renderCards = () => {
    const grid = document.getElementById('employeeCardGrid');
    if (!grid) return;
    if (employeeGridState.view !== 'cards') {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = pageRows.map(emp => {
      const statusBadge = renderStatusBadge(emp[statusKey]);
      const titleBadge = titleKey ? renderTitleBadge(emp[titleKey]) : '';
      const supervisor = supervisorKey ? renderValue(emp[supervisorKey]) : '';
      const email = emailKey ? renderValue(emp[emailKey]) : '';
      const name = renderValue(emp[nameKey]);
      return `
        <article class="employee-card hover-rise">
          <div class="employee-card__header">
            <div>
              <p class="employee-card__name">${name || 'Unnamed'}</p>
              <p class="employee-card__title">${titleKey ? renderValue(emp[titleKey]) : ''}</p>
            </div>
            ${statusBadge}
          </div>
          <div class="employee-card__meta">
            <div>
              <small>Title</small>
              <p>${titleBadge || '<span class="text-muted">-</span>'}</p>
            </div>
            <div>
              <small>Email</small>
              <p class="cell-ellipsis" title="${email}">${email || '<span class="text-muted">-</span>'}</p>
            </div>
            <div>
              <small>Supervisor</small>
              <p class="cell-ellipsis" title="${supervisor}">${supervisor || '<span class="text-muted">-</span>'}</p>
            </div>
            <div>
              <small>Type</small>
              <p><span class="badge ${normalizeInternFlag(emp[internFlagKey]) ? 'badge--warning' : 'badge--neutral'}">${normalizeInternFlag(emp[internFlagKey]) ? 'Intern' : 'Full-time'}</span></p>
            </div>
            <div>
              <small>Status</small>
              <p>${statusBadge}</p>
            </div>
          </div>
        </article>`;
    }).join('');
  };

  enableSorting();
  enableResizing();
  renderCards();

  if (employeeGridState.view === 'cards') {
    if (dataGridCard) dataGridCard.classList.add('hidden');
    if (cardsWrapper) cardsWrapper.classList.remove('hidden');
  } else {
    if (dataGridCard) dataGridCard.classList.remove('hidden');
    if (cardsWrapper) cardsWrapper.classList.add('hidden');
  }
}

// Called when edit button is clicked
window.openEditEmployee = async function(empId) {
  const emps = await getJSON('/employees');
  const emp = emps.find(e => e.id == empId);
  const fields = await getDynamicEmployeeFields();
  openEmpDrawer({title: 'Edit Employee', fields, initial: emp});
};

async function onInternFlagChange(event) {
  const checkbox = event.target.closest('.intern-flag-toggle');
  if (!checkbox) return;
  const employeeId = checkbox.dataset.employeeId;
  if (!employeeId) return;

  const isIntern = checkbox.checked;
  checkbox.disabled = true;

  try {
    const res = await apiFetch(`/employees/${employeeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ internFlag: isIntern })
    });
    if (!res.ok) {
      throw new Error(`Failed to update intern flag for employee ${employeeId}`);
    }
    showToast(`Intern flag ${isIntern ? 'enabled' : 'disabled'} for this employee.`, 'success');
  } catch (err) {
    console.error(err);
    checkbox.checked = !isIntern;
    showToast('Unable to update intern flag. Please try again.', 'error');
  } finally {
    checkbox.disabled = false;
  }
}

// Table actions (toggle, delete)
async function onEmpTableClick(e) {
  const interactive = e.target.closest('button, a, input, select, label');
  const row = e.target.closest('tr.data-row');
  if (row && !interactive) {
    const rowId = row.dataset.rowId;
    if (employeeGridState.expanded.has(rowId)) {
      employeeGridState.expanded.delete(rowId);
    } else {
      employeeGridState.expanded.add(rowId);
    }
    const detailRow = document.querySelector(`tr[data-detail-for="${rowId}"]`);
    if (detailRow) detailRow.classList.toggle('hidden');
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'toggle') {
    const emp = (await getJSON('/employees')).find(x => x.id == id);
    const status = (emp.status === 'active' ? 'inactive' : 'active');
    await apiFetch(`/employees/${id}/status`, {
      method:  'PATCH',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({ status })
    });
  }
  if (action === 'delete') {
    if (confirm('Are you sure you want to delete this employee?')) {
      await apiFetch(`/employees/${id}`, {
        method: 'DELETE'
      });
    }
  }
  await loadEmployeesManage();
  await loadEmployeesPortal();
}

// ======== LEAVE REPORT LOGIC ========
function getEmployeeLocationValue(employee) {
  if (!employee || typeof employee !== 'object') return 'Unspecified';
  const prioritizedKeys = ['Country / City', 'country/city', 'country_city', 'location', 'city'];
  for (const key of prioritizedKeys) {
    const value = employee[key];
    if (value) return String(value).trim();
  }
  const fallbackKey = Object.keys(employee).find(k => k.toLowerCase() === 'location');
  if (fallbackKey && employee[fallbackKey]) return String(employee[fallbackKey]).trim();
  return 'Unspecified';
}

function resolveInternFlagKey(employees = []) {
  const sample = employees.find(emp => emp && typeof emp === 'object');
  if (!sample) return 'internFlag';
  return Object.keys(sample).find(key => key.toLowerCase() === 'internflag') || 'internFlag';
}

function buildLocationTooltip(segment) {
  const header = `${segment.location} • ${segment.count} ${segment.count === 1 ? 'employee' : 'employees'}`;
  const body = segment.employees
    .map(emp => `${emp.name} — ${emp.statusLabel}`)
    .join('\n');
  return escapeHtml(body ? `${header}\n${body}` : header).replace(/\n/g, '&#10;');
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians)
  };
}

function buildPieSliceMarkup(cx, cy, radius, startAngle, endAngle, color, tooltip) {
  const delta = endAngle - startAngle;
  if (delta >= 360 - 0.01) {
    return `<g><circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"></circle><title>${tooltip}</title></g>`;
  }
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = delta > 180 ? 1 : 0;
  const d = [
    'M', start.x.toFixed(3), start.y.toFixed(3),
    'A', radius, radius, 0, largeArcFlag, 0, end.x.toFixed(3), end.y.toFixed(3),
    'L', cx, cy,
    'Z'
  ].join(' ');
  return `<path d="${d}" fill="${color}"><title>${tooltip}</title></path>`;
}

function buildLocationPieSvg(segments, total) {
  const cx = 100;
  const cy = 100;
  const radius = 90;
  let accumulated = 0;
  const labels = [];
  const slices = segments.map(segment => {
    const startAngle = (accumulated / total) * 360;
    const endAngle = ((accumulated + segment.count) / total) * 360;
    const midAngle = (startAngle + endAngle) / 2;
    accumulated += segment.count;
    const tooltip = buildLocationTooltip(segment);
    const valuePos = polarToCartesian(cx, cy, radius * 0.6, midAngle);
    labels.push(
      `<text class="location-pie__value" x="${valuePos.x.toFixed(1)}" y="${valuePos.y.toFixed(1)}">${segment.count}</text>`
    );
    return buildPieSliceMarkup(cx, cy, radius, startAngle, endAngle, segment.color, tooltip);
  }).join('');

  return `<svg class="location-pie__svg" viewBox="0 0 200 200" role="presentation" aria-hidden="true">${slices}${labels.join('')}</svg>`;
}

function renderLocationLegend(segments, container) {
  if (!container) return;
  container.innerHTML = segments.map(segment => {
    const internCount = segment.employees.filter(emp => emp.statusLabel === 'Intern').length;
    const fullTimeCount = segment.count - internCount;
    const meta = [
      fullTimeCount ? `${fullTimeCount} full time` : '',
      internCount ? `${internCount} intern${internCount > 1 ? 's' : ''}` : ''
    ].filter(Boolean).join(' • ');

    return `
      <div class="location-legend__item">
        <span class="location-legend__swatch" style="background:${segment.color};"></span>
        <div>
          <p class="location-legend__label">${escapeHtml(segment.location)}</p>
          <p class="location-legend__meta">${segment.count} active${meta ? ' · ' + meta : ''}</p>
        </div>
      </div>
    `;
  }).join('');
}

async function loadLocationInsights() {
  const pieContainer = document.getElementById('locationPie');
  const legendContainer = document.getElementById('locationLegend');
  const emptyState = document.getElementById('locationEmpty');
  const totalBadge = document.getElementById('locationTotalBadge');
  if (!pieContainer || !legendContainer) return;

  pieContainer.innerHTML = '<div class="location-loading">Loading…</div>';
  legendContainer.innerHTML = '';
  if (emptyState) emptyState.classList.add('hidden');

  const employees = await getJSON('/employees');
  const activeEmployees = Array.isArray(employees) ? employees.filter(isEmployeeActive) : [];
  const internFlagKey = resolveInternFlagKey(activeEmployees);

  if (totalBadge) {
    totalBadge.textContent = `${activeEmployees.length} Active`;
  }

  if (!activeEmployees.length) {
    pieContainer.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  const locationMap = new Map();
  activeEmployees.forEach(emp => {
    const location = getEmployeeLocationValue(emp) || 'Unspecified';
    const statusLabel = normalizeInternFlag(emp?.[internFlagKey]) ? 'Intern' : 'Full Time';
    const entry = locationMap.get(location) || { count: 0, employees: [] };
    entry.count += 1;
    entry.employees.push({ name: emp?.name || 'Unknown', statusLabel });
    locationMap.set(location, entry);
  });

  const segments = Array.from(locationMap.entries())
    .map(([location, details], index) => ({
      location: location || 'Unspecified',
      count: details.count,
      employees: details.employees,
      color: LOCATION_COLORS[index % LOCATION_COLORS.length]
    }))
    .sort((a, b) => b.count - a.count || a.location.localeCompare(b.location));

  pieContainer.innerHTML = buildLocationPieSvg(segments, activeEmployees.length);
  renderLocationLegend(segments, legendContainer);

  if (emptyState) emptyState.classList.add('hidden');
}

async function loadLeaveReport() {
  const data = await getJSON('/leave-report');
  const body = document.getElementById('leaveReportBody');
  if (!body) return;
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="5" style="padding:16px; font-style:italic;" class="text-muted">No leave records.</td></tr>';
    return;
  }
  body.innerHTML = data.map(r => {
    const breakdown = Object.entries(r.leaves).map(([k,v]) => `${capitalize(k)}: ${v}`).join(', ');
    return `<tr>
      <td>${r.name}</td>
      <td>${r.title || ''}</td>
      <td>${r.location || ''}</td>
      <td style="text-align:center; font-weight:600;">${r.totalDays}</td>
      <td>${breakdown}</td>
    </tr>`;
  }).join('');
}

async function loadLeaveRange(start, end) {
  const params = [];
  if (start) params.push('start=' + start);
  if (end) params.push('end=' + end);
  const query = params.length ? '?' + params.join('&') : '';
  const data = await getJSON('/leave-report' + query);
  const container = document.getElementById('leaveRangeCards');
  if (!container) return;
  if (!data.length) {
    container.innerHTML = '<div class="text-muted" style="font-style:italic;">No leaves in this period.</div>';
    return;
  }
  container.innerHTML = data.map(r => {
    const breakdown = Object.entries(r.leaves).map(([k,v]) => `${capitalize(k)}: ${v}`).join(', ');
    return `<article class="history-card">
      <div class="history-header">
        <span class="material-symbols-rounded">badge</span>
        <span>${r.name}</span>
      </div>
      <div class="text-muted"><strong>Title:</strong> ${r.title || ''}</div>
      <div class="text-muted"><strong>Location:</strong> ${r.location || ''}</div>
      <div class="text-muted"><strong>Total:</strong> ${r.totalDays}</div>
      <div class="text-muted"><strong>Breakdown:</strong> <span class="text-quiet">${breakdown}</span></div>
    </article>`;
  }).join('');
}

// ---- Drawer logic ----
function makeDynamicFieldId(prefix, key) {
  const safeKey = String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const suffix = safeKey.replace(/^-+|-+$/g, '') || Math.random().toString(36).slice(2, 8);
  return `${prefix}-${suffix}`;
}

function formatDateInputValue(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDynamicFieldsHtml(fields = [], initial = {}, prefix = 'field') {
  return fields.map(field => {
    const fieldId = makeDynamicFieldId(prefix, field.key);
    const rawValue = initial[field.key];
    const value = rawValue === null || typeof rawValue === 'undefined' ? '' : rawValue;
    const requiredAttr = field.required ? 'required' : '';
    const fieldType = typeof field.type === 'string' ? field.type.toLowerCase() : 'text';
    const labelText = field.label || field.key;
    if (fieldType === 'select') {
      const options = Array.isArray(field.options) ? field.options : [];
      const optionsMarkup = options.map(opt => {
        let optionValue = opt;
        let optionLabel = opt;
        if (opt && typeof opt === 'object') {
          optionValue = Object.prototype.hasOwnProperty.call(opt, 'value') ? opt.value : opt.label;
          optionLabel = Object.prototype.hasOwnProperty.call(opt, 'label') ? opt.label : opt.value;
        }
        optionValue = optionValue === null || typeof optionValue === 'undefined' ? '' : String(optionValue);
        optionLabel = optionLabel === null || typeof optionLabel === 'undefined' ? optionValue : String(optionLabel);
        const isSelected = String(value).toLowerCase() === optionValue.toLowerCase();
        const selected = isSelected ? 'selected' : '';
        return `<option value="${escapeHtml(optionValue)}" ${selected}>${escapeHtml(optionLabel)}</option>`;
      }).join('');
      return `
        <div class="md-field">
          <label class="md-label" for="${fieldId}">${escapeHtml(labelText || '')}</label>
          <div class="md-input-wrapper">
            <select name="${field.key}" id="${fieldId}" class="md-select" ${requiredAttr}>
              ${requiredAttr ? '' : '<option value=""></option>'}
              ${optionsMarkup}
            </select>
          </div>
        </div>
      `;
    }
    let inputType = fieldType && fieldType !== 'select' ? fieldType : 'text';
    let inputValue = value;
    if (fieldType === 'date') {
      inputType = 'date';
      inputValue = formatDateInputValue(value);
    }
    return `
      <div class="md-field">
        <label class="md-label" for="${fieldId}">${escapeHtml(labelText || '')}</label>
        <div class="md-input-wrapper">
          <input name="${field.key}" id="${fieldId}" class="md-input" type="${escapeHtml(inputType)}" value="${escapeHtml(String(inputValue))}" ${requiredAttr}>
        </div>
      </div>
    `;
  }).join('');
}

function buildEmployeePayload(formEl, fields = []) {
  const formData = new FormData(formEl);
  const data = {};
  formData.forEach((value, key) => {
    if (typeof key === 'string' && key.startsWith('_')) {
      return;
    }
    if (typeof value === 'string') {
      data[key] = value.trim();
    } else {
      data[key] = value;
    }
  });
  const payload = { ...data };
  let leaveKeys = Array.isArray(fields)
    ? fields.filter(field => field && field.isLeaveBalance).map(field => field.key)
    : [];
  if (!leaveKeys.length) {
    leaveKeys = SUPPORTED_LEAVE_TYPES.filter(key =>
      Object.prototype.hasOwnProperty.call(payload, key)
    );
  }
  if (leaveKeys.length) {
    payload.leaveBalances = {
      cycleStart: null,
      cycleEnd: null,
      lastAccrualRun: null
    };
    leaveKeys.forEach(key => {
      const raw = data[key];
      const num = Number(raw === '' || typeof raw === 'undefined' ? 0 : raw);
      payload.leaveBalances[key] = buildLeaveBalanceEntry(Number.isNaN(num) ? 0 : num, key);
      delete payload[key];
    });
  }

  const managerFieldKeys = Array.isArray(fields)
    ? fields
        .filter(field => {
          if (!field || !field.key) return false;
          const normalized = String(field.key).toLowerCase();
          return (
            normalized.includes('supervisor') ||
            normalized.includes('manager') ||
            normalized.includes('reporting') ||
            normalized.includes('appraiser') ||
            normalized.includes('appariser')
          );
        })
        .map(field => field.key)
    : [];

  const uniqueManagerKeys = Array.from(new Set(managerFieldKeys));
  if (uniqueManagerKeys.length > 1) {
    const primaryValue = uniqueManagerKeys
      .map(key => payload[key])
      .find(value => value !== undefined && value !== null && String(value).trim() !== '');
    if (primaryValue !== undefined) {
      uniqueManagerKeys.forEach(key => {
        payload[key] = primaryValue;
      });
    }
  }
  return payload;
}

function openEmpDrawer({title, fields = [], initial = {}}) {
  drawerEditId = initial.id || null;
  currentDrawerFields = Array.isArray(fields) ? fields : [];
  const titleEl = document.getElementById('empModalTitle');
  if (titleEl) titleEl.textContent = title;
  const fieldHtml = buildDynamicFieldsHtml(currentDrawerFields, initial, 'drawer');
  const fieldsEl = document.getElementById('empModalFields');
  if (fieldsEl) fieldsEl.innerHTML = fieldHtml;
  const formEl = document.getElementById('empModalForm');
  if (formEl) {
    formEl.reset();
    formEl.scrollTop = 0;
  }
  const modal = document.getElementById('empModal');
  if (modal) {
    modal.classList.remove('hidden');
    if (empModalKeydownHandler) {
      document.removeEventListener('keydown', empModalKeydownHandler);
    }
    empModalKeydownHandler = ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeEmpDrawer();
      }
    };
    document.addEventListener('keydown', empModalKeydownHandler);
    setTimeout(() => {
      const focusTarget = modal.querySelector('#empModalFields input, #empModalFields select, #empModalFields textarea');
      if (focusTarget) focusTarget.focus();
    }, 50);
  }
}
function closeEmpDrawer() {
  const modal = document.getElementById('empModal');
  if (modal) modal.classList.add('hidden');
  if (empModalKeydownHandler) {
    document.removeEventListener('keydown', empModalKeydownHandler);
    empModalKeydownHandler = null;
  }
  const formEl = document.getElementById('empModalForm');
  if (formEl) formEl.reset();
  const fieldsEl = document.getElementById('empModalFields');
  if (fieldsEl) fieldsEl.innerHTML = '';
  currentDrawerFields = [];
  drawerEditId = null;
}

// Drawer submit
async function onEmpDrawerSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const payload = buildEmployeePayload(form, currentDrawerFields);
  let url, method;
  if (drawerEditId) {
    url = `/employees/${drawerEditId}`; method = 'PUT';
  } else {
    url = '/employees'; method = 'POST';
  }
  await apiFetch(url, {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  closeEmpDrawer();
  await loadEmployeesManage();
  await loadEmployeesPortal();
}

async function getDynamicEmployeeFields() {
  const emps = await getJSON('/employees');
  let sample = emps[0] || {};
  let leaveFields = [];
  if (sample.leaveBalances) {
    SUPPORTED_LEAVE_TYPES.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(sample.leaveBalances, key)) {
        leaveFields.push({
          key,
          label: key.charAt(0).toUpperCase() + key.slice(1) + ' Leave',
          type: 'number',
          required: false,
          isLeaveBalance: true
        });
      }
    });
  }
  const managerOptions = await fetchManagerOptions();
  const managerSelectOptions = Array.isArray(managerOptions)
    ? managerOptions
        .map(opt => {
          const labelParts = [];
          if (opt?.name) labelParts.push(opt.name);
          if (opt?.email) labelParts.push(opt.email);
          const label = labelParts.length ? labelParts.join(' • ') : 'Manager';
          const value = opt?.email || opt?.employeeId || opt?.name || '';
          return value ? { value, label } : null;
        })
        .filter(Boolean)
    : [];
  const requiredFields = ['name', 'title', 'country/city'];
  let normalFields = Object.keys(sample)
    .filter(k => k !== 'id' && k !== 'leaveBalances' && !(typeof k === 'string' && k.startsWith('_')))
    .map(k=>{
      let isRequired = requiredFields.includes(k.toLowerCase());
      const keyLower = k.toLowerCase();
      const baseLabel = k.charAt(0).toUpperCase()+k.slice(1);
      if (
        keyLower.includes('supervisor') ||
        keyLower.includes('manager') ||
        keyLower.includes('reporting') ||
        keyLower.includes('appraiser') ||
        keyLower.includes('appariser')
      ) {
        if (managerSelectOptions.length) {
          return {
            key: k,
            label: 'Supervisor / Appraiser',
            type: 'select',
            options: managerSelectOptions,
            required: isRequired
          };
        }
        return { key: k, label: 'Supervisor / Appraiser', type: 'text', required: isRequired };
      }
      if (keyLower === 'status') {
        const baseOptions = ['Active', 'Inactive'];
        const sampleValue = sample[k];
        if (sampleValue && typeof sampleValue === 'string') {
          const hasValue = baseOptions.some(opt => opt.toLowerCase() === sampleValue.toLowerCase());
          if (!hasValue) {
            baseOptions.unshift(sampleValue);
          }
        }
        return {key:k,label:'Status',type:'select',options:baseOptions,required:isRequired};
      }
      if (keyLower === 'active') {
        const activeOptions = ['Yes', 'No'];
        const sampleValue = sample[k];
        if (sampleValue && typeof sampleValue === 'string') {
          const hasValue = activeOptions.some(opt => opt.toLowerCase() === sampleValue.toLowerCase());
          if (!hasValue) {
            activeOptions.unshift(sampleValue);
          }
        }
        return {key:k,label:'Active',type:'select',options:activeOptions,required:isRequired};
      }
      if (
        keyLower.includes('date') ||
        keyLower.includes('dob') ||
        keyLower.includes('birth') ||
        keyLower.includes('join') ||
        keyLower.includes('hire')
      ) {
        return {key:k,label:baseLabel,type:'date',required:isRequired};
      }
      return {key:k,label:baseLabel,type:'text',required:isRequired};
    });
  return [...normalFields, ...leaveFields];
}

function onEmpCancel() {
  editId = null;
  document.getElementById('formLegend').textContent = 'Add New Employee';
  document.getElementById('empForm').reset();
}
async function onEmpFormSubmit(ev) {
  ev.preventDefault();
  const payload = {
    name: document.getElementById('empName').value,
    status: document.getElementById('empStatus').value,
    leaveBalances: {
      annual: buildLeaveBalanceEntry(+document.getElementById('empAnnual').value, 'annual'),
      casual: buildLeaveBalanceEntry(+document.getElementById('empCasual').value, 'casual'),
      medical: buildLeaveBalanceEntry(+document.getElementById('empMedical').value, 'medical'),
      cycleStart: null,
      cycleEnd: null,
      lastAccrualRun: null
    }
  };
  const url    = editId ? `/employees/${editId}` : '/employees';
  const method = editId ? 'PUT' : 'POST';
  await apiFetch(url, {
    method,
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  editId = null;
  document.getElementById('formLegend').textContent = 'Add New Employee';
  document.getElementById('empForm').reset();
  await loadEmployeesManage();
  await loadEmployeesPortal();
}

// -------- Calendar View ---------
async function loadLeaveCalendar() {
  const monthStart = new Date(calendarCurrent.getFullYear(), calendarCurrent.getMonth(), 1);
  const monthEnd   = new Date(calendarCurrent.getFullYear(), calendarCurrent.getMonth() + 1, 0);
  const startStr   = monthStart.toLocaleDateString('en-CA');
  const endStr     = monthEnd.toLocaleDateString('en-CA');
  const data = await getJSON(`/leave-calendar?start=${startStr}&end=${endStr}`);
  const map = {};
  data.forEach(d => { map[d.date] = d.entries; });
  let holidaysForCalendar = [];
  try {
    holidaysForCalendar = await fetchHolidays();
  } catch (err) {
    console.error('Failed to fetch holidays for calendar', err);
    holidaysForCalendar = Array.isArray(companyHolidays) ? companyHolidays : [];
  }
  const holidayMap = {};
  (Array.isArray(holidaysForCalendar) ? holidaysForCalendar : []).forEach(holiday => {
    if (!holiday || !holiday.date) return;
    const iso = String(holiday.date);
    if (!holidayMap[iso]) holidayMap[iso] = [];
    holidayMap[iso].push(holiday);
  });
  const grid = document.getElementById('leaveCalendar');
  if (!grid) return;
  document.getElementById('calMonth').textContent = monthStart.toLocaleString('default', {month:'long', year:'numeric'});
  grid.innerHTML = '';
  const firstDay = new Date(monthStart);
  const offset = firstDay.getDay();
  for (let i = 0; i < offset; i++) {
    grid.innerHTML += '<div class="calendar-empty"></div>';
  }
  const today = new Date();
  today.setHours(0,0,0,0);
  for (let d=1; d<=monthEnd.getDate(); d++) {
    const date   = new Date(monthStart.getFullYear(), monthStart.getMonth(), d);
    const dayRef = new Date(date);
    dayRef.setHours(0,0,0,0);
    const dateStr = date.toLocaleDateString('en-CA');
    const entries = map[dateStr] || [];
    const holidayEntries = holidayMap[dateStr] || [];
    const future  = dayRef > today;
    const isToday = dayRef.getTime() === today.getTime();
    const classes = [];
    if ([1,2,3,4,5].includes(date.getDay())) {
      classes.push('weekday');
    }
    if (future) classes.push('future');
    if (isToday) classes.push('calendar-today');
    const contentParts = [`<div class="calendar-date">${d}</div>`];
    const titleParts = [];
    if (holidayEntries.length) {
      classes.push('calendar-holiday');
      const holidayNames = Array.from(new Set(holidayEntries.map(h => {
        const name = h?.name ? String(h.name).trim() : '';
        return name || 'Holiday';
      })));
      if (!holidayNames.length) holidayNames.push('Holiday');
      holidayNames.forEach(name => titleParts.push(`Holiday - ${name}`));
      const labelText = holidayNames.join(', ');
      const safeLabel = escapeHtml(labelText);
      contentParts.push(`<div class="calendar-holiday-label"><span class="material-symbols-rounded">celebration</span><span>${safeLabel}</span></div>`);
    }
    if (entries.length) {
      const namesMarkup = entries.map(e => {
        const rawType = (e.type || '').toString();
        const typeLabel = capitalize(rawType);
        const typeKey = rawType.replace(/[^a-z0-9]/gi, '').toLowerCase();
        const typeClass = typeKey ? `calendar-type--${typeKey}` : '';
        if (typeLabel) {
          titleParts.push(`${e.name} - ${typeLabel}`);
        } else {
          titleParts.push(e.name);
        }
        const typeMarkup = typeLabel ? `<span class="calendar-type ${typeClass}">${typeLabel}</span>` : '';
        const entryTitle = typeLabel ? `${e.name} • ${typeLabel}` : e.name;
        return `<div class="calendar-name" title="${entryTitle}"><span class="calendar-employee">${e.name}</span>${typeMarkup}</div>`;
      }).join('');
      contentParts.push(`<div class="calendar-names">${namesMarkup}</div>`);
    }
    const title = titleParts.join('\n');
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const classAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
    grid.innerHTML += `<div${classAttr}${titleAttr}>${contentParts.join('')}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('calPrev');
  const next = document.getElementById('calNext');
  if (prev && next) {
    prev.onclick = () => { calendarCurrent.setMonth(calendarCurrent.getMonth()-1); loadLeaveCalendar(); };
    next.onclick = () => { calendarCurrent.setMonth(calendarCurrent.getMonth()+1); loadLeaveCalendar(); };
  }
});
