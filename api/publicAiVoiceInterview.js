const express = require('express');
const { getDatabase } = require('../db');
const {
  score_answer,
  next_question,
  buildInitialOrchestration,
  finalizeOrchestration
} = require('../services/aiVoiceInterviewOrchestrator');
const { buildVoiceResult } = require('../services/aiVoiceInterviewScoring');
const {
  getAiVoiceInterviewRealtimeConfig,
  isAiVoiceInterviewEnabled
} = require('../utils/aiVoiceInterviewConfig');

const router = express.Router();

const DEFAULT_RECRUITER_EMAIL = process.env.RECRUITER_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || null;
const REALTIME_CONFIG = getAiVoiceInterviewRealtimeConfig();
const REALTIME_SESSION_RATE_LIMIT_MAX = Number(process.env.PUBLIC_AI_REALTIME_RATE_LIMIT_MAX || 6);
const REALTIME_SESSION_RATE_LIMIT_WINDOW_MS = Number(process.env.PUBLIC_AI_REALTIME_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const TRANSCRIPT_RATE_LIMIT_MAX = Number(process.env.PUBLIC_AI_TRANSCRIPT_RATE_LIMIT_MAX || 30);
const TRANSCRIPT_RATE_LIMIT_WINDOW_MS = Number(process.env.PUBLIC_AI_TRANSCRIPT_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const TRANSCRIPT_MAX_TURNS_PER_BATCH = Number(process.env.PUBLIC_AI_TRANSCRIPT_MAX_TURNS_PER_BATCH || 20);
const TRANSCRIPT_MAX_TEXT_LENGTH = Number(process.env.PUBLIC_AI_TRANSCRIPT_MAX_TEXT_LENGTH || 4_000);
const PROMPT_VERSION = process.env.PUBLIC_AI_VOICE_PROMPT_VERSION || 'voice-prompt-v1';

const realtimeSessionRateLimitState = new Map();
const transcriptRateLimitState = new Map();

router.use((req, res, next) => {
  if (!isAiVoiceInterviewEnabled()) {
    return res.status(404).json({ error: 'voice_interview_disabled' });
  }
  return next();
});

function normalizeSessionMode(mode) {
  return mode === 'voice' ? 'voice' : 'text';
}

function buildCandidateName(candidate) {
  if (!candidate) return null;
  const nameParts = [];
  if (candidate.firstName) {
    nameParts.push(candidate.firstName);
  }
  if (candidate.lastName) {
    nameParts.push(candidate.lastName);
  }
  const combined = nameParts.join(' ').trim();
  if (combined) return combined;
  if (candidate.name) return candidate.name;
  if (candidate.fullName) return candidate.fullName;
  if (candidate.email) return candidate.email;
  return null;
}

function deriveQuestionId(question, index) {
  return question?.id || question?.questionId || question?._id?.toString?.() || `q${index + 1}`;
}

function mapQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q, index) => ({
    id: deriveQuestionId(q, index),
    text: q.text || q.question || '',
    competency: q.competency || q.category || null
  }));
}

function buildVoiceDefaults(voice) {
  return {
    startedAt: voice?.startedAt || null,
    endedAt: voice?.endedAt || null,
    durationSec: Number.isFinite(voice?.durationSec) ? voice.durationSec : null,
    transcriptTurns: Array.isArray(voice?.transcriptTurns) ? voice.transcriptTurns : [],
    artifacts: voice?.artifacts || null
  };
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')?.[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function isRateLimited({ rateState, rateKey, maxRequests, windowMs }) {
  const now = Date.now();
  const entry = rateState.get(rateKey);

  if (!entry) {
    rateState.set(rateKey, { count: 1, firstSeenAtMs: now });
    return false;
  }

  if (now - entry.firstSeenAtMs > windowMs) {
    rateState.set(rateKey, { count: 1, firstSeenAtMs: now });
    return false;
  }

  entry.count += 1;
  rateState.set(rateKey, entry);
  return entry.count > maxRequests;
}

