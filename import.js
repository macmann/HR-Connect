// import.js
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { db, init } = require('./db');

const FALLBACK_EMPLOYEES = [
  {
    Name: 'Alex Lee',
    Email: 'alex.lee@example.com',
    Role: 'Manager',
    Status: 'Active',
    Department: 'People Operations',
    Position: 'HR Manager',
    Location: 'Kuala Lumpur',
    'Annual Leave': 12,
    'Casual Leave': 5,
    'Medical Leave': 14
  },
  {
    Name: 'Priya Nair',
    Email: 'priya.nair@example.com',
    Role: 'Employee',
    Status: 'Active',
    Department: 'Engineering',
    Position: 'Backend Engineer',
    Location: 'Bangalore',
    'Annual Leave': 10,
    'Casual Leave': 5,
    'Medical Leave': 12
  },
  {
    Name: 'Jordan Smith',
    Email: 'jordan.smith@example.com',
    Role: 'Employee',
    Status: 'Active',
    Department: 'Design',
    Position: 'Product Designer',
    Location: 'Remote',
    'Annual Leave': 8,
    'Casual Leave': 4,
    'Medical Leave': 10
  }
];

function readCsvRows(csvPath) {
  if (!csvPath) return [];
  const absolutePath = path.isAbsolute(csvPath)
    ? csvPath
    : path.join(__dirname, csvPath);
  if (!fs.existsSync(absolutePath)) {
    console.warn(`CSV file not found at ${absolutePath}. Falling back to sample employees.`);
    return [];
  }
  const csvText = fs.readFileSync(absolutePath, 'utf-8');
  return parse(csvText, { columns: true, skip_empty_lines: true });
}

(async () => {
  await init();
  await db.read();
  if (!db.data) db.data = { employees: [], applications: [], users: [] };

  const csvArgument = process.argv[2] || process.env.EMPLOYEE_CSV_PATH;
  const rows = readCsvRows(csvArgument);
  const sourceRows = rows.length ? rows : FALLBACK_EMPLOYEES;
  const start = Date.now();

  sourceRows.forEach((row, i) => {
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
    db.data.employees.push(employee);
    db.data.users.push({
      id,
      email: row['Email'],
      password: 'password123',
      role: row['Role']?.toLowerCase() === 'manager' ? 'manager' : 'employee',
      employeeId: id
    });
  });

  await db.write();
  console.log(`Imported ${sourceRows.length} employees${rows.length ? '' : ' (sample dataset)'}`);
})();
