const {
  SCORING_VERSION,
  RUBRIC_VERSION,
  inferCompetency,
  buildCoverageUpdate,
  scoreAnswer
} = require('./aiVoiceInterviewScoring');

const PROMPT_VERSION = process.env.PUBLIC_AI_VOICE_PROMPT_VERSION || 'voice-prompt-v1';

function toDate(input) {
  if (!input) return null;
  const value = input instanceof Date ? input : new Date(input);
  return Number.isNaN(value.getTime()) ? null : value;
}

function buildInitialOrchestration(session) {
  const existing = session?.orchestration && typeof session.orchestration === 'object'
    ? session.orchestration
    : {};

  return {
    phase: existing.phase || 'intro',
    startedAt: existing.startedAt || session?.voice?.startedAt || session?.startedAt || null,
    endedAt: existing.endedAt || null,
    durationSec: Number.isFinite(existing.durationSec) ? existing.durationSec : null,
    promptVersion: existing.promptVersion || PROMPT_VERSION,
    rubricVersion: existing.rubricVersion || RUBRIC_VERSION,
    scoringVersion: existing.scoringVersion || SCORING_VERSION,
    coverage: existing.coverage && typeof existing.coverage === 'object' ? existing.coverage : {},
    difficulty: existing.difficulty || 'medium',
    evidenceCandidates: Array.isArray(existing.evidenceCandidates) ? existing.evidenceCandidates : [],
    turnAssessments: Array.isArray(existing.turnAssessments) ? existing.turnAssessments : [],
    askedQuestionIds: Array.isArray(existing.askedQuestionIds) ? existing.askedQuestionIds : [],
    lastQuestionId: existing.lastQuestionId || null
  };
}

function score_answer({ session, turn }) {
  const orchestration = buildInitialOrchestration(session);
  const questions = Array.isArray(session?.aiInterviewQuestions) ? session.aiInterviewQuestions : [];
  const askedCount = orchestration.turnAssessments.length;
  const currentQuestion = questions[askedCount] || null;
  const questionId = currentQuestion?.id || currentQuestion?.questionId || currentQuestion?._id?.toString?.() || null;
  const competency = inferCompetency(currentQuestion);

  const assessment = scoreAnswer({
    answerText: turn?.text || '',
    competency,
    turnId: turn?.id || null,
    questionId,
    difficulty: orchestration.difficulty
  });

  const updatedCoverage = buildCoverageUpdate(orchestration.coverage, competency, assessment.score);
  const evidenceCandidates = assessment.evidenceCandidate?.quote
    ? [...orchestration.evidenceCandidates, assessment.evidenceCandidate].slice(-12)
    : orchestration.evidenceCandidates;

  return {
    ...orchestration,
    phase: 'questioning',
    coverage: updatedCoverage,
    difficulty: assessment.difficultyAfter,
    evidenceCandidates,
    turnAssessments: [...orchestration.turnAssessments, assessment],
    askedQuestionIds: questionId && !orchestration.askedQuestionIds.includes(questionId)
      ? [...orchestration.askedQuestionIds, questionId]
      : orchestration.askedQuestionIds,
    lastQuestionId: questionId || orchestration.lastQuestionId
  };
}

function next_question({ session }) {
  const orchestration = buildInitialOrchestration(session);
  const questions = Array.isArray(session?.aiInterviewQuestions) ? session.aiInterviewQuestions : [];
  const asked = new Set(orchestration.askedQuestionIds || []);

  const next = questions.find((question, index) => {
    const questionId = question?.id || question?.questionId || question?._id?.toString?.() || `q${index + 1}`;
    return !asked.has(questionId);
  }) || null;

  if (!next) {
    return {
      question: null,
      orchestration: {
        ...orchestration,
        phase: 'closing'
      }
    };
  }

  const questionId = next?.id || next?.questionId || next?._id?.toString?.() || null;

  return {
    question: {
      id: questionId,
      text: next?.text || next?.question || '',
      competency: inferCompetency(next)
    },
    orchestration: {
      ...orchestration,
      phase: 'questioning',
      lastQuestionId: questionId || orchestration.lastQuestionId
    }
  };
}

function finalizeOrchestration({ session, endedAt }) {
  const orchestration = buildInitialOrchestration(session);
  const startedAt = toDate(orchestration.startedAt || session?.voice?.startedAt || session?.startedAt);
  const ended = toDate(endedAt) || new Date();
  const durationSec = startedAt
    ? Math.max(0, Math.round((ended.getTime() - startedAt.getTime()) / 1000))
    : 0;

  return {
    ...orchestration,
    phase: 'completed',
    startedAt: startedAt || ended,
    endedAt: ended,
    durationSec
  };
}

module.exports = {
  score_answer,
  next_question,
  buildInitialOrchestration,
  finalizeOrchestration
};