function buildRecruiterNotificationLines({ candidateName, positionTitle, candidateEmail, result }) {
  const lines = [
    'Hi team,',
    `${candidateName || 'The candidate'} has completed the AI voice interview for ${positionTitle || 'the position'}.`,
    result?.verdict ? `Verdict: ${result.verdict}` : 'Verdict: Not provided.'
  ];

  const scores = result?.scores || {};
  const scoreLines = [];
  if (scores.overall != null) scoreLines.push(`Overall: ${scores.overall} / 5`);
  if (scores.communication != null) scoreLines.push(`Communication: ${scores.communication}`);
  if (scores.technical != null) scoreLines.push(`Technical: ${scores.technical}`);
  if (scores.cultureFit != null) scoreLines.push(`Culture Fit: ${scores.cultureFit}`);

  if (scoreLines.length) {
    lines.push('', 'Scores:', ...scoreLines);
  }

  if (candidateEmail) {
    lines.push('', `Candidate email: ${candidateEmail}`);
  }

  lines.push('', 'Review the full feedback in the HR Portal to move the candidate forward.');
  return lines;
}

async function notifyRecruiterOfCompletion(req, { candidateName, positionTitle, candidateEmail, result }) {
  const sendEmail = req.app?.locals?.sendEmail;
  if (typeof sendEmail !== 'function' || !DEFAULT_RECRUITER_EMAIL) return false;

  const subject = `AI interview completed: ${candidateName || 'Candidate'}`;
  const body = buildRecruiterNotificationLines({ candidateName, positionTitle, candidateEmail, result }).join('\n');

  try {
    await sendEmail(DEFAULT_RECRUITER_EMAIL, subject, body);
    return true;
  } catch (err) {
    console.error('Failed to notify recruiter about AI voice interview completion:', err);
    return false;
  }
}

async function findVoiceSession(token) {
  const db = getDatabase();
  const session = await db.collection('ai_interview_sessions').findOne({ token });

  if (!session) {
    return { error: 'session_not_found', status: 404 };
  }

  if (normalizeSessionMode(session.mode) !== 'voice') {
    return { error: 'session_mode_mismatch', status: 400 };
  }

  return { db, session };
}

function normalizeTranscriptTurn(turn, index) {
  if (!turn || typeof turn !== 'object') return null;
  const textSource =
    typeof turn.text === 'string'
      ? turn.text
      : typeof turn.content === 'string'
      ? turn.content
      : typeof turn.utterance === 'string'
      ? turn.utterance
      : '';
  const text = textSource.trim();
  if (!text) return null;
  if (text.length > TRANSCRIPT_MAX_TEXT_LENGTH) return null;

  const turnId =
    (typeof turn.turnId === 'string' && turn.turnId.trim()) ||
    (typeof turn.id === 'string' && turn.id.trim()) ||
    `turn_${Date.now()}_${index}`;

  const startedAt = turn.startedAt || turn.timestamp || turn.time || new Date().toISOString();
  const endedAt = turn.endedAt || startedAt;

  const confidence = Number(turn.confidence);

  return {
    turnId,
    id: turn.id || turnId,
    role: typeof turn.role === 'string' ? turn.role : 'candidate',
    text,
    finalized: true,
    startedAt,
    endedAt,
    timestamp: turn.timestamp || startedAt,
    ...(Number.isFinite(confidence) ? { confidence } : {}),
    meta: turn.meta && typeof turn.meta === 'object' ? turn.meta : undefined
  };
}

function toDate(input) {
  if (!input) return null;
  const value = input instanceof Date ? input : new Date(input);
  return Number.isNaN(value.getTime()) ? null : value;
}

function getElapsedVoiceDurationSec(session, now = new Date()) {
  const startedAt = toDate(session?.voice?.startedAt);
  if (!startedAt) {
    return { startedAt: null, elapsedSec: 0 };
  }

  const elapsedMs = now.getTime() - startedAt.getTime();
  return {
    startedAt,
    elapsedSec: Math.max(0, Math.round(elapsedMs / 1000))
  };
}

