// import.js
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { db, init } = require('./db');

const MONTH_LOOKUP = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11
};

function parseEmployeeDate(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const str = String(value).trim();
  if (!str) return null;
  const lowered = str.toLowerCase();
  if (['current', 'present', 'n/a', 'na', 'yes', 'no'].includes(lowered)) return null;

  const dashMatch = str.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (dashMatch) {
    const day = Number(dashMatch[1]);
    const monthKey = dashMatch[2].slice(0, 3).toLowerCase();
    const monthIndex = MONTH_LOOKUP[monthKey];
    const rawYear = Number(dashMatch[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (Number.isInteger(day) && Number.isInteger(monthIndex) && Number.isInteger(year)) {
      const parsed = new Date(year, monthIndex, day);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getEmployeeDateValue(employee, keys = []) {
  if (!employee || typeof employee !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(employee, key)) {
      const parsed = parseEmployeeDate(employee[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function normalizeEmployeeDateFields(employee) {
  if (!employee || typeof employee !== 'object') return;

  const internshipStart = getEmployeeDateValue(employee, [
    'internshipStartDate',
    'Start Date - Internship or Probation'
  ]);
  const fullTimeStart = getEmployeeDateValue(employee, [
    'fullTimeStartDate',
    'startDate',
    'start_date',
    'Start Date - Full Time'
  ]);
  const internshipEnd = getEmployeeDateValue(employee, [
    'internshipEndDate',
    'End Date - Internship or Probation'
  ]);
  const fullTimeEnd = getEmployeeDateValue(employee, [
    'fullTimeEndDate',
    'endDate',
    'end_date',
    'End Date - Full Time'
  ]);

  if (internshipStart) {
    employee.internshipStartDate = internshipStart;
  }
  if (fullTimeStart) {
    employee.fullTimeStartDate = fullTimeStart;
  }
  if (!employee.startDate && (internshipStart || fullTimeStart)) {
    employee.startDate = internshipStart || fullTimeStart;
  } else if (employee.startDate) {
    const parsed = parseEmployeeDate(employee.startDate);
    if (parsed) employee.startDate = parsed;
  }

  if (internshipEnd) {
    employee.internshipEndDate = internshipEnd;
  }
  if (fullTimeEnd) {
    employee.fullTimeEndDate = fullTimeEnd;
  }

  const derivedEnd = fullTimeEnd || (!fullTimeStart && internshipEnd ? internshipEnd : null);
  if (!employee.endDate && derivedEnd) {
    employee.endDate = derivedEnd;
  } else if (employee.endDate) {
    const parsed = parseEmployeeDate(employee.endDate);
    if (parsed) employee.endDate = parsed;
  }
}

(async () => {
  await init();
  await db.read();
  if (!db.data) db.data = { employees: [], applications: [], users: [] };

  const csvPath = path.join(__dirname, 'BrillarEmployees.csv');
  const csvText = fs.readFileSync(csvPath, 'utf-8');
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  const start = Date.now();

  rows.forEach((row, i) => {
    const id = start + i;
    const employee = {
      id,
      name: row['Name'],
      status: row.Status?.toLowerCase() === 'inactive' ? 'inactive' : 'active',
      leaveBalances: {
        annual: {
          balance: Number(row['Annual Leave'] ?? 0),
          yearlyAllocation: 10,
          monthlyAccrual: 10 / 12,
          accrued: 0,
          taken: 0
        },
        casual: {
          balance: Number(row['Casual Leave'] ?? 0),
          yearlyAllocation: 5,
          monthlyAccrual: 5 / 12,
          accrued: 0,
          taken: 0
        },
        medical: {
          balance: Number(row['Medical Leave'] ?? 0),
          yearlyAllocation: 14,
          monthlyAccrual: 14 / 12,
          accrued: 0,
          taken: 0
        },
        cycleStart: null,
        cycleEnd: null,
        lastAccrualRun: null
      },
      ...row
    };
    delete employee._id;
    normalizeEmployeeDateFields(employee);
    db.data.employees.push(employee);
    db.data.users.push({
      id,
      email: row['Email'],
      password: 'brillar',
      role: row['Role']?.toLowerCase() === 'manager' ? 'manager' : 'employee',
      employeeId: id
    });
  });

  await db.write();
  console.log(`Imported ${rows.length} employees`);
})();
