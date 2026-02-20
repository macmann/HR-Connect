const SCORING_VERSION = 'voice-option-b-v1';
const RUBRIC_VERSION = 'voice-rubric-v1';

function clampScore(value, min = 1, max = 5) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteFromAnswer(answerText) {
  const normalized = normalizeText(answerText).replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function inferCompetency(question) {
  if (!question || typeof question !== 'object') return 'general';
  return (
    question.competency ||
    question.category ||
    question.topic ||
    question.dimension ||
    'general'
  );
}

function buildCoverageUpdate(currentCoverage, competency, score) {
  const existing = currentCoverage?.[competency] || {
    answerCount: 0,
    totalScore: 0,
    averageScore: 0,
    latestScore: null
  };

  const answerCount = existing.answerCount + 1;
  const totalScore = existing.totalScore + score;

  return {
    ...currentCoverage,
    [competency]: {
      answerCount,
      totalScore,
      averageScore: Number((totalScore / answerCount).toFixed(2)),
      latestScore: score
    }
  };
}

function pickDifficulty(currentDifficulty, score) {
  if (score >= 4) return 'hard';
  if (score <= 2) return 'easy';
  return currentDifficulty || 'medium';
}

function scoreAnswer({ answerText, competency, turnId, questionId, difficulty }) {
  const normalizedAnswer = normalizeText(answerText);
  const wordCount = normalizedAnswer ? normalizedAnswer.split(/\s+/).length : 0;

  let baseScore = 1;
  if (wordCount >= 15) baseScore += 1;
  if (wordCount >= 35) baseScore += 1;
  if (wordCount >= 60) baseScore += 1;
  if (/\b(example|because|result|impact|improved|delivered|learned)\b/i.test(normalizedAnswer)) {
    baseScore += 1;
  }

  const finalScore = clampScore(baseScore);

  return {
    score: finalScore,
    competency: competency || 'general',
    questionId: questionId || null,
    turnId: turnId || null,
    assessedAt: new Date(),
    difficultyAfter: pickDifficulty(difficulty, finalScore),
    evidenceCandidate: {
      quote: quoteFromAnswer(normalizedAnswer),
      turnId: turnId || null,
      competency: competency || 'general',
      questionId: questionId || null,
      score: finalScore
    }
  };
}

function buildVoiceResult({ session, candidateId, applicationId, positionId }) {
  const orchestration = session?.orchestration || {};
  const coverage = orchestration.coverage || {};
  const competencyKeys = Object.keys(coverage);
  const competencyAverages = competencyKeys
    .map(key => Number(coverage[key]?.averageScore || 0))
    .filter(value => Number.isFinite(value) && value > 0);

  const overall = competencyAverages.length
    ? Number((competencyAverages.reduce((sum, value) => sum + value, 0) / competencyAverages.length).toFixed(2))
    : 0;

  const verdict = overall >= 4 ? 'proceed' : overall >= 3 ? 'hold' : 'reject';
  const evidence = Array.isArray(orchestration.evidenceCandidates)
    ? orchestration.evidenceCandidates.filter(item => item?.quote)
    : [];

  return {
    sessionId: session._id,
    applicationId,
    candidateId,
    positionId,
    mode: 'voice',
    scores: {
      overall,
      communication: coverage.communication?.averageScore ?? null,
      technical: coverage.technical?.averageScore ?? null,
      cultureFit: coverage['culture-fit']?.averageScore ?? coverage.cultureFit?.averageScore ?? null
    },
    verdict,
    summary: `Voice interview completed with ${evidence.length} evidence snippet(s).`,
    strengths: competencyKeys.filter(key => (coverage[key]?.averageScore || 0) >= 4),
    risks: competencyKeys.filter(key => (coverage[key]?.averageScore || 0) <= 2.5),
    recommendedNextSteps: ['Review evidence snippets before advancing candidate.'],
    evidence,
    timeline: {
      startedAt: orchestration.startedAt || session.voice?.startedAt || session.startedAt || null,
      endedAt: orchestration.endedAt || session.voice?.endedAt || session.completedAt || null,
      durationSec: Number.isFinite(orchestration.durationSec)
        ? orchestration.durationSec
        : session.voice?.durationSec ?? null
    },
    promptVersion: orchestration.promptVersion || process.env.PUBLIC_AI_VOICE_PROMPT_VERSION || 'voice-prompt-v1',
    scoringVersion: orchestration.scoringVersion || SCORING_VERSION,
    rubricVersion: orchestration.rubricVersion || RUBRIC_VERSION,
    rawModelResponse: null,
    createdAt: new Date()
  };
}

module.exports = {
  SCORING_VERSION,
  RUBRIC_VERSION,
  inferCompetency,
  buildCoverageUpdate,
  scoreAnswer,
  buildVoiceResult
};
