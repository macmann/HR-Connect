const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../db');
const { analyzeInterviewResponses } = require('../openaiClient');

const router = express.Router();

const DEFAULT_RECRUITER_EMAIL = process.env.RECRUITER_NOTIFICATION_EMAIL || process.env.ADMIN_EMAIL || null;
const WRITTEN_SCORING_VERSION = 'written-evaluator-v1';

function normalizeObjectId(id) {
  if (!id) return null;
  try {
    return typeof id === 'string' ? new ObjectId(id) : id;
  } catch (err) {
    return null;
  }
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
    text: q.text || q.question || ''
  }));
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

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildTimeline(startedAtInput, endedAtInput) {
  const startedAt = toDate(startedAtInput);
  const endedAt = toDate(endedAtInput);

  let durationSec = null;
  if (startedAt && endedAt && endedAt >= startedAt) {
    durationSec = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  }

  return {
    startedAt,
    endedAt,
    durationSec
  };
}

function deriveRubricVersion({ session, position }) {
  const rubricVersion = session?.orchestration?.rubricVersion || session?.rubricVersion || position?.rubricVersion;
  if (rubricVersion) return rubricVersion;

  const rubricSeed =
    session?.orchestration?.rubricSeed ||
    session?.rubricSeed ||
    session?.aiInterviewRubricSeed ||
    position?.rubricSeed ||
    position?.aiInterviewRubricSeed;

  if (!rubricSeed || typeof rubricSeed !== 'string') return null;
  return /-v\d+$/i.test(rubricSeed) ? rubricSeed : `${rubricSeed}-v1`;
}

function extractWrittenEvidence(answers) {
  if (!Array.isArray(answers)) return [];

  return answers
    .map(answer => ({
      questionId: answer?.questionId || null,
      quote: typeof answer?.answerText === 'string' ? answer.answerText.trim().replace(/\s+/g, ' ') : ''
    }))
    .filter(item => item.quote)
    .map(item => ({
      ...item,
      quote: item.quote.length > 220 ? `${item.quote.slice(0, 217)}...` : item.quote
    }));
}

function buildRecruiterNotificationLines({ candidateName, positionTitle, candidateEmail, result }) {
  const lines = [
    'Hi team,',
    `${candidateName || 'The candidate'} has completed the AI interview for ${positionTitle || 'the position'}.`,
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
    console.error('Failed to notify recruiter about AI interview completion:', err);
    return false;
  }
}

router.get('/ai-interview/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const db = getDatabase();

    const session = await db.collection('ai_interview_sessions').findOne({ token });

    if (!session) {
      return res.status(404).json({ error: 'session_not_found' });
    }

    if (normalizeSessionMode(session.mode) !== 'text') {
      return res.status(400).json({ error: 'session_mode_mismatch' });
    }

    let candidate = null;
    let position = null;

    const candidateId = normalizeObjectId(session.candidateId);
    const positionId = normalizeObjectId(session.positionId);

    if (candidateId) {
      candidate = await db.collection('candidates').findOne({ _id: candidateId });
    }

    if (positionId) {
      position = await db.collection('positions').findOne({ _id: positionId });
    }

    const candidateName = buildCandidateName(candidate) || 'Candidate';
    const positionTitle = position?.title || session.positionTitle || 'Role';
    const templateTitle = session.templateTitle || positionTitle || 'AI Interview';
    const questions = mapQuestions(session.aiInterviewQuestions);

    return res.json({
      status: session.status || 'pending',
      mode: normalizeSessionMode(session.mode),
      voice: buildVoiceDefaults(session.voice),
      orchestration: buildOrchestrationDefaults(session.orchestration),
      candidateName,
      positionTitle,
      templateTitle,
      questions
    });
  } catch (err) {
    console.error('Error fetching AI interview session:', err);
    return res.status(500).json({ error: 'failed_to_fetch_session' });
  }
});