function getCompletionStatus(session) {
  if (typeof session?.voice?.completionStatus === 'string' && session.voice.completionStatus.trim()) {
    return session.voice.completionStatus;
  }
  return session?.status === 'completed' ? 'completed' : session?.status || 'pending';
}

async function finalizeVoiceInterviewSession(req, { db, session, now, completionStatus }) {
  const startedAt = toDate(session?.voice?.startedAt) || now;
  const durationSec = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  const finalizedOrchestration = finalizeOrchestration({ session, endedAt: now });

  const updateResult = await db.collection('ai_interview_sessions').updateOne(
    { _id: session._id, status: { $ne: 'completed' } },
    {
      $set: {
        status: 'completed',
        completedAt: now,
        'voice.startedAt': startedAt,
        'voice.endedAt': now,
        'voice.durationSec': durationSec,
        'voice.completionStatus': completionStatus,
        orchestration: finalizedOrchestration,
        'audit.promptVersion': finalizedOrchestration.promptVersion || PROMPT_VERSION,
        'audit.rubricVersion': finalizedOrchestration.rubricVersion || null,
        'audit.scoringVersion': finalizedOrchestration.scoringVersion || null,
        analysisStatus: 'queued',
        analysisQueuedAt: now
      }
    }
  );

  if (updateResult.modifiedCount) {
    await enqueueFinalAnalysisAndNotification(req, session._id);
    return {
      success: true,
      status: completionStatus,
      durationSec,
      alreadyCompleted: false
    };
  }

  const currentSession = await db.collection('ai_interview_sessions').findOne({ _id: session._id });
  return {
    success: true,
    status: getCompletionStatus(currentSession),
    durationSec: currentSession?.voice?.durationSec ?? durationSec,
    alreadyCompleted: currentSession?.status === 'completed'
  };
}

async function createRealtimeSession() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('openai_not_configured');
    err.code = 'openai_not_configured';
    throw err;
  }

  const fallbackModels = String(process.env.OPENAI_REALTIME_FALLBACK_MODELS || 'gpt-4o-realtime-preview,gpt-realtime')
    .split(',')
    .map(model => model.trim())
    .filter(Boolean);

  const modelsToTry = [REALTIME_CONFIG.model, ...fallbackModels.filter(model => model !== REALTIME_CONFIG.model)];
  let lastError = null;

  for (const model of modelsToTry) {
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify({
        model,
        voice: REALTIME_CONFIG.voice,
        modalities: ['audio', 'text'],
        input_audio_transcription: {
          model: REALTIME_CONFIG.transcriptionModel
        }
      })
    });

    if (response.ok) {
      return await response.json();
    }

    const body = await response.text();
    const errorDetails = `${response.status} ${response.statusText} - ${body}`;
    lastError = new Error('failed_to_create_realtime_session');
    lastError.code = 'realtime_session_create_failed';
    lastError.details = errorDetails;
    lastError.status = response.status;

    if (response.status === 401 || response.status === 403) {
      throw lastError;
    }

    console.warn(`[voice-interview] Realtime session creation failed for model "${model}": ${errorDetails}`);
  }

  throw lastError || new Error('failed_to_create_realtime_session');
}

