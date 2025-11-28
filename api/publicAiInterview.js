const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../db');

const router = express.Router();

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

router.get('/ai-interview/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const db = getDatabase();

    const session = await db.collection('ai_interview_sessions').findOne({ token });

    if (!session) {
      return res.status(404).json({ error: 'session_not_found' });
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

    return res.json({ success: true });
  } catch (err) {
    console.error('Error submitting AI interview answers:', err);
    return res.status(500).json({ error: 'failed_to_submit_answers' });
  }
});

module.exports = router;