router.post('/ai-interview/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { answers } = req.body || {};
    const db = getDatabase();

    const session = await db.collection('ai_interview_sessions').findOne({ token });

    if (!session) {
      return res.status(404).json({ error: 'session_not_found' });
    }

    if (normalizeSessionMode(session.mode) !== 'text') {
      return res.status(400).json({ error: 'session_mode_mismatch' });
    }

    if (session.status === 'completed') {
      return res.status(400).json({ error: 'session_already_completed' });
    }

    const questions = Array.isArray(session.aiInterviewQuestions)
      ? session.aiInterviewQuestions
      : [];

    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers_array_required' });
    }

    const missing = questions.filter((question, index) => {
      const questionId = deriveQuestionId(question, index);
      const answer = answers.find(a => a.questionId === questionId);
      return !answer || !answer.answerText || !answer.answerText.trim();
    });

    if (missing.length) {
      return res.status(400).json({ error: 'all_answers_required' });
    }

    const normalizedAnswers = answers.map(a => ({
      questionId: a.questionId,
      answerText: typeof a.answerText === 'string' ? a.answerText.trim() : ''
    }));

    const now = new Date();

    await db.collection('ai_interview_sessions').updateOne(
      { _id: session._id },
      {
        $set: {
          answers: normalizedAnswers,
          status: 'completed',
          startedAt: session.startedAt || now,
          completedAt: now
        }
      }
    );

    const updatedSession = await db.collection('ai_interview_sessions').findOne({ token });

    const application = await db.collection('applications').findOne({ _id: updatedSession.applicationId });
    const candidate = await db.collection('candidates').findOne({ _id: updatedSession.candidateId });
    const position = await db.collection('positions').findOne({ _id: updatedSession.positionId });

    const candidateName = buildCandidateName(candidate) || candidate?.fullName || candidate?.name;
    const positionTitle = position?.title || updatedSession.positionTitle;
    const candidateEmail = candidate?.email || null;

    const payload = {
      positionTitle,
      positionDescription: position?.description,
      candidateName,
      questions: updatedSession.aiInterviewQuestions,
      answers: updatedSession.answers,
    };

    let analysis;
    try {
      analysis = await analyzeInterviewResponses(payload);
    } catch (err) {
      console.error('Error analyzing interview:', err);
      return res.json({ success: true, aiAnalysisQueued: false });
    }

    const { result, raw } = analysis;
    const timeline = buildTimeline(updatedSession.startedAt, updatedSession.completedAt);
    const rubricVersion = deriveRubricVersion({ session: updatedSession, position });

    const aiResultDoc = {
      sessionId: updatedSession._id,
      applicationId: updatedSession.applicationId,
      candidateId: updatedSession.candidateId,
      positionId: updatedSession.positionId,
      mode: 'text',
      scores: result.scores || {},
      verdict: result.verdict || 'hold',
      summary: result.summary || '',
      strengths: result.strengths || [],
      risks: result.risks || [],
      recommendedNextSteps: result.recommendedNextSteps || [],
      evidence: extractWrittenEvidence(updatedSession.answers),
      timeline,
      rubricVersion,
      scoringVersion: WRITTEN_SCORING_VERSION,
      rawModelResponse: raw,
      createdAt: new Date(),
    };

    const insertResult = await db.collection('ai_interview_results').insertOne(aiResultDoc);

    await db.collection('ai_interview_sessions').updateOne(
      { _id: updatedSession._id },
      { $set: { aiResultId: insertResult.insertedId } }
    );

    await notifyRecruiterOfCompletion(req, {
      candidateName,
      positionTitle,
      candidateEmail,
      result: result || {}
    });

    return res.json({ success: true, aiAnalysisQueued: true });
  } catch (err) {
    console.error('Error submitting AI interview answers:', err);
    return res.status(500).json({ error: 'failed_to_submit_answers' });
  }
});

module.exports = router;