async function enqueueFinalAnalysisAndNotification(req, sessionId) {
  setImmediate(async () => {
    try {
      const db = getDatabase();
      const session = await db.collection('ai_interview_sessions').findOne({ _id: sessionId });
      if (!session || session.aiResultId) return;

      const candidate = await db.collection('candidates').findOne({ _id: session.candidateId });
      const position = await db.collection('positions').findOne({ _id: session.positionId });

      const aiResultDoc = buildVoiceResult({
        session,
        applicationId: session.applicationId,
        candidateId: session.candidateId,
        positionId: session.positionId
      });

      const insertResult = await db.collection('ai_interview_results').insertOne(aiResultDoc);

      await db.collection('ai_interview_sessions').updateOne(
        { _id: session._id },
        {
          $set: {
            aiResultId: insertResult.insertedId,
            analysisStatus: 'completed',
            analysisCompletedAt: new Date()
          }
        }
      );

      await notifyRecruiterOfCompletion(req, {
        candidateName: buildCandidateName(candidate),
        positionTitle: position?.title || session.positionTitle,
        candidateEmail: candidate?.email || null,
        result: aiResultDoc || {}
      });
    } catch (err) {
      console.error('Failed to process final voice interview analysis:', err);
      try {
        const db = getDatabase();
        await db.collection('ai_interview_sessions').updateOne(
          { _id: sessionId },
          {
            $set: {
              analysisStatus: 'failed',
              analysisFailedAt: new Date(),
              analysisFailureReason: err?.message || 'unknown_analysis_error'
            }
          }
        );
      } catch (updateErr) {
        console.error('Failed to update analysis failure state:', updateErr);
      }
    }
  });
}

router.get('/ai-voice-interview/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const lookup = await findVoiceSession(token);

    if (lookup.error) {
      return res.status(lookup.status).json({ error: lookup.error });
    }

    const { db, session } = lookup;

    const [candidate, position] = await Promise.all([
      db.collection('candidates').findOne({ _id: session.candidateId }),
      db.collection('positions').findOne({ _id: session.positionId })
    ]);

    return res.json({
      status: session.status || 'pending',
      candidateName: buildCandidateName(candidate) || 'Candidate',
      candidateEmail: candidate?.email || null,
      positionTitle: position?.title || session.positionTitle || 'Role',
      templateTitle: session.templateTitle || position?.title || 'AI Voice Interview',
      interviewQuestions: mapQuestions(session.aiInterviewQuestions),
      realtimeConfig: {
        model: REALTIME_CONFIG.model,
        voice: REALTIME_CONFIG.voice,
        transcriptionModel: REALTIME_CONFIG.transcriptionModel,
        maxDurationSec: REALTIME_CONFIG.maxDurationSec,
        allowInterruptions: REALTIME_CONFIG.allowInterruptions
      },
      orchestration: buildInitialOrchestration(session)
    });
  } catch (err) {
    console.error('Error fetching AI voice interview session:', err);
    return res.status(500).json({ error: 'failed_to_fetch_session' });
  }
});

