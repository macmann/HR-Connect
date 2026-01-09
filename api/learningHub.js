const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, db } = require('../db');
const {
  normalizeCourseStatus,
  buildCourse,
  buildModule,
  buildLesson,
  buildLessonAsset,
  buildCourseAssignments,
  applyCourseUpdates,
  applyModuleUpdates,
  applyLessonUpdates,
  applyAssetUpdates
} = require('../services/learningHubService');

const router = express.Router();

const HR_LEARNING_ROLES = new Set([
  'hr',
  'human resources',
  'l&d',
  'ld',
  'lnd',
  'learning and development',
  'learning & development'
]);

const MANAGER_ROLES = new Set(['manager', 'superadmin']);

function normalizeRole(role) {
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function getUserRoles(user) {
  if (!user) return [];
  if (Array.isArray(user.roles)) {
    return user.roles.map(normalizeRole).filter(Boolean);
  }
  const singleRole = normalizeRole(user.role);
  return singleRole ? [singleRole] : [];
}

function hasAnyRole(user, allowedRoles) {
  const roles = getUserRoles(user);
  return roles.some(role => allowedRoles.has(role));
}

function requireAuthenticatedUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  return next();
}

function requireLearningHubWriteAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  if (!hasAnyRole(req.user, HR_LEARNING_ROLES)) {
    return res.status(403).json({ error: 'learning_hub_write_forbidden' });
  }
  return next();
}

function requireProgressReadAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  const hasManagerRole = hasAnyRole(req.user, MANAGER_ROLES);
  const hasLearningRole = hasAnyRole(req.user, HR_LEARNING_ROLES);
  if (!hasManagerRole && !hasLearningRole) {
    return res.status(403).json({ error: 'learning_hub_progress_forbidden' });
  }
  return next();
}

// Access policy:
// - All endpoints require authenticated portal sessions.
// - Write endpoints (course/module/lesson/asset create/edit/publish/archive/reorder/assignments)
//   require HR/L&D roles.
// - Progress read endpoints allow HR/L&D and manager roles.
router.use(requireAuthenticatedUser);

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch (error) {
    return null;
  }
}

function normalizeDocument(document) {
  if (!document) return document;
  if (!document._id) return document;
  return { ...document, _id: document._id.toString() };
}

