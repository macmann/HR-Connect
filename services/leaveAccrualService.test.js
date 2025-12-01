const { test } = require('node:test');
const assert = require('assert');

const {
  buildEmployeeLeaveState,
  getCurrentCycleRange,
  roundToOneDecimal
} = require('./leaveAccrualService');

function createEmployee(startDate, endDate) {
  return {
    id: 1,
    internshipStartDate: startDate,
    endDate
  };
}

function runState(employee, applications, asOfDate) {
  const cycleRange = getCurrentCycleRange(asOfDate);
  const { balances } = buildEmployeeLeaveState(employee, applications, {
    asOfDate,
    cycleRange,
    holidays: []
  });
  return balances;
}

function leaveApplication(employeeId, type, from, to) {
  return { employeeId, type, from, to, status: 'approved' };
}

test('Full cycle accrual without leave produces full entitlement', () => {
  const asOfDate = new Date('2025-06-30');
  const employee = createEmployee(new Date('2020-01-01'));
  const balances = runState(employee, [], asOfDate);

  assert.equal(balances.annual.balance, 10);
  assert.equal(balances.casual.balance, 5);
  assert.equal(balances.medical.balance, 14);
});

test('Full cycle accrual with taken leave reduces balances', () => {
  const asOfDate = new Date('2025-06-30');
  const employee = createEmployee(new Date('2020-01-01'));
  const apps = [
    leaveApplication(employee.id, 'annual', '2024-10-07', '2024-10-08'),
    leaveApplication(employee.id, 'casual', '2025-03-10', '2025-03-10')
  ];

  const balances = runState(employee, apps, asOfDate);

  assert.equal(balances.annual.balance, 8);
  assert.equal(balances.casual.balance, 4);
  assert.equal(balances.medical.balance, 14);
});

test('Mid-cycle joining only accrues for active months', () => {
  const asOfDate = new Date('2025-06-30');
  const employee = createEmployee(new Date('2024-11-15'));
  const balances = runState(employee, [], asOfDate);

  assert.equal(balances.annual.balance, roundToOneDecimal((10 / 12) * 8));
  assert.equal(balances.casual.balance, roundToOneDecimal((5 / 12) * 8));
  assert.equal(balances.medical.balance, roundToOneDecimal((14 / 12) * 8));
});

test('Mid-cycle departure stops accrual after exit month', () => {
  const asOfDate = new Date('2025-03-01');
  const employee = createEmployee(new Date('2024-07-01'), new Date('2025-01-10'));
  const balances = runState(employee, [], asOfDate);

  assert.equal(balances.annual.balance, roundToOneDecimal((10 / 12) * 7));
  assert.equal(balances.casual.balance, roundToOneDecimal((5 / 12) * 7));
  assert.equal(balances.medical.balance, roundToOneDecimal((14 / 12) * 7));
});

test('Negative balances are produced when leave exceeds accrual', () => {
  const asOfDate = new Date('2024-12-31');
  const employee = createEmployee(new Date('2024-07-01'));
  const apps = [leaveApplication(employee.id, 'annual', '2024-09-02', '2024-09-09')];

  const balances = runState(employee, apps, asOfDate);

  assert(balances.annual.balance < 0);
});

test('Recalculation is idempotent for the same inputs', () => {
  const asOfDate = new Date('2025-06-30');
  const employee = createEmployee(new Date('2024-07-01'));
  const balancesFirst = runState(employee, [], asOfDate);
  const balancesSecond = runState(employee, [], asOfDate);

  assert.deepStrictEqual(balancesFirst, balancesSecond);
});

test('Accrued balances are capped at the yearly allocation', () => {
  const asOfDate = new Date('2025-07-31');
  const cycleRange = {
    start: new Date('2024-07-01'),
    end: new Date('2025-07-31')
  };
  const employee = createEmployee(new Date('2020-01-01'));
  const { balances } = buildEmployeeLeaveState(employee, [], { cycleRange, asOfDate, holidays: [] });

  assert.equal(balances.annual.balance, 10);
  assert.equal(balances.casual.balance, 5);
  assert.equal(balances.medical.balance, 14);
});
