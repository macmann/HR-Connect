const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { ObjectId } = require('mongodb');
const { getDatabase, db } = require('../db');

const router = express.Router();

const uploadDir = path.join(__dirname, '../uploads/cv');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const unique = `cv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    cb(null, `${unique}${ext}`);
  }
});

const allowedExtensions = new Set(['.pdf', '.doc', '.docx']);
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext || !allowedExtensions.has(ext)) {
      return cb(new Error('invalid_file_type'));
    }
    cb(null, true);
  }
});

function normalizePosition(position = {}) {
  const stringId = position._id ? position._id.toString() : undefined;
  const status = typeof position.status === 'string' && position.status.trim()
    ? position.status.trim()
    : 'Open';
  return {
    _id: stringId,
    id: position.id ?? stringId,
    title: position.title || '',
    department: position.department || '',
    location: position.location || '',
    employmentType: position.employmentType || '',
    description: position.description || '',
    requirements: position.requirements || '',
    createdAt: position.createdAt || null,
    status,
    isPublished: typeof position.isPublished === 'boolean'
      ? position.isPublished
      : status.toLowerCase() === 'open'
  };
}

function buildPublishedQuery() {
  return {
    $or: [
      { isPublished: true },
      { status: { $in: ['Open', 'open'] } },
      { isPublished: { $exists: false }, status: { $exists: false } }
    ]
  };
}

router.get('/positions', async (req, res) => {
  try {
    const database = getDatabase();
    const publishedQuery = buildPublishedQuery();
    const positions = await database
      .collection('positions')
      .find(publishedQuery, {
        projection: {
          title: 1,
          department: 1,
          location: 1,
          employmentType: 1,
          createdAt: 1,
          id: 1,
          status: 1,
          isPublished: 1
        }
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(positions.map(normalizePosition));
  } catch (error) {
    console.error('Failed to load public positions', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/positions/:id', async (req, res) => {
  let positionId;
  try {
    positionId = new ObjectId(req.params.id);
  } catch (error) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const database = getDatabase();
    const position = await database
      .collection('positions')
      .findOne({ _id: positionId, ...buildPublishedQuery() });

    if (!position) {
      return res.status(404).json({ error: 'position_not_found' });
    }

    res.json(normalizePosition(position));
  } catch (error) {
    console.error('Failed to load position details', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/positions/:id/apply', upload.single('cv'), async (req, res) => {
  let positionObjectId;
  try {
    positionObjectId = new ObjectId(req.params.id);
  } catch (error) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    const database = getDatabase();
    const positionsCollection = database.collection('positions');
    const candidatesCollection = database.collection('candidates');
    const applicationsCollection = database.collection('applications');

    const position = await positionsCollection.findOne({
      _id: positionObjectId,
      ...buildPublishedQuery()
    });
    if (!position) {
      return res.status(404).json({ error: 'position_not_found' });
    }

    const { fullName, email, phone, coverLetterText } = req.body || {};
    if (!fullName || !email || !phone || !req.file) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const cvFilename = req.file.filename;
    const cvFilePath = `/uploads/cv/${cvFilename}`;
    const now = new Date();

    const existingCandidate = await candidatesCollection.findOne({ email: email.trim().toLowerCase() });
    let candidateId = existingCandidate?._id;
    let candidateLegacyId = existingCandidate?.id;

    if (existingCandidate) {
      const contact = phone || email || existingCandidate.contact || '';
      const update = {
        contact,
        phone,
        name: fullName,
        fullName,
        positionId: position.id || existingCandidate.positionId,
        updatedAt: now,
        source: existingCandidate.source || 'careers_portal',
        cvFilePath,
        cvFilename: req.file.originalname || cvFilename,
        cvContentType: req.file.mimetype || null
      };
      if (!existingCandidate.id) {
        update.id = Date.now();
        candidateLegacyId = update.id;
      }
      await candidatesCollection.updateOne({ _id: existingCandidate._id }, { $set: update });
      candidateLegacyId = existingCandidate.id || candidateLegacyId || Date.now();
    } else {
      const contact = phone || email;
      const candidateDoc = {
        id: Date.now(),
        name: fullName,
        fullName,
        contact,
        email: email.trim().toLowerCase(),
        phone,
        positionId: position.id || null,
        status: 'New',
        source: 'careers_portal',
        cvFilePath,
        cvFilename: req.file.originalname || cvFilename,
        cvContentType: req.file.mimetype || null,
        createdAt: now,
        updatedAt: now,
        comments: []
      };
      const insertCandidate = await candidatesCollection.insertOne(candidateDoc);
      candidateId = insertCandidate.insertedId;
      candidateLegacyId = candidateDoc.id;
    }

    const applicationDoc = {
      candidateId,
      candidateLegacyId,
      positionId: positionObjectId,
      positionLegacyId: position.id || null,
      type: 'recruitment',
      status: 'applied',
      source: 'careers_portal',
      cvFilePath,
      cvFilename: req.file.originalname || cvFilename,
      coverLetterText: coverLetterText || null,
      createdAt: now,
      email: email.trim().toLowerCase(),
      phone,
      fullName
    };

    const applicationResult = await applicationsCollection.insertOne(applicationDoc);
    db.invalidateCache?.();

    return res.status(201).json({ applicationId: applicationResult.insertedId, status: 'received' });
  } catch (error) {
    console.error('Failed to submit application', error);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
