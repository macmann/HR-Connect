const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../db');
const { extractTextFromPdf } = require('../utils/cvParser');
const { analyzeCvAgainstJd } = require('../openaiClient');
const { loadAiSettings } = require('../aiSettings');

const router = express.Router();

function resolveObjectId(id) {
  try {
    return new ObjectId(id);
  } catch (err) {
    return null;
  }
}

function buildJdText(position = {}) {
  const parts = [];
  if (position.title) parts.push(`Title: ${position.title}`);
  if (position.department) parts.push(`Department: ${position.department}`);
  if (position.location) parts.push(`Location: ${position.location}`);
  if (position.employmentType) parts.push(`Employment Type: ${position.employmentType}`);
  if (position.description) parts.push(`Description:\n${position.description}`);
  if (position.requirements) parts.push(`Requirements:\n${position.requirements}`);

  return parts.join('\n') || 'No job description provided.';
}

router.post('/applications/:applicationId/ai-screening/run', async (req, res) => {
  const { applicationId } = req.params;
  const appObjectId = resolveObjectId(applicationId);
  if (!appObjectId) {
    return res.status(400).json({ success: false, error: 'invalid_application_id' });
  }

  try {
    const db = getDatabase();

    const application = await db.collection('applications').findOne({ _id: appObjectId });
    if (!application) {
      return res.status(404).json({ success: false, error: 'application_not_found' });
    }

    const candidateObjectId = resolveObjectId(application.candidateId);
    const positionObjectId = resolveObjectId(application.positionId);
    if (!candidateObjectId || !positionObjectId) {
      return res
        .status(400)
        .json({ success: false, error: 'application_missing_candidate_or_position' });
    }

    const [candidate, position] = await Promise.all([
      db.collection('candidates').findOne({ _id: candidateObjectId }),
      db.collection('positions').findOne({ _id: positionObjectId })
    ]);

    if (!candidate) {
      return res.status(404).json({ success: false, error: 'candidate_not_found' });
    }

    if (!position) {
      return res.status(404).json({ success: false, error: 'position_not_found' });
    }

    const embeddedCv = application.cv || candidate.cv;
    if (!embeddedCv && !application.cvFilePath && !application.cvFilePathAbsolute && !application.cvPath) {
      return res.status(400).json({ success: false, error: 'cv_not_found_for_application' });
    }

    if (!embeddedCv) {
      console.log(
        'Application CV paths:',
        application.cvFilePathAbsolute,
        application.cvFilePath,
        application.cvPath
      );
    }

    let cvText;
    try {
      cvText = await extractTextFromPdf(
        embeddedCv ||
        application.cvFilePathAbsolute ||
        application.cvFilePath ||
        application.cvPath
      );
    } catch (err) {
      console.error('Failed to extract text from CV for manual screening:', err);

      if (err && typeof err.message === 'string' && err.message.includes('CV file not found')) {
        return res.status(404).json({
          error: 'cv_not_found',
          message:
            'The CV file for this application is no longer available on the server. Please ask the candidate to re-upload their CV or submit a new application.'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'cv_parse_failed',
        message: 'Failed to extract CV text for AI screening.'
      });
    }

    let aiScreeningResult;
    try {
      const aiSettings = await loadAiSettings();
      aiScreeningResult = await analyzeCvAgainstJd(
        {
          cvText,
          jdText: buildJdText(position),
          positionTitle: position?.title,
          candidateName: candidate?.fullName || candidate?.name
        },
        {
          model: aiSettings.model,
          screeningPrompt: aiSettings.screeningPrompt
        }
      );
    } catch (err) {
      console.error('AI CV screening failed (manual trigger):', err);
      return res.status(500).json({ success: false, error: 'failed_to_analyze_cv' });
    }

    const aiScreeningAt = new Date();
    await db.collection('applications').updateOne(
      { _id: appObjectId },
      {
        $set: {
          aiScreeningResult,
          aiScreeningAt,
          aiScreeningManualTriggered: true
        }
      }
    );

    return res.json({ success: true, aiScreeningResult });
  } catch (err) {
    console.error('Error running manual AI CV screening:', err);
    return res.status(500).json({ success: false, error: 'failed_to_run_ai_screening' });
  }
});

module.exports = router;
