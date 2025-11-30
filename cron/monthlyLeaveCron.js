const cron = require('node-cron');
const { accrueMonthlyLeave } = require('../services/leaveAccrualService');

const monthlyLeaveJob = cron.schedule('10 0 1 * *', async () => {
  console.log('[CRON] Starting monthly leave accrual job');
  try {
    const result = await accrueMonthlyLeave();
    console.log('[CRON] Monthly leave accrual completed', result);
  } catch (error) {
    console.error('[CRON] Monthly leave accrual failed', error);
  }
});

module.exports = monthlyLeaveJob;
