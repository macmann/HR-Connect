(function () {
  const root = document.getElementById('interview-root');
  const token = window.location.pathname.split('/').pop();
  const draftKey = `ai_interview_${token}`;

  const DEFAULT_ORGANIZATION_NAME = 'HR Connect';
  const DEFAULT_ORGANIZATION_LOGO_URL = '/logo.png';

  async function applyOrganizationBranding() {
    try {
      const response = await fetch('/public/settings/organization');
      if (!response.ok) return;
      const settings = await response.json();
      const organizationName = typeof settings?.portalName === 'string' && settings.portalName.trim()
        ? settings.portalName.trim()
        : DEFAULT_ORGANIZATION_NAME;
      const logoUrl = typeof settings?.logoUrl === 'string' && settings.logoUrl.trim()
        ? settings.logoUrl.trim()
        : DEFAULT_ORGANIZATION_LOGO_URL;

      document.title = `${organizationName} AI Interview`;
      const logoEl = document.getElementById('careersBrandLogo');
      if (logoEl) logoEl.src = logoUrl;
      const portalNameEl = document.getElementById('organizationPortalName');
      if (portalNameEl) portalNameEl.textContent = organizationName;
      const taglineEl = document.getElementById('interviewBrandTagline');
      if (taglineEl) taglineEl.textContent = `${organizationName} AI Interview`;
      const guidedByEl = document.getElementById('interviewBrandGuidedBy');
      if (guidedByEl) guidedByEl.textContent = `Guided by ${organizationName}`;
      const footerEl = document.getElementById('interviewFooterText');
      if (footerEl) footerEl.textContent = `© ${organizationName}. All rights reserved.`;
    } catch (err) {
      // Fall back to defaults if settings are unavailable
    }
  }

  function renderMessage(title, description) {
    root.innerHTML = `
      <div class="space-y-3 text-center">
        <h2 class="text-xl font-semibold text-gray-900">${title}</h2>
        <p class="text-gray-600">${description || ''}</p>
      </div>
    `;
  }

  function getDraft() {
    if (!token) return {};
    try {
      const value = localStorage.getItem(draftKey);
      return value ? JSON.parse(value) : {};
    } catch (err) {
      return {};
    }
  }

  function saveDraft(data) {
    if (!token) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify(data));
    } catch (err) {
      // Ignore storage errors
    }
  }

  function clearDraft() {
    if (!token) return;
    try {
      localStorage.removeItem(draftKey);
    } catch (err) {
      // Ignore storage errors
    }
  }

  async function fetchSession() {
    try {
      const response = await fetch(`/api/public/ai-interview/${encodeURIComponent(token)}`);
      if (response.status === 404) {
        renderMessage(
          'Invalid or expired link',
          'This interview link is invalid or has expired. Please contact your recruiter for a new link.'
        );
        return null;
      }

      if (!response.ok) {
        renderMessage('Unable to load interview', 'Please refresh the page or try again later.');
        return null;
      }

      return await response.json();
    } catch (err) {
      console.error('Failed to fetch interview session', err);
      renderMessage('Network error', 'Please check your connection and try again.');
      return null;
    }
  }

  function renderForm(session) {
    const draft = getDraft();
    const questions = Array.isArray(session.questions) ? session.questions : [];
    if (!questions.length) {
      renderMessage('No interview questions available', 'Please contact your recruiter for an updated link.');
      return;
    }
    let currentIndex = 0;

    const greeting = `Hi ${session.candidateName || 'there'}, welcome to your written interview for ${
      session.positionTitle || 'this role'
    } at ${document.getElementById('organizationPortalName')?.textContent || DEFAULT_ORGANIZATION_NAME}.`;

    root.innerHTML = `
      <div class="space-y-8">
        <div class="space-y-2">
          <h2 class="text-2xl sm:text-3xl font-semibold text-gray-900">${session.templateTitle || 'AI Interview'}</h2>
          <p class="text-gray-600">${greeting}</p>
          <p class="text-gray-600">Answer each question one at a time. Your responses are saved locally as drafts until you submit.</p>
        </div>

        <div id="message" class="hidden rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm"></div>

        <div class="bg-gradient-to-r from-white via-white to-blue-50 border border-gray-100 rounded-2xl shadow-md p-6 sm:p-8 space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p id="progress" class="inline-flex items-center px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-semibold">Question 1 of ${questions.length}</p>
            <p class="text-sm text-gray-600">You can go back anytime before submitting.</p>
          </div>

          <form id="interview-form" class="space-y-5">
            <div class="space-y-3">
              <h3 id="question-text" class="text-lg sm:text-xl font-semibold text-gray-900"></h3>
              <p class="text-sm text-gray-600">Write your response in the box below. Your draft will be saved as you type.</p>
              <label class="text-sm font-semibold text-gray-900" for="question-answer">Your Answer</label>
              <textarea
                id="question-answer"
                class="w-full border border-gray-300 rounded-lg p-4 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                rows="8"
                aria-describedby="progress"
              ></textarea>
            </div>

            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
              <button type="button" id="prev-btn" class="inline-flex items-center justify-center px-5 py-3 bg-white text-gray-800 font-semibold rounded-md border border-gray-300 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed">Previous</button>
              <div class="flex gap-3 w-full sm:w-auto justify-end">
                <button type="button" id="next-btn" class="inline-flex items-center justify-center px-5 py-3 bg-white text-gray-800 font-semibold rounded-md border border-gray-300 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">Save & Next</button>
                <button type="submit" id="submit-btn" class="inline-flex items-center justify-center px-5 py-3 bg-blue-600 text-white font-semibold rounded-md shadow hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">Submit Interview</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `;

    const form = document.getElementById('interview-form');
    const messageBox = document.getElementById('message');
    const progress = document.getElementById('progress');
    const questionText = document.getElementById('question-text');
    const answerField = document.getElementById('question-answer');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const submitBtn = document.getElementById('submit-btn');

    function syncButtons() {
      prevBtn.disabled = currentIndex === 0;
      const onLastQuestion = currentIndex === questions.length - 1;
      nextBtn.classList.toggle('hidden', onLastQuestion);
      submitBtn.classList.toggle('hidden', !onLastQuestion);
    }

    function loadQuestion() {
      const question = questions[currentIndex];
      if (!question) return;

      messageBox.classList.add('hidden');
      messageBox.textContent = '';
      progress.textContent = `Question ${currentIndex + 1} of ${questions.length}`;
      questionText.textContent = question.text;
      answerField.value = draft[question.id] || '';
      syncButtons();
      answerField.focus();
    }

    function persistCurrentAnswer() {
      const question = questions[currentIndex];
      if (!question) return;
      draft[question.id] = answerField.value;
      saveDraft(draft);
    }

    answerField.addEventListener('input', persistCurrentAnswer);

    prevBtn.addEventListener('click', () => {
      persistCurrentAnswer();
      if (currentIndex > 0) {
        currentIndex -= 1;
        loadQuestion();
      }
    });

    nextBtn.addEventListener('click', () => {
      persistCurrentAnswer();
      if (currentIndex < questions.length - 1) {
        currentIndex += 1;
        loadQuestion();
      }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      persistCurrentAnswer();
      messageBox.classList.add('hidden');
      messageBox.textContent = '';

      const answers = questions.map(question => ({
        questionId: question.id,
        answerText: (draft[question.id] || '').trim()
      }));

      const missing = answers.some(answer => !answer.answerText);
      if (missing) {
        messageBox.textContent = 'Please answer all questions before submitting.';
        messageBox.classList.remove('hidden');
        return;
      }

      try {
        const response = await fetch(`/api/public/ai-interview/${encodeURIComponent(token)}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers })
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          const message =
            error.error === 'session_already_completed'
              ? 'This interview has already been submitted.'
              : 'Unable to submit your interview. Please try again.';
          messageBox.textContent = message;
          messageBox.classList.remove('hidden');
          return;
        }

        clearDraft();
        renderMessage('Thank you!', 'Your interview responses have been submitted.');
      } catch (err) {
        console.error('Failed to submit interview', err);
        messageBox.textContent = 'Network error while submitting. Please try again.';
        messageBox.classList.remove('hidden');
      }
    });

    loadQuestion();
  }

  async function init() {
    await applyOrganizationBranding();
    if (!token) {
      renderMessage('Invalid link', 'This interview link appears to be missing.');
      return;
    }

    const session = await fetchSession();
    if (!session) return;

    if (session.status === 'completed') {
      renderMessage(
        'Interview already submitted',
        'Our team has already received your responses. Thank you!'
      );
      return;
    }

    renderForm(session);
  }

  init();
})();
