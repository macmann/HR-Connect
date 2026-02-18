// leave-system/db.js
const { MongoClient } = require('mongodb');
const { performance } = require('perf_hooks');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB || 'brillarhrportal';

const mongoClientOptions = {
  serverSelectionTimeoutMS: Number(
    process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 30000
  )
};

const forceTls = process.env.MONGODB_FORCE_TLS === 'true';
if (forceTls || MONGODB_URI.startsWith('mongodb+srv://')) {
  mongoClientOptions.tls = true;
}

if (process.env.MONGODB_TLS_ALLOW_INVALID_CERTS === 'true') {
  mongoClientOptions.tlsAllowInvalidCertificates = true;
  mongoClientOptions.tlsAllowInvalidHostnames = true;
}

const client = new MongoClient(MONGODB_URI, mongoClientOptions);
let database;

const DB_CACHE_TTL_MS = Number(process.env.DB_CACHE_TTL_MS || 0);
let lastLoadedAt = 0;
let readPromise = null;

function logDbTrace(message, meta) {
  const timestamp = new Date().toISOString();
  const serializedMeta =
    meta && Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : '';
  console.log(`[DB TRACE] ${timestamp} ${message}${serializedMeta}`);
}

function sanitizeMongoUri(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.username) {
      parsed.username = '***';
    }
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch (error) {
    return uri.replace(/:\/\/[^@]*@/, '://***@');
  }
}

async function init() {
  if (!database) {
    logDbTrace('Connecting to MongoDB', {
      uri: sanitizeMongoUri(MONGODB_URI),
      db: DB_NAME,
      tls: Boolean(mongoClientOptions.tls),
      tlsAllowInvalidCertificates: mongoClientOptions.tlsAllowInvalidCertificates
    });
    const start = performance.now();
    try {
      await client.connect();
      logDbTrace('MongoDB connection established', {
        durationMs: Number((performance.now() - start).toFixed(2))
      });
    } catch (error) {
      logDbTrace('MongoDB connection failed', {
        durationMs: Number((performance.now() - start).toFixed(2)),
        error: error.message
      });
      throw error;
    }
    database = client.db(DB_NAME);
  }
}

function getDatabase() {
  if (!database) {
    throw new Error('Database connection has not been initialized');
  }
  return database;
}

async function syncCollection(name, docs = []) {
  await init();
  const collection = database.collection(name);
  const documents = Array.isArray(docs)
    ? docs.filter(doc => doc && typeof doc === 'object')
    : [];

  if (!documents.length) {
    await collection.deleteMany({});
    return;
  }

  const docsWithId = [];
  const docsWithoutId = [];

  documents.forEach(doc => {
    if (doc && doc._id) {
      docsWithId.push(doc);
    } else if (doc) {
      docsWithoutId.push(doc);
    }
  });

  if (docsWithId.length) {
    const operations = docsWithId.map(doc => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true
      }
    }));
    if (operations.length) {
      await collection.bulkWrite(operations, { ordered: true });
    }
  }

  if (docsWithoutId.length) {
    const docsToInsert = docsWithoutId.map(doc => {
      const copy = { ...doc };
      delete copy._id;
      return copy;
    });
    if (docsToInsert.length) {
      const insertResult = await collection.insertMany(docsToInsert);
      const insertedIds = insertResult.insertedIds || {};
      docsWithoutId.forEach((doc, idx) => {
        const insertedId = insertedIds[idx] || insertedIds[String(idx)];
        if (insertedId) {
          doc._id = insertedId;
        }
      });
    }
  }

  const idsToKeep = documents
    .map(doc => (doc && doc._id ? doc._id : null))
    .filter(Boolean);

  if (idsToKeep.length) {
    await collection.deleteMany({ _id: { $nin: idsToKeep } });
  } else {
    await collection.deleteMany({});
  }
}

async function syncSettings(settings = {}) {
  await init();
  const collection = database.collection('settings');
  const entries = Object.entries(settings || {}).filter(([key]) => key);

  if (!entries.length) {
    await collection.deleteMany({});
    return;
  }

  const operations = entries.map(([key, value]) => ({
    updateOne: {
      filter: { _id: key },
      update: { $set: { value } },
      upsert: true
    }
  }));

  if (operations.length) {
    await collection.bulkWrite(operations, { ordered: true });
  }

  const keepIds = entries.map(([key]) => key);
  await collection.deleteMany({ _id: { $nin: keepIds } });
}