router.post('/ai-voice-interview/:token/realtime-session', async (req, res) => {
  try {
    const { token } = req.params;
    const lookup = await findVoiceSession(token);

    if (lookup.error) {
      return res.status(lookup.status).json({ error: lookup.error });
    }

    const { session } = lookup;

    if (session.status === 'completed') {
      return res.status(400).json({ error: 'session_already_completed' });
    }

    const existingRealtimeSession = session?.voice?.realtimeSession;
    const existingRealtimeExpiry = existingRealtimeSession?.expiresAt ? new Date(existingRealtimeSession.expiresAt) : null;
    if (existingRealtimeSession?.id && existingRealtimeExpiry && existingRealtimeExpiry.getTime() > Date.now()) {
      return res.status(409).json({
        error: 'active_realtime_session_exists',
        session: {
          id: existingRealtimeSession.id,
          expires_at: Math.floor(existingRealtimeExpiry.getTime() / 1000)
        }
      });
    }

    const rateKey = `${token}:${getClientIp(req)}`;
    if (isRateLimited({
      rateState: realtimeSessionRateLimitState,
      rateKey,
      maxRequests: REALTIME_SESSION_RATE_LIMIT_MAX,
      windowMs: REALTIME_SESSION_RATE_LIMIT_WINDOW_MS
    })) {
      return res.status(429).json({ error: 'realtime_session_rate_limited' });
    }

    let realtimeSession;
    try {
      realtimeSession = await createRealtimeSession();
    } catch (err) {
      if (err.code === 'openai_not_configured') {
        return res.status(503).json({ error: 'realtime_not_available' });
      }

      if (err.status === 401 || err.status === 403) {
        console.error('Realtime session rejected due to OpenAI authentication/authorization error:', err?.details || err);
        return res.status(503).json({ error: 'realtime_not_available' });
      }

      console.error('Error creating realtime session:', err?.details || err);
      return res.status(502).json({ error: 'failed_to_create_realtime_session' });
    }

    const sessionId = realtimeSession?.id || null;
    const clientSecret = realtimeSession?.client_secret?.value || null;
    if (!sessionId || !clientSecret) {
      return res.status(502).json({ error: 'failed_to_create_realtime_session' });
    }

    await lookup.db.collection('ai_interview_sessions').updateOne(
      { _id: session._id },
      {
        $set: {
          'voice.realtimeSession': {
            id: sessionId,
            issuedAt: new Date(),
            expiresAt: realtimeSession?.expires_at ? new Date(realtimeSession.expires_at * 1000) : null,
            promptVersion: PROMPT_VERSION
          }
        }
      }
    );

    return res.status(201).json({
      transport: 'webrtc',
      iceServers: [],
      client_secret: {
        value: clientSecret,
        expires_at: realtimeSession?.client_secret?.expires_at || realtimeSession?.expires_at || null
      },
      expires_at: realtimeSession?.expires_at || null,
      session: {
        id: sessionId,
        model: realtimeSession?.model || REALTIME_CONFIG.model,
        voice: realtimeSession?.voice || REALTIME_CONFIG.voice
      }
    });
  } catch (err) {
    console.error('Error issuing realtime credentials:', err);
    return res.status(500).json({ error: 'failed_to_issue_realtime_credentials' });
  }
});

