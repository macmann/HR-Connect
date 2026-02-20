const { init, getDatabase } = require('../db');

async function run() {
  await init();
  const db = getDatabase();

  const sessionFilter = {
    $or: [{ mode: { $exists: false } }, { mode: null }, { mode: '' }]
  };

  const sessionUpdate = await db.collection('ai_interview_sessions').updateMany(sessionFilter, {
    $set: { mode: 'text' }
  });

  const resultFilter = {
    $or: [
      { 'metadata.mode': { $exists: false } },
      { 'metadata.mode': null },
      { 'metadata.mode': '' }
    ]
  };

  const cursor = db.collection('ai_interview_results').find(resultFilter, {
    projection: { _id: 1, sessionId: 1 }
  });

  let updatedResults = 0;
  while (await cursor.hasNext()) {
    const result = await cursor.next();
    if (!result) continue;

    let mode = 'text';
    if (result.sessionId) {
      const session = await db
        .collection('ai_interview_sessions')
        .findOne({ _id: result.sessionId }, { projection: { mode: 1 } });
      if (session?.mode === 'voice') {
        mode = 'voice';
      }
    }

    const write = await db.collection('ai_interview_results').updateOne(
      { _id: result._id },
      { $set: { 'metadata.mode': mode } }
    );

    if (write.modifiedCount) {
      updatedResults += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        sessionsMatched: sessionUpdate.matchedCount,
        sessionsUpdated: sessionUpdate.modifiedCount,
        resultsUpdated: updatedResults
      },
      null,
      2
    )
  );
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Failed to backfill AI interview mode fields:', err);
    process.exit(1);
  });
