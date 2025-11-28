(function () {
  const root = document.getElementById('interview-root');
  const token = window.location.pathname.split('/').pop();
  const draftKey = `ai_interview_${token}`;

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

    const greeting = `Hi ${session.candidateName || 'there'}, welcome to your written interview for ${
      session.positionTitle || 'this role'
    } at Brillar.`;

    root.innerHTML = `
      <div class="space-y-8">
        <div class="space-y-2">
          <h2 class="text-2xl font-semibold text-gray-900">${session.templateTitle || 'AI Interview'}</h2>
          <p class="text-gray-600">${greeting}</p>
          <p class="text-gray-600">Please answer all questions below. Your responses will only be saved when you click "Submit Interview".</p>
        </div>

        <div id="message" class="hidden rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm"></div>

        <form id="interview-form" class="space-y-6">
          ${questions
            .map(
              q => `
                <div class="space-y-2">
                  <label class="block text-sm font-medium text-gray-900" for="q_${q.id}">${q.text}</label>
                  <textarea
                    id="q_${q.id}"
                    data-question-id="${q.id}"
                    class="w-full rounded-md border border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 p-3"
                    rows="4"
                  >${(draft[q.id] || '').replace(/</g, '&lt;')}</textarea>
                </div>
              `
            )
            .join('')}
          <div class="pt-2">
            <button type="submit" class="inline-flex items-center justify-center px-5 py-3 bg-indigo-600 text-white font-semibold rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2">
              Submit Interview
            </button>
          </div>
        </form>
      </div>
    `;

    const form = document.getElementById('interview-form');
    const messageBox = document.getElementById('message');

    form.addEventListener('input', event => {
      if (event.target instanceof HTMLTextAreaElement) {
        const questionId = event.target.dataset.questionId;
        const value = event.target.value;
        const updatedDraft = { ...getDraft(), [questionId]: value };
        saveDraft(updatedDraft);
      }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      messageBox.classList.add('hidden');
      messageBox.textContent = '';

      const answers = questions.map(question => {
        const textarea = document.querySelector(`textarea[data-question-id="${question.id}"]`);
        const answerText = (textarea?.value || '').trim();
        return {
          questionId: question.id,
          answerText
        };
      });

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
  }

  async function init() {
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