const db = {
  data: null,
  async read(options = {}) {
    await init();
    let force = false;
    if (typeof options === 'boolean') {
      force = options;
    } else if (options && typeof options === 'object' && options.force) {
      force = true;
    }

    const now = Date.now();
    if (
      !force &&
      this.data &&
      (!DB_CACHE_TTL_MS || now - lastLoadedAt < DB_CACHE_TTL_MS)
    ) {
      logDbTrace('DB cache hit', { ageMs: now - lastLoadedAt });
      return;
    }

    if (readPromise) {
      logDbTrace('Awaiting in-flight DB read');
      await readPromise;
      return;
    }

    logDbTrace('DB cache miss - refreshing', {
      force,
      cacheAgeMs: this.data ? now - lastLoadedAt : null
    });

    const fetchCollection = async name => {
      const collectionStart = performance.now();
      logDbTrace('Fetching collection', { name });
      try {
        const docs = await database.collection(name).find().toArray();
        logDbTrace('Fetched collection', {
          name,
          durationMs: Number((performance.now() - collectionStart).toFixed(2)),
          documents: docs.length
        });
        return docs;
      } catch (error) {
        logDbTrace('Failed to fetch collection', {
          name,
          durationMs: Number((performance.now() - collectionStart).toFixed(2)),
          error: error.message
        });
        throw error;
      }
    };

    const readStart = performance.now();

    readPromise = (async () => {
      const [
        employees,
        applications,
        requests,
        users,
        positions,
        candidates,
        holidays,
        settingsDocs,
        salaries,
        performanceReviews,
        learningCourses,
        learningModules,
        learningLessons,
        learningLessonAssets,
        learningCourseAssignments,
        learningRoleAssignments,
        learningProgress
      ] = await Promise.all([
        fetchCollection('employees'),
        fetchCollection('applications'),
        fetchCollection('requests'),
        fetchCollection('users'),
        fetchCollection('positions'),
        fetchCollection('candidates'),
        fetchCollection('holidays'),
        fetchCollection('settings'),
        fetchCollection('salaries'),
        fetchCollection('performanceReviews'),
        fetchCollection('learningCourses'),
        fetchCollection('learningModules'),
        fetchCollection('learningLessons'),
        fetchCollection('learningLessonAssets'),
        fetchCollection('learningCourseAssignments'),
        fetchCollection('learningRoleAssignments'),
        fetchCollection('learningProgress')
      ]);
      const recruitmentApplications = Array.isArray(applications)
        ? applications.filter(app => app && app.type === 'recruitment')
        : [];
      const leaveApplications = Array.isArray(applications)
        ? applications.filter(app => !app || app.type !== 'recruitment')
        : [];
      const settings = {};
      settingsDocs.forEach(doc => {
        if (!doc || (!doc._id && !doc.key)) return;
        const key = doc._id || doc.key;
        settings[key] = doc.value;
      });
      this.data = {
        employees,
        applications: leaveApplications,
        requests,
        recruitmentApplications,
        users,
        positions,
        candidates,
        holidays,
        settings,
        salaries,
        performanceReviews,
        learningCourses,
        learningModules,
        learningLessons,
        learningLessonAssets,
        learningCourseAssignments,
        learningRoleAssignments,
        learningProgress
      };
      lastLoadedAt = Date.now();
      logDbTrace('DB read completed', {
        durationMs: Number((performance.now() - readStart).toFixed(2))
      });
    })();

    try {
      await readPromise;
    } finally {
      readPromise = null;
    }
  },
  async write() {
    if (!this.data) return;

    const {
      employees = [],
      applications = [],
      requests = [],
      recruitmentApplications = [],
      users = [],
      positions = [],
      candidates = [],
      holidays = [],
      settings = {},
      salaries = [],
      performanceReviews = [],
      learningCourses = [],
      learningModules = [],
      learningLessons = [],
      learningLessonAssets = [],
      learningCourseAssignments = [],
      learningRoleAssignments = [],
      learningProgress = []
    } = this.data;

    const mergedApplications = [
      ...(Array.isArray(applications) ? applications : []),
      ...(Array.isArray(recruitmentApplications) ? recruitmentApplications : [])
    ];

    await Promise.all([
      syncCollection('employees', employees),
      syncCollection('applications', mergedApplications),
      syncCollection('requests', requests),
      syncCollection('users', users),
      syncCollection('positions', positions),
      syncCollection('candidates', candidates),
      syncCollection('holidays', holidays),
      syncSettings(settings),
      syncCollection('salaries', salaries),
      syncCollection('performanceReviews', performanceReviews),
      syncCollection('learningCourses', learningCourses),
      syncCollection('learningModules', learningModules),
      syncCollection('learningLessons', learningLessons),
      syncCollection('learningLessonAssets', learningLessonAssets),
      syncCollection('learningCourseAssignments', learningCourseAssignments),
      syncCollection('learningRoleAssignments', learningRoleAssignments),
      syncCollection('learningProgress', learningProgress)
    ]);
    lastLoadedAt = Date.now();
  },
  invalidateCache() {
    this.data = null;
    lastLoadedAt = 0;
    readPromise = null;
  }
};

module.exports = { db, init, getDatabase };
