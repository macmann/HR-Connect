const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, db } = require('../db');
const { generateInterviewQuestionsForPosition } = require('../openaiClient');

const router = express.Router();

// TODO: Replace with actual authentication middleware when available.
// router.use(requireAuth);

function normalizePosition(position = {}) {
  const stringId = position._id ? position._id.toString() : undefined;
  return {
    _id: stringId,
    id: position.id ?? stringId,
    title: position.title || '',
    department: position.department || '',
    location: position.location || '',
    employmentType: position.employmentType || '',
    isPublished: Boolean(position.isPublished),
    createdAt: position.createdAt || null,
    description: position.description || '',
    requirements: position.requirements || '',
    aiInterviewQuestions: normalizeAiInterviewQuestions(position.aiInterviewQuestions)
  };
}

function normalizeAiInterviewQuestions(aiInterviewQuestions) {
  return Array.isArray(aiInterviewQuestions)
    ? aiInterviewQuestions
        .filter(q => q && typeof q.text === 'string' && q.text.trim().length > 0)
        .map((q, index) => ({
          id: q.id || `q${index + 1}`,
          text: q.text.trim()
        }))
    : [];
}

router.get('/positions', async (req, res) => {
  try {
    const database = getDatabase();
    const positions = await database
      .collection('positions')
      .find({}, {
        projection: {
          title: 1,
          department: 1,
          location: 1,
          employmentType: 1,
          isPublished: 1,
          createdAt: 1,
          id: 1,
          description: 1,
          requirements: 1,
          aiInterviewQuestions: 1
        }
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(positions.map(normalizePosition));
  } catch (error) {
    console.error('Failed to list positions', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/positions', async (req, res) => {
  try {
    const { body } = req;
    const title = (body.title || '').trim();
    const { aiInterviewQuestions } = body;
    const normalizedQuestions = normalizeAiInterviewQuestions(aiInterviewQuestions);
    if (!title) {
      return res.status(400).json({ error: 'title_required' });
    }

    const now = new Date();
    const document = {
      id: Date.now(),
      title,
      department: (body.department || '').trim(),
      location: (body.location || '').trim(),
      employmentType: (body.employmentType || '').trim(),
      description: (body.description || '').trim(),
      requirements: (body.requirements || '').trim(),
      isPublished: typeof body.isPublished === 'boolean' ? body.isPublished : false,
      createdAt: now,
      aiInterviewQuestions: normalizedQuestions
    };

    const database = getDatabase();
    const result = await database.collection('positions').insertOne(document);
    db.invalidateCache?.();

    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create position', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/positions/:id', async (req, res) => {
  const { id } = req.params;
  let objectId;
  try {
    objectId = new ObjectId(id);
  } catch (error) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const updates = {};
    const normalizedQuestions = normalizeAiInterviewQuestions(req.body.aiInterviewQuestions);
    const providedTitle = Object.prototype.hasOwnProperty.call(req.body, 'title');
    const providedDepartment = Object.prototype.hasOwnProperty.call(req.body, 'department');
    const providedLocation = Object.prototype.hasOwnProperty.call(req.body, 'location');
    const providedEmploymentType = Object.prototype.hasOwnProperty.call(req.body, 'employmentType');
    const providedDescription = Object.prototype.hasOwnProperty.call(req.body, 'description');
    const providedRequirements = Object.prototype.hasOwnProperty.call(req.body, 'requirements');
    const providedIsPublished = Object.prototype.hasOwnProperty.call(req.body, 'isPublished');

    if (providedTitle) {
      const title = (req.body.title || '').trim();
      if (!title) {
        return res.status(400).json({ error: 'title_required' });
      }
      updates.title = title;
    }
    if (providedDepartment) updates.department = (req.body.department || '').trim();
    if (providedLocation) updates.location = (req.body.location || '').trim();
    if (providedEmploymentType) updates.employmentType = (req.body.employmentType || '').trim();
    if (providedDescription) updates.description = (req.body.description || '').trim();
    if (providedRequirements) updates.requirements = (req.body.requirements || '').trim();
    if (providedIsPublished) updates.isPublished = Boolean(req.body.isPublished);
    updates.aiInterviewQuestions = normalizedQuestions;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    updates.updatedAt = new Date();

    const database = getDatabase();
    const result = await database
      .collection('positions')
      .updateOne({ _id: objectId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'position_not_found' });
    }

    db.invalidateCache?.();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update position', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/positions/:id/ai-questions/generate', async (req, res) => {
  try {
    const dbConn = getDatabase();
    const { id } = req.params;

    let position;
    try {
      position = await dbConn.collection('positions').findOne({ _id: new ObjectId(id) });
    } catch (e) {
      return res.status(400).json({ error: 'invalid_position_id' });
    }

    if (!position) {
      return res.status(404).json({ error: 'position_not_found' });
    }

    const questions = await generateInterviewQuestionsForPosition(position);

    return res.json({ questions });
  } catch (err) {
    console.error('Error generating AI interview questions:', err);
    return res.status(500).json({ error: 'failed_to_generate_questions' });
  }
});

module.exports = router;
