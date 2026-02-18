const jobListEl = document.getElementById('job-list');
const jobDetailEl = document.getElementById('job-detail');
const careersBrandLogoEl = document.getElementById('careersBrandLogo');
const DEFAULT_ORGANIZATION_LOGO_URL = '/logo.png';

const careerCustomHeaderEl = document.getElementById('careerCustomHeader');
const careerCustomUpdatesEl = document.getElementById('careerCustomUpdates');
const careerCustomContentEl = document.getElementById('careerCustomContent');
const careerCustomFooterEl = document.getElementById('careerCustomFooter');

function normalizeHeaderBannerColor(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : '';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const error = new Error('Request failed');
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function loadOrganizationBranding() {
  if (!careersBrandLogoEl) return;

  try {
    const settings = await fetchJson('/public/settings/organization');
    const logoUrl = typeof settings?.logoUrl === 'string' && settings.logoUrl.trim()
      ? settings.logoUrl.trim()
      : DEFAULT_ORGANIZATION_LOGO_URL;
    careersBrandLogoEl.src = logoUrl;
  } catch (_error) {
    careersBrandLogoEl.src = DEFAULT_ORGANIZATION_LOGO_URL;
  }
}


function applyCustomCareerSection(element, html) {
  if (!element || typeof html !== 'string') return;
  const trimmed = html.trim();
  if (!trimmed) return;
  element.innerHTML = trimmed;
}

async function loadCareerPageBuilderSettings() {
  try {
    const settings = await fetchJson('/public/settings/career-page');
    const headerBackgroundColor = normalizeHeaderBannerColor(settings?.headerBackgroundColor) || '#1e3a8a';
    if (careerCustomHeaderEl) careerCustomHeaderEl.style.backgroundColor = headerBackgroundColor;
    applyCustomCareerSection(careerCustomHeaderEl, settings?.header);
    applyCustomCareerSection(careerCustomUpdatesEl, settings?.updates);
    applyCustomCareerSection(careerCustomContentEl, settings?.content);
    applyCustomCareerSection(careerCustomFooterEl, settings?.footer);
  } catch (_error) {
    // Keep default careers layout when custom builder settings are unavailable.
  }
}

function renderPositions(positions = []) {
  if (!jobListEl) return;
  if (!Array.isArray(positions) || !positions.length) {
    jobListEl.innerHTML = '<p class="text-gray-600 text-center">No openings are published right now. Please check back soon.</p>';
    return;
  }

  jobListEl.innerHTML = positions
    .map(position => {
      const metaParts = [];
      if (position.department) metaParts.push(position.department);
      if (position.location) metaParts.push(position.location);
      const meta = metaParts.length ? metaParts.join(' • ') : 'Brillar';
      return `
        <div class="bg-white rounded-xl shadow p-5 flex items-start sm:items-center justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold text-gray-900">${position.title}</h2>
            <p class="text-sm text-gray-500 mt-1">${meta}</p>
            ${position.employmentType ? `<p class="text-xs text-gray-400 mt-1">${position.employmentType}</p>` : ''}
          </div>
          <div class="flex items-center gap-3">
            <button class="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-semibold hover:bg-blue-700 focus:outline-none" data-action="view" data-id="${position._id}">View &amp; Apply</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderDetail(position) {
  if (!jobDetailEl) return;
  const description = position.description || 'No description provided.';
  const meta = [position.department, position.location].filter(Boolean).join(' · ');
  jobDetailEl.innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-6 flex-wrap">
      <div>
        <h3 class="text-3xl font-bold text-gray-900">${position.title}</h3>
        <div class="text-gray-600 mt-1">${meta || 'Brillar'}</div>
        ${position.employmentType ? `<div class="text-sm text-gray-500">${position.employmentType}</div>` : ''}
      </div>
      <div class="text-sm text-gray-500">${new Date(position.createdAt || Date.now()).toLocaleDateString()}</div>
    </div>
    <div class="space-y-6">
      <div>
        <h4 class="text-lg font-semibold mb-2">Job Description</h4>
        <p class="text-gray-700 whitespace-pre-line leading-relaxed">${description}</p>
      </div>
      <div class="border-t pt-6">
        <h4 class="text-lg font-semibold mb-4">Apply for this role</h4>
        <form id="apply-form" class="space-y-4 mt-4" data-id="${position._id}">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
            <input name="fullName" required class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Your full name" />
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Email *</label>
              <input type="email" name="email" required class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="you@example.com" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Phone *</label>
              <input type="tel" name="phone" required class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="(+63) 900 000 0000" />
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">CV (PDF, DOC, DOCX) *</label>
            <input type="file" name="cv" accept=".pdf,.doc,.docx" required class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Cover Letter</label>
            <textarea name="coverLetterText" rows="4" class="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Optional"></textarea>
          </div>
          <div id="apply-message" class="text-sm"></div>
          <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-semibold hover:bg-blue-700 focus:outline-none">Submit Application</button>
        </form>
      </div>
    </div>
  `;
}

async function loadPositions() {
  try {
    const positions = await fetchJson('/api/public/positions');
    renderPositions(positions);
  } catch (error) {
    if (jobListEl) {
      jobListEl.innerHTML = '<p class="text-red-600 text-center">Unable to load positions right now. Please try again later.</p>';
    }
  }
}

async function loadPositionDetail(id) {
  if (!jobDetailEl) return;
  jobDetailEl.innerHTML = '<p class="text-gray-600">Loading position...</p>';
  try {
    const position = await fetchJson(`/api/public/positions/${id}`);
    renderDetail(position);
  } catch (error) {
    jobDetailEl.innerHTML = '<p class="text-red-600">Unable to load this position.</p>';
  }
}

async function submitApplication(event) {
  event.preventDefault();
  const form = event.target;
  const positionId = form.getAttribute('data-id');
  if (!positionId) return;

  const messageEl = document.getElementById('apply-message');
  if (messageEl) {
    messageEl.textContent = '';
    messageEl.className = 'text-sm';
  }

  const formData = new FormData(form);

  try {
    const res = await fetch(`/api/public/positions/${positionId}/apply`, {
      method: 'POST',
      body: formData
    });
    if (!res.ok) throw new Error('failed');
    await res.json();
    if (messageEl) {
      messageEl.textContent = 'Application received! Our team will be in touch soon.';
      messageEl.className = 'text-sm text-green-600';
    }
    form.reset();
  } catch (error) {
    if (messageEl) {
      messageEl.textContent = 'Could not submit application. Please check your details and try again.';
      messageEl.className = 'text-sm text-red-600';
    }
  }
}

if (jobListEl) {
  jobListEl.addEventListener('click', event => {
    const button = event.target.closest('button[data-action="view"]');
    if (!button) return;
    const id = button.getAttribute('data-id');
    loadPositionDetail(id);
  });
}

if (jobDetailEl) {
  jobDetailEl.addEventListener('submit', event => {
    if (event.target && event.target.id === 'apply-form') {
      submitApplication(event);
    }
  });
}

const openPositionsButton = document.getElementById('view-open-positions');
if (openPositionsButton) {
  openPositionsButton.addEventListener('click', event => {
    event.preventDefault();
    const section = document.getElementById('open-positions');
    if (section) {
      section.scrollIntoView({ behavior: 'smooth' });
    }
  });
}

loadOrganizationBranding();
loadCareerPageBuilderSettings();
loadPositions();