router.post('/ai-voice-interview/:token/transcript', async (req, res) => {
  try {
    const { token } = req.params;
    const lookup = await findVoiceSession(token);

    if (lookup.error) {
      return res.status(lookup.status).json({ error: lookup.error });
    }

    const { db, session } = lookup;

    if (session.status === 'completed') {
      return res.status(200).json({
        success: true,
        status: getCompletionStatus(session),
        durationSec: Number.isFinite(session?.voice?.durationSec) ? session.voice.durationSec : 0,
        alreadyCompleted: true
      });
    }

    const rateKey = `${token}:${getClientIp(req)}`;
    if (isRateLimited({
      rateState: transcriptRateLimitState,
      rateKey,
      maxRequests: TRANSCRIPT_RATE_LIMIT_MAX,
      windowMs: TRANSCRIPT_RATE_LIMIT_WINDOW_MS
    })) {
      return res.status(429).json({ error: 'transcript_rate_limited' });
    }

    const incomingTurns = Array.isArray(req.body?.turns)
      ? req.body.turns
      : req.body?.turn
        ? [req.body.turn]
        : [];

    if (!incomingTurns.length || incomingTurns.length > TRANSCRIPT_MAX_TURNS_PER_BATCH) {
      return res.status(400).json({ error: 'invalid_turn_batch_size' });
    }

    const oversizedTurn = incomingTurns.find(turn => typeof turn?.text === 'string' && turn.text.trim().length > TRANSCRIPT_MAX_TEXT_LENGTH);
    if (oversizedTurn) {
      return res.status(400).json({ error: 'turn_text_too_long' });
    }

    const finalizedTurns = incomingTurns
      .filter(turn => turn?.finalized !== false)
      .map(normalizeTranscriptTurn)
      .filter(Boolean);

    if (!finalizedTurns.length) {
      return res.status(400).json({ error: 'finalized_turns_required' });
    }

    const now = new Date();
    const { elapsedSec } = getElapsedVoiceDurationSec(session, now);
    const hasDurationLimit = Number.isFinite(REALTIME_CONFIG.maxDurationSec) && REALTIME_CONFIG.maxDurationSec > 0;
    const timeRemainingSec = hasDurationLimit
      ? Math.max(0, REALTIME_CONFIG.maxDurationSec - elapsedSec)
      : null;
    const isTimedOut = hasDurationLimit && elapsedSec >= REALTIME_CONFIG.maxDurationSec;

    if (isTimedOut) {
      const completion = await finalizeVoiceInterviewSession(req, {
        db,
        session,
        now,
        completionStatus: 'completed_due_to_timeout'
      });
      return res.status(200).json(completion);
    }

    const shouldMarkStarted = !session.voice?.startedAt;
    let orchestrationState = buildInitialOrchestration(session);

    finalizedTurns.forEach(turn => {
      if (turn.role === 'candidate') {
        const scoreContract = score_answer({
          session: { ...session, orchestration: orchestrationState },
          turn,
          timeRemainingSec
        });
        orchestrationState = scoreContract.orchestration;
      }
    });

    const nextQuestionContract = next_question({
      session: { ...session, orchestration: orchestrationState },
      timeRemainingSec
    });
    orchestrationState = nextQuestionContract.orchestration;

    await db.collection('ai_interview_sessions').updateOne(
      { _id: session._id },
      {
        $push: { 'voice.transcriptTurns': { $each: finalizedTurns } },
        $set: {
          status: session.status === 'pending' || session.status === 'sent' ? 'started' : session.status,
          orchestration: {
            ...orchestrationState,
            coverage: orchestrationState.coverage || {},
            difficulty: orchestrationState.difficulty || 'medium',
            phase: orchestrationState.phase || 'intro',
            lastTransitionReason: orchestrationState.lastTransitionReason || null,
            lastTranscriptUpdateAt: now.toISOString(),
            timeRemainingSec
          },
          'audit.promptVersion': orchestrationState.promptVersion || PROMPT_VERSION,
          'audit.rubricVersion': orchestrationState.rubricVersion || null,
          'audit.scoringVersion': orchestrationState.scoringVersion || null,
          ...(shouldMarkStarted ? { startedAt: now, 'voice.startedAt': now } : {})
        }
      }
    );

    return res.status(201).json({
      appended: finalizedTurns.length,
      orchestration: orchestrationState,
      nextQuestion: nextQuestionContract.question
    });
  } catch (err) {
    console.error('Error appending voice transcript turns:', err);
    return res.status(500).json({ error: 'failed_to_append_transcript' });
  }
});

router.post('/ai-voice-interview/:token/complete', async (req, res) => {
  try {
    const { token } = req.params;
    const lookup = await findVoiceSession(token);

    if (lookup.error) {
      return res.status(lookup.status).json({ error: lookup.error });
    }

    const { db, session } = lookup;

    if (session.status === 'completed') {
      return res.json({
        success: true,
        status: getCompletionStatus(session),
        durationSec: Number.isFinite(session?.voice?.durationSec) ? session.voice.durationSec : 0,
        alreadyCompleted: true
      });
    }

    const now = new Date();
    const { elapsedSec } = getElapsedVoiceDurationSec(session, now);
    const hasDurationLimit = Number.isFinite(REALTIME_CONFIG.maxDurationSec) && REALTIME_CONFIG.maxDurationSec > 0;
    const timeRemainingSec = hasDurationLimit
      ? Math.max(0, REALTIME_CONFIG.maxDurationSec - elapsedSec)
      : null;
    const isTimedOut = hasDurationLimit && elapsedSec >= REALTIME_CONFIG.maxDurationSec;

    const completion = await finalizeVoiceInterviewSession(req, {
      db,
      session,
      now,
      completionStatus: isTimedOut ? 'completed_due_to_timeout' : 'completed'
    });

    return res.json(completion);
  } catch (err) {
    console.error('Error completing AI voice interview session:', err);
    return res.status(500).json({ error: 'failed_to_complete_session' });
  }
});

module.exports = router;
