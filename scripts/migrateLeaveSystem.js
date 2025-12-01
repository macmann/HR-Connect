const { db } = require('../db');
const {
  computeAllLeaveBalances,
  getCurrentLeaveCycle: getCurrentLeaveCycleInfo,
  DEFAULT_ENTITLEMENTS
} = require('../utils/leaveAccrual');

async function migrateLeaveSystem(options = {}) {
  const migrationRunAt = options.now instanceof Date ? options.now : new Date();
  const { cycleStart, cycleEnd } = getCurrentLeaveCycleInfo(migrationRunAt);

  await db.read();
  db.data = db.data || {};
  db.data.employees = Array.isArray(db.data.employees) ? db.data.employees : [];
  db.data.applications = Array.isArray(db.data.applications) ? db.data.applications : [];
  db.data.holidays = Array.isArray(db.data.holidays) ? db.data.holidays : [];

  let processed = 0;

  for (const employee of db.data.employees) {
    if (!employee || typeof employee !== 'object') continue;
    processed += 1;

    ['annual', 'casual', 'medical'].forEach(type => {
      const field = `${type}LeaveEntitlement`;
      if (employee[field] === undefined || employee[field] === null) {
        employee[field] = DEFAULT_ENTITLEMENTS[type];
      }
    });

    const balances = await computeAllLeaveBalances(employee, {
      dateNow: migrationRunAt,
      applications: db.data.applications,
      holidays: db.data.holidays
    });

    employee.leaveBalances = balances;
    employee.leaveMigration = {
      lastRunAt: migrationRunAt,
      cycleStart,
      cycleEnd
    };
  }

  await db.write();

  console.log(`Leave migration complete: ${processed} employees processed.`);

  return { processed, cycleStart, cycleEnd };
}

module.exports = {
  migrateLeaveSystem
};

if (require.main === module) {
  migrateLeaveSystem()
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('Leave system migration failed:', error);
      process.exit(1);
    });
}
