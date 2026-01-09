const cron = require('node-cron');
const { reconcileLearningRoleAssignments } = require('../services/learningRoleAssignmentService');

const learningRoleAssignmentJob = cron.schedule('15 * * * *', async () => {
  console.log('[CRON] Starting learning role assignment reconciliation');
  try {
    const result = await reconcileLearningRoleAssignments();
    console.log('[CRON] Learning role assignment reconciliation completed', result);
  } catch (error) {
    console.error('[CRON] Learning role assignment reconciliation failed', error);
  }
});

module.exports = learningRoleAssignmentJob;