router.post('/courses', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { course, error } = buildCourse(req.body, { userId: req.user?.id });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningCourses').insertOne(course);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/courses/:id', requireLearningHubWriteAccess, async (req, res) => {
  const courseId = toObjectId(req.params.id);
  if (!courseId) {
    return res.status(400).json({ error: 'invalid_course_id' });
  }

  const { updates, error } = applyCourseUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  if (updates.status === 'published') {
    updates.publishedAt = updates.publishedAt || new Date();
    updates.archivedAt = null;
  }
  if (updates.status === 'archived') {
    updates.archivedAt = updates.archivedAt || new Date();
  }
  if (updates.status === 'draft') {
    updates.publishedAt = null;
    updates.archivedAt = null;
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningCourses')
      .updateOne({ _id: courseId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/courses/:id/publish', requireLearningHubWriteAccess, async (req, res) => {
  const courseId = toObjectId(req.params.id);
  if (!courseId) {
    return res.status(400).json({ error: 'invalid_course_id' });
  }

  try {
    const database = getDatabase();
    const updates = {
      status: 'published',
      publishedAt: new Date(),
      archivedAt: null,
      updatedAt: new Date()
    };
    const result = await database
      .collection('learningCourses')
      .updateOne({ _id: courseId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to publish course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/courses/:id/archive', requireLearningHubWriteAccess, async (req, res) => {
  const courseId = toObjectId(req.params.id);
  if (!courseId) {
    return res.status(400).json({ error: 'invalid_course_id' });
  }

  try {
    const database = getDatabase();
    const updates = {
      status: 'archived',
      archivedAt: new Date(),
      updatedAt: new Date()
    };
    const result = await database
      .collection('learningCourses')
      .updateOne({ _id: courseId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'course_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to archive course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/courses/:courseId/modules', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { module, error } = buildModule({
      ...req.body,
      courseId: req.params.courseId
    });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningModules').insertOne(module);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create module', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/modules/:id', requireLearningHubWriteAccess, async (req, res) => {
  const moduleId = toObjectId(req.params.id);
  if (!moduleId) {
    return res.status(400).json({ error: 'invalid_module_id' });
  }

  const { updates, error } = applyModuleUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningModules')
      .updateOne({ _id: moduleId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'module_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update module', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/modules/:moduleId/lessons', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { lesson, error } = buildLesson({
      ...req.body,
      moduleId: req.params.moduleId
    });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningLessons').insertOne(lesson);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create lesson', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/lessons/:id', requireLearningHubWriteAccess, async (req, res) => {
  const lessonId = toObjectId(req.params.id);
  if (!lessonId) {
    return res.status(400).json({ error: 'invalid_lesson_id' });
  }

  const { updates, error } = applyLessonUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningLessons')
      .updateOne({ _id: lessonId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'lesson_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update lesson', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/lessons/:lessonId/assets', requireLearningHubWriteAccess, async (req, res) => {
  try {
    const { asset, error } = buildLessonAsset({
      ...req.body,
      lessonId: req.params.lessonId
    });
    if (error) {
      return res.status(400).json({ error });
    }

    const database = getDatabase();
    const result = await database.collection('learningLessonAssets').insertOne(asset);
    db.invalidateCache?.();
    return res.status(201).json({ id: result.insertedId });
  } catch (error) {
    console.error('Failed to create lesson asset', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.put('/assets/:id', requireLearningHubWriteAccess, async (req, res) => {
  const assetId = toObjectId(req.params.id);
  if (!assetId) {
    return res.status(400).json({ error: 'invalid_asset_id' });
  }

  const { updates, error } = applyAssetUpdates(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const result = await database
      .collection('learningLessonAssets')
      .updateOne({ _id: assetId }, { $set: updates });

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'asset_not_found' });
    }

    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to update lesson asset', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/courses/:courseId/modules/reorder', requireLearningHubWriteAccess, async (req, res) => {
  const orderedModuleIds = Array.isArray(req.body.orderedModuleIds)
    ? req.body.orderedModuleIds
    : [];

  if (!orderedModuleIds.length) {
    return res.status(400).json({ error: 'ordered_module_ids_required' });
  }

  const orderMap = new Map();
  orderedModuleIds.forEach((id, index) => {
    const objectId = toObjectId(id);
    if (objectId) {
      orderMap.set(objectId.toString(), index);
    }
  });

  if (!orderMap.size) {
    return res.status(400).json({ error: 'invalid_module_ids' });
  }

  try {
    const database = getDatabase();
    const modules = await database
      .collection('learningModules')
      .find({
        _id: { $in: Array.from(orderMap.keys()).map(id => new ObjectId(id)) },
        courseId: String(req.params.courseId)
      })
      .toArray();

    if (modules.length !== orderMap.size) {
      return res.status(400).json({ error: 'module_course_mismatch' });
    }

    const bulkOps = modules.map(module => ({
      updateOne: {
        filter: { _id: module._id },
        update: { $set: { order: orderMap.get(module._id.toString()), updatedAt: new Date() } }
      }
    }));

    await database.collection('learningModules').bulkWrite(bulkOps, { ordered: true });
    db.invalidateCache?.();
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to reorder modules', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.post(
  '/modules/:moduleId/lessons/reorder',
  requireLearningHubWriteAccess,
  async (req, res) => {
    const orderedLessonIds = Array.isArray(req.body.orderedLessonIds)
      ? req.body.orderedLessonIds
      : [];

    if (!orderedLessonIds.length) {
      return res.status(400).json({ error: 'ordered_lesson_ids_required' });
    }

    const orderMap = new Map();
    orderedLessonIds.forEach((id, index) => {
      const objectId = toObjectId(id);
      if (objectId) {
        orderMap.set(objectId.toString(), index);
      }
    });

    if (!orderMap.size) {
      return res.status(400).json({ error: 'invalid_lesson_ids' });
    }

    try {
      const database = getDatabase();
      const lessons = await database
        .collection('learningLessons')
        .find({
          _id: { $in: Array.from(orderMap.keys()).map(id => new ObjectId(id)) },
          moduleId: String(req.params.moduleId)
        })
        .toArray();

      if (lessons.length !== orderMap.size) {
        return res.status(400).json({ error: 'lesson_module_mismatch' });
      }

      const bulkOps = lessons.map(lesson => ({
        updateOne: {
          filter: { _id: lesson._id },
          update: { $set: { order: orderMap.get(lesson._id.toString()), updatedAt: new Date() } }
        }
      }));

      await database.collection('learningLessons').bulkWrite(bulkOps, { ordered: true });
      db.invalidateCache?.();
      return res.json({ success: true });
    } catch (error) {
      console.error('Failed to reorder lessons', error);
      return res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/assignments', requireLearningHubWriteAccess, async (req, res) => {
  const { assignments, error } = buildCourseAssignments(req.body, {
    assignedBy: req.user?.id
  });
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const database = getDatabase();
    const bulkOps = assignments.map(assignment => ({
      updateOne: {
        filter: {
          courseId: assignment.courseId,
          assignmentType: assignment.assignmentType,
          role: assignment.role,
          employeeId: assignment.employeeId
        },
        update: { $set: assignment },
        upsert: true
      }
    }));

    await database.collection('learningCourseAssignments').bulkWrite(bulkOps, { ordered: true });
    db.invalidateCache?.();
    return res.status(201).json({ count: assignments.length });
  } catch (error) {
    console.error('Failed to assign course', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/progress', requireProgressReadAccess, async (req, res) => {
  try {
    const { employeeId, courseId } = req.query;
    const query = {};

    if (employeeId) {
      query.employeeId = String(employeeId);
    }
    if (courseId) {
      query.courseId = String(courseId);
    }

    const database = getDatabase();
    const progress = await database
      .collection('learningProgress')
      .find(query)
      .sort({ updatedAt: -1 })
      .toArray();

    return res.json(progress.map(normalizeDocument));
  } catch (error) {
    console.error('Failed to read progress', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/courses', async (req, res) => {
  try {
    const database = getDatabase();
    const statusFilter = normalizeCourseStatus(req.query.status);
    const query = statusFilter ? { status: statusFilter } : {};
    const courses = await database
      .collection('learningCourses')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(courses.map(normalizeDocument));
  } catch (error) {
    console.error('Failed to list courses', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
