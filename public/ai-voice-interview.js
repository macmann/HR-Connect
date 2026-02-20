(function () {
  const root = document.getElementById('appRoot');
  const remoteAudio = document.getElementById('remoteAudio');
  const token = window.location.pathname.split('/').pop();

  const state = {
    metadata: null,
    stream: null,
    pc: null,
    channel: null,
    connected: false,
    muted: false,
    transcriptVisible: false,
    status: 'idle',
    transcriptTurns: [],
    askedQuestionIds: new Set(),
    completeSent: false,
    disconnectTimer: null,
    interviewTimer: null
  };

  function disableInterviewControls() {
    ['startBtn', 'muteBtn', 'repeatBtn', 'endBtn'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.disabled = true;
    });
  }

  function clearInterviewTimer() {
    if (state.interviewTimer) {
      clearTimeout(state.interviewTimer);
      state.interviewTimer = null;
    }
  }

  function startInterviewTimer() {
    if (state.interviewTimer) return;
    const maxDurationSec = Number(state.metadata?.realtimeConfig?.maxDurationSec);
    if (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0) return;

    state.interviewTimer = setTimeout(async () => {
      disableInterviewControls();
      setStatus('completed', 'Interview time limit reached. Submitting your session...');
      await completeInterview('timeout');
      teardownConnection();
      setStatus('completed', 'Interview ended due to time limit. Thank you.');
    }, maxDurationSec * 1000);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setStatus(status, detail) {
    state.status = status;
    const statusEl = document.getElementById('statusText');
    const detailEl = document.getElementById('statusDetail');
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = 'text-sm font-semibold ' + (
        status === 'speaking' ? 'text-violet-700' : status === 'listening' ? 'text-emerald-700' : 'text-blue-700'
      );
    }
    if (detailEl) {
      detailEl.textContent = detail || '';
    }
  }

  function renderTranscript() {
    const panel = document.getElementById('transcriptPanel');
    if (!panel) return;

    if (!state.transcriptVisible) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    panel.innerHTML = state.transcriptTurns.length
      ? state.transcriptTurns
          .map(turn => `
            <div class="border border-slate-200 rounded-lg p-3">
              <p class="text-xs uppercase tracking-wide text-slate-500">${escapeHtml(turn.role || 'candidate')}</p>
              <p class="text-sm text-slate-800 mt-1">${escapeHtml(turn.text)}</p>
            </div>
          `)
          .join('')
      : '<p class="text-sm text-slate-500">Transcript will appear here once speech is captured.</p>';
  }

  function renderApp() {
    const candidateName = state.metadata?.candidateName || 'Candidate';
    const positionTitle = state.metadata?.positionTitle || 'this role';
    root.innerHTML = `
      <div class="space-y-6">
        <div>
          <h2 class="text-2xl font-semibold">Welcome, ${escapeHtml(candidateName)}</h2>
          <p class="text-slate-600 mt-2">You are interviewing for <span class="font-medium">${escapeHtml(positionTitle)}</span>.</p>
        </div>

        <div class="rounded-xl border border-blue-100 bg-blue-50 p-4 space-y-1">
          <p class="text-xs uppercase tracking-wide text-blue-700">Interview state</p>
          <p id="statusText" class="text-sm font-semibold text-blue-700">idle</p>
          <p id="statusDetail" class="text-sm text-blue-800">Grant microphone permission, then click start.</p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button id="startBtn" class="px-4 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700">Enable mic & start</button>
          <button id="muteBtn" class="px-4 py-3 rounded-lg bg-slate-100 text-slate-800 font-semibold border border-slate-300 disabled:opacity-50" disabled>Mute</button>
          <button id="repeatBtn" class="px-4 py-3 rounded-lg bg-slate-100 text-slate-800 font-semibold border border-slate-300 disabled:opacity-50" disabled>Repeat question</button>
          <button id="toggleTranscriptBtn" class="px-4 py-3 rounded-lg bg-slate-100 text-slate-800 font-semibold border border-slate-300">Show transcript</button>
          <button id="endBtn" class="px-4 py-3 rounded-lg bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-50" disabled>End interview</button>
          <a href="/ai-interview/${encodeURIComponent(token)}" class="px-4 py-3 rounded-lg bg-white text-slate-800 font-semibold border border-slate-300 text-center">Switch to text</a>
        </div>

        <div id="transcriptPanel" class="hidden rounded-xl border border-slate-200 p-4 space-y-3"></div>
      </div>
    `;

    document.getElementById('startBtn').addEventListener('click', startVoiceInterview);
    document.getElementById('muteBtn').addEventListener('click', toggleMute);
    document.getElementById('repeatBtn').addEventListener('click', repeatQuestion);
    document.getElementById('toggleTranscriptBtn').addEventListener('click', () => {
      state.transcriptVisible = !state.transcriptVisible;
      document.getElementById('toggleTranscriptBtn').textContent = state.transcriptVisible
        ? 'Hide transcript'
        : 'Show transcript';
      renderTranscript();
    });
    document.getElementById('endBtn').addEventListener('click', async () => {
      await completeInterview('manual_end');
      teardownConnection();
      setStatus('completed', 'Interview ended. Thank you.');
    });

    renderTranscript();
  }

  async function fetchMetadata() {
    const response = await fetch(`/api/public/ai-voice-interview/${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error('failed_to_fetch_metadata');
    return response.json();
  }

  async function requestRealtimeSession() {
    const response = await fetch(`/api/public/ai-voice-interview/${encodeURIComponent(token)}/realtime-session`, {
      method: 'POST'
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const err = new Error('failed_to_fetch_realtime_session');
      err.status = response.status;
      err.apiError = payload?.error || null;
      throw err;
    }
    return response.json();
  }

  async function sendTranscriptChunk(turn) {
    if (!turn?.text) return;
    const response = await fetch(`/api/public/ai-voice-interview/${encodeURIComponent(token)}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns: [turn] })
    });
    return response.ok ? response.json() : null;
  }

  function buildInterviewerInstructions() {
    const positionTitle = state.metadata?.positionTitle || 'the role';
    const questions = Array.isArray(state.metadata?.interviewQuestions)
      ? state.metadata.interviewQuestions.filter(q => q && typeof q.text === 'string' && q.text.trim())
      : [];

    const questionList = questions.length
      ? questions
          .map((question, index) => `${index + 1}. ${question.text.trim()}`)
          .join('\n')
      : '1. Ask a role-relevant question about the candidate experience and skills.';

    return [
      `You are conducting a structured AI interview for ${positionTitle}.`,
      'Immediately begin the interview by asking the first question from the provided question list.',
      'Do not start with small talk like "What\'s new today?" or unrelated chit-chat.',
      'Ask one interview question at a time. After each candidate answer, ask the next question from the list.',
      'Each question is based on job-description requirements and CV-aligned screening prompts. Keep wording close to the provided list.',
      'If the candidate asks to repeat, restate only the current question once.',
      'When all questions are exhausted, thank the candidate and say the interview is complete.',
      '',
      'Question list:',
      questionList
    ].join('\n');
  }

  function askInterviewQuestion(questionText) {
    const text = typeof questionText === 'string' ? questionText.trim() : '';
    if (!state.channel || state.channel.readyState !== 'open' || !text) return;

    state.channel.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          instructions: `Ask this exact interview question now, then pause for the candidate response: ${text}`
        }
      })
    );
  }

  async function completeInterview(reason) {
    if (state.completeSent) return;
    state.completeSent = true;

    try {
      const response = await fetch(`/api/public/ai-voice-interview/${encodeURIComponent(token)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'unknown' })
      });

      const payload = await response.json().catch(() => ({}));
      if (payload?.status === 'completed_due_to_timeout') {
        disableInterviewControls();
        setStatus('completed', 'Interview ended due to time limit. Thank you.');
      }
      return payload;
    } catch (err) {
      console.error('Failed to mark interview complete', err);
      return null;
    }
  }

  async function startVoiceInterview() {
    const startBtn = document.getElementById('startBtn');
    const muteBtn = document.getElementById('muteBtn');
    const repeatBtn = document.getElementById('repeatBtn');
    const endBtn = document.getElementById('endBtn');

    try {
      startBtn.disabled = true;
      setStatus('connecting', 'Requesting microphone permission...');
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatus('connecting', 'Creating secure voice session...');
      const realtime = await requestRealtimeSession();
      const transport = realtime?.transport || 'webrtc';
      if (transport !== 'webrtc') {
        const unsupportedTransportError = new Error(`unsupported_transport:${transport}`);
        unsupportedTransportError.code = 'unsupported_transport';
        unsupportedTransportError.transport = transport;
        throw unsupportedTransportError;
      }

      const ephemeralKey = realtime?.client_secret?.value;
      const model = realtime?.session?.model || state.metadata?.realtimeConfig?.model || 'gpt-4o-realtime-preview-2024-12-17';
      const iceServers = Array.isArray(realtime?.iceServers) ? realtime.iceServers : [];

      if (!ephemeralKey) {
        throw new Error('missing_client_secret');
      }

      const pc = new RTCPeerConnection({ iceServers });
      state.pc = pc;
      state.stream.getTracks().forEach(track => pc.addTrack(track, state.stream));

      pc.ontrack = event => {
        remoteAudio.srcObject = event.streams[0];
      };

      pc.onconnectionstatechange = () => {
        const status = pc.connectionState;
        if (status === 'connected') {
          state.connected = true;
          setStatus('listening', 'Connected. Speak naturally when prompted.');
          clearTimeout(state.disconnectTimer);
          startInterviewTimer();
        } else if (status === 'disconnected' || status === 'failed' || status === 'closed') {
          setStatus('connecting', 'Connection lost. Wrapping up...');
          clearTimeout(state.disconnectTimer);
          state.disconnectTimer = setTimeout(async () => {
            await completeInterview('disconnect_timeout');
          }, 6000);
        }
      };

      const channel = pc.createDataChannel('oai-events');
      state.channel = channel;

      channel.addEventListener('open', () => {
        setStatus('listening', 'Listening for your response...');

        channel.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              instructions: buildInterviewerInstructions()
            }
          })
        );

        const firstQuestion = Array.isArray(state.metadata?.interviewQuestions)
          ? state.metadata.interviewQuestions.find(question => typeof question?.text === 'string' && question.text.trim())
          : null;

        if (firstQuestion?.id) {
          state.askedQuestionIds.add(firstQuestion.id);
        }

        askInterviewQuestion(firstQuestion?.text || 'Please introduce yourself and summarize your most relevant experience for this role.');
      });

      channel.addEventListener('message', async event => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'output_audio_buffer.started') {
            setStatus('speaking', 'Interviewer is speaking...');
          }

          if (data.type === 'output_audio_buffer.stopped') {
            setStatus('listening', 'Your turn to answer.');
          }

          if (data.type === 'conversation.item.input_audio_transcription.completed') {
            const text = typeof data.transcript === 'string' ? data.transcript.trim() : '';
            if (!text) return;

            const turn = {
              id: data.item_id || `turn_${Date.now()}`,
              role: 'candidate',
              text,
              finalized: true,
              timestamp: new Date().toISOString()
            };

            state.transcriptTurns.push(turn);
            renderTranscript();
            const transcriptPayload = await sendTranscriptChunk(turn);
            const nextQuestion = transcriptPayload?.nextQuestion;
            if (nextQuestion?.id && !state.askedQuestionIds.has(nextQuestion.id)) {
              state.askedQuestionIds.add(nextQuestion.id);
              askInterviewQuestion(nextQuestion.text);
            }
          }
        } catch (err) {
          console.error('Failed to parse realtime event', err);
        }
      });

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp'
        }
      });

      if (!sdpResponse.ok) {
        throw new Error('failed_to_negotiate_webrtc');
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      muteBtn.disabled = false;
      repeatBtn.disabled = false;
      endBtn.disabled = false;
      setStatus('listening', 'Connected. Start speaking when ready.');
    } catch (err) {
      console.error('Failed to start voice interview', err);
      if (err && err.name === 'NotAllowedError') {
        setStatus('error', 'Microphone access is required. Please allow microphone permissions and retry.');
      } else if (err?.code === 'unsupported_transport') {
        const transportLabel = err.transport || 'unknown';
        setStatus('error', `This interview transport (${transportLabel}) is not supported in this browser session. Please contact support.`);
      } else if (err?.apiError === 'realtime_not_available') {
        setStatus('error', 'Voice interview is temporarily unavailable. Please try again shortly or contact support.');
      } else if (err?.apiError === 'realtime_session_rate_limited' || err?.status === 429) {
        setStatus('error', 'Too many attempts to start the voice session. Please wait a minute and retry.');
      } else {
        setStatus('error', 'Unable to start voice interview. Please refresh and try again.');
      }
      teardownConnection();
      startBtn.disabled = false;
    }
  }

  function toggleMute() {
    if (!state.stream) return;
    state.muted = !state.muted;
    state.stream.getAudioTracks().forEach(track => {
      track.enabled = !state.muted;
    });

    const muteBtn = document.getElementById('muteBtn');
    if (muteBtn) {
      muteBtn.textContent = state.muted ? 'Unmute' : 'Mute';
    }
  }

  function repeatQuestion() {
    if (!state.channel || state.channel.readyState !== 'open') return;
    state.channel.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          instructions: 'Please repeat the previous interview question exactly once.'
        }
      })
    );
    setStatus('speaking', 'Asking interviewer to repeat the question...');
  }

  function teardownConnection() {
    clearInterviewTimer();
    state.connected = false;

    if (state.channel && state.channel.readyState === 'open') {
      state.channel.close();
    }

    if (state.pc) {
      state.pc.close();
    }

    if (state.stream) {
      state.stream.getTracks().forEach(track => track.stop());
    }
  }

  async function applyBranding() {
    try {
      const response = await fetch('/public/settings/organization');
      if (!response.ok) return;
      const settings = await response.json();
      const name = settings?.portalName || 'HR Connect';
      const logo = settings?.logoUrl || '/logo.png';
      const logoEl = document.getElementById('brandLogo');
      const nameEl = document.getElementById('brandName');
      if (logoEl) logoEl.src = logo;
      if (nameEl) nameEl.textContent = name;
      document.title = `${name} AI Voice Interview`;
    } catch (err) {
      // no-op
    }
  }

  async function init() {
    await applyBranding();

    if (!token) {
      root.innerHTML = '<p class="text-red-700">Invalid interview link.</p>';
      return;
    }

    try {
      state.metadata = await fetchMetadata();
      if (state.metadata?.status === 'completed') {
        root.innerHTML = '<p class="text-slate-700">This interview has already been completed. Thank you.</p>';
        return;
      }
      renderApp();
    } catch (err) {
      root.innerHTML = '<p class="text-red-700">Unable to load interview details. Please retry later.</p>';
    }
  }

  window.addEventListener('beforeunload', () => {
    if (state.connected && !state.completeSent) {
      completeInterview('page_unload');
    }
    teardownConnection();
  });

  init();
})();
