const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../db');
const { generateInterviewToken } = require('../utils/token');
const { getAiVoiceInterviewConfig, isAiVoiceInterviewEnabled } = require('../utils/aiVoiceInterviewConfig');

const router = express.Router();

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || '';

function buildCandidateName(candidate) {
  if (!candidate) return null;
  const parts = [];
  if (candidate.firstName) parts.push(candidate.firstName);
  if (candidate.lastName) parts.push(candidate.lastName);
  const combined = parts.join(' ').trim();
  if (combined) return combined;
  return candidate.fullName || candidate.name || candidate.email || null;
}

function buildInterviewUrl(req, interviewPath) {
  if (!interviewPath) return '';
  const base =
    PUBLIC_APP_URL || req.get('origin') || `${req.protocol}://${req.get('host')}`;
  try {
    return new URL(interviewPath, base).toString();
  } catch (err) {
    return interviewPath;
  }
}

function normalizeSessionMode(mode) {
  return mode === 'voice' ? 'voice' : 'text';
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

function buildOrchestrationDefaults(orchestration) {
  return {
    rubricVersion: orchestration?.rubricVersion || null,
    interviewPlan: Array.isArray(orchestration?.interviewPlan) ? orchestration.interviewPlan : [],
    coverage:
      orchestration?.coverage && typeof orchestration.coverage === 'object'
        ? orchestration.coverage
        : {},
    lastQuestionId: orchestration?.lastQuestionId || null,
    difficulty: orchestration?.difficulty || null
  };
}

// TODO: apply auth middleware if available

router.get('/ai-interview/config', (req, res) => {
  const config = getAiVoiceInterviewConfig();
  return res.json({
    voiceInterviewEnabled: config.enabled,
    voiceInterviewFeatureFlagEnabled: config.featureFlagEnabled,
    voiceInterviewOpenAiConfigured: config.hasOpenAiKey
  });
});

router.get('/ai-interview/application/:applicationId', async (req, res) => {
  try {
    const db = getDatabase();
    const { applicationId } = req.params;

    let appId;
    try {
      appId = new ObjectId(applicationId);
    } catch (e) {
      return res.status(400).json({ error: 'invalid_application_id' });
    }

    const session = await db
      .collection('ai_interview_sessions')
      .findOne({ applicationId: appId }, { sort: { createdAt: -1 } });

    if (!session) {
      return res.json({ hasSession: false });
    }

    let result = null;
    if (session.aiResultId) {
      result = await db.collection('ai_interview_results').findOne({ _id: session.aiResultId });
    }

    return res.json({
      hasSession: true,
      session: {
        id: session._id,
        status: session.status,
        mode: normalizeSessionMode(session.mode),
        voice: buildVoiceDefaults(session.voice),
        orchestration: buildOrchestrationDefaults(session.orchestration),
        createdAt: session.createdAt,
        completedAt: session.completedAt
      },
      result: result
        ? {
            scores: result.scores,
            verdict: result.verdict,
            mode: result.mode,
            summary: result.summary,
            strengths: result.strengths,
            risks: result.risks,
            recommendedNextSteps: result.recommendedNextSteps,
            evidence: result.evidence,
            timeline: result.timeline,
            rubricVersion: result.rubricVersion,
            scoringVersion: result.scoringVersion,
            voiceSummary: result.voiceSummary,
            transcriptTurns: result.transcriptTurns,
            highlights: result.highlights,
            evidenceQuotes: result.evidenceQuotes,
            createdAt: result.createdAt
          }
        : null
    });
  } catch (err) {
    console.error('Error fetching AI interview info for application:', err);
    return res.status(500).json({ error: 'failed_to_fetch_ai_interview_info' });
  }
});

// POST /api/hr/ai-interview/sessions
// Body: { applicationId: "<id>" }
router.post('/ai-interview/sessions', async (req, res) => {
  try {
    const db = getDatabase();
    const { applicationId, mode } = req.body;
    const normalizedMode = normalizeSessionMode(mode);

    if (!applicationId) {
      return res.status(400).json({ error: 'applicationId_required' });
    }

    let application;
    try {
      application = await db.collection('applications').findOne({ _id: new ObjectId(applicationId) });
    } catch (e) {
      return res.status(400).json({ error: 'invalid_application_id' });
    }

    if (!application) {
      return res.status(404).json({ error: 'application_not_found' });
    }

    const candidateId = application.candidateId;
    const positionId = application.positionId;

    if (!candidateId || !positionId) {
      return res.status(400).json({ error: 'application_missing_candidate_or_position' });
    }

    const candidate = await db.collection('candidates').findOne({ _id: new ObjectId(candidateId) });
    const position = await db.collection('positions').findOne({ _id: new ObjectId(positionId) });

    if (!candidate || !position) {
      return res.status(404).json({ error: 'candidate_or_position_not_found' });
    }

    if (normalizedMode === 'voice') {
      if (!isAiVoiceInterviewEnabled()) {
        return res.status(400).json({ error: 'voice_realtime_not_enabled' });
      }

      if (!candidate.email) {
        return res.status(400).json({ error: 'candidate_email_required_for_voice_mode' });
      }
    }

    const questions = Array.isArray(position.aiInterviewQuestions)
      ? position.aiInterviewQuestions
      : [];

    if (!questions.length) {
      return res.status(400).json({ error: 'no_ai_questions_defined_for_position' });
    }

    const token = generateInterviewToken();
    const sessionDoc = {
      token,
      applicationId: application._id,
      candidateId: candidate._id,
      positionId: position._id,
      status: 'sent',
      mode: normalizedMode,
      templateTitle: position.title || 'AI Interview',
      aiInterviewQuestions: questions,
      answers: [],
      voice: buildVoiceDefaults(),
      orchestration: buildOrchestrationDefaults(),
      startedAt: null,
      completedAt: null,
      aiResultId: null,
      createdAt: new Date()
    };

    const result = await db.collection('ai_interview_sessions').insertOne(sessionDoc);

    const interviewPath =
      normalizedMode === 'voice' ? `/ai-voice-interview/${token}` : `/ai-interview/${token}`;
    const interviewUrl = buildInterviewUrl(req, interviewPath);

    const sendEmail = req.app?.locals?.sendEmail;
    let emailSent = false;
    if (candidate.email && typeof sendEmail === 'function') {
      const candidateName = buildCandidateName(candidate) || 'there';
      const positionTitle = position.title || 'the position';
      const interviewModeLabel = normalizedMode === 'voice' ? 'voice interview' : 'written interview';
      const emailLines = [
        `Hi ${candidateName},`,
        '',
        `You have been invited to complete a ${interviewModeLabel} for ${positionTitle}.`,
        `Start your interview here: ${interviewUrl || interviewPath}`,
        '',
        `This invitation is for a ${interviewModeLabel}.`,
        'Please complete the interview at your earliest convenience.'
      ];
      try {
        await sendEmail(
          candidate.email,
          `Your AI ${interviewModeLabel} for ${positionTitle}`,
          emailLines.join('\n')
        );
        emailSent = true;
      } catch (err) {
        console.error('Failed to send AI interview invitation email:', err);
      }
    }

    return res.status(201).json({
      sessionId: result.insertedId,
      token,
      mode: normalizedMode,
      interviewPath,
      interviewUrl,
      emailSent
    });
  } catch (err) {
    console.error('Error creating AI interview session:', err);
    return res.status(500).json({ error: 'failed_to_create_session' });
  }
});

module.exports = router;
