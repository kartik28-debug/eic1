const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function importStudents() {
  let client;
  try {
    client = await pool.connect();
    console.log('Successfully connected to Neon PostgreSQL database.');

    // 1. Ensure students table exists and contains all required columns
    await client.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        roll_number VARCHAR(30) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Safely migrate existing table columns if missing
    await client.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS name VARCHAR(150);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS roll_number VARCHAR(30);
      ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    // Safely add UNIQUE constraint on roll_number if missing
    try {
      await client.query(`
        ALTER TABLE students ADD CONSTRAINT students_roll_number_key UNIQUE (roll_number);
      `);
    } catch (e) {
      // Constraint already exists
    }

    console.log('Students table schema verified and migrated.');

    // 2. Find CSV file (check student.csv or students.csv)
    let csvPath = path.join(__dirname, 'data', 'students.csv');
    if (!fs.existsSync(csvPath)) {
      csvPath = path.join(__dirname, 'data', 'student.csv');
    }

    if (!fs.existsSync(csvPath)) {
      console.error(`Error: Student CSV file not found at ${csvPath}`);
      process.exit(1);
    }

    console.log(`Reading dataset from: ${csvPath}`);
    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const lines = fileContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    if (lines.length <= 1) {
      console.log('CSV file is empty or contains only headers.');
      process.exit(0);
    }

    // Skip header row
    const dataRows = lines.slice(1);

    let foundCount = dataRows.length;
    let insertedCount = 0;
    let alreadyExistedCount = 0;
    let failedCount = 0;

    console.log(`Starting processing for ${foundCount} student records...`);

    // 3. Process records
    for (const row of dataRows) {
      const lastCommaIndex = row.lastIndexOf(',');
      if (lastCommaIndex === -1) {
        failedCount++;
        continue;
      }

      const name = row.substring(0, lastCommaIndex).trim();
      const rollNumber = row.substring(lastCommaIndex + 1).trim();

      if (!name || !rollNumber) {
        failedCount++;
        continue;
      }

      try {
        // Hash the roll_number as initial password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(rollNumber, saltRounds);

        // Insert into database with ON CONFLICT (roll_number) DO NOTHING
        const result = await client.query(
          `INSERT INTO students (name, roll_number, password_hash, must_change_password)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (roll_number) DO NOTHING;`,
          [name, rollNumber, passwordHash]
        );

        if (result.rowCount > 0) {
          insertedCount++;
        } else {
          alreadyExistedCount++;
        }
      } catch (err) {
        console.error(`Failed to process ${name} (${rollNumber}):`, err.message);
        failedCount++;
      }
    }

    // 4. Report statistics
    console.log('\n--- IMPORT REPORT ---');
    console.log(`Students found in CSV: ${foundCount}`);
    console.log(`Students inserted: ${insertedCount}`);
    console.log(`Students already existed: ${alreadyExistedCount}`);
    console.log(`Students failed: ${failedCount}`);

    // 5. Verification Queries
    console.log('\n--- DATABASE VERIFICATION ---');
    const countRes = await client.query('SELECT COUNT(*) FROM students;');
    console.log(`Total students in database: ${countRes.rows[0].count}`);

    const sampleRes = await client.query(`
      SELECT id, name, roll_number, must_change_password
      FROM students
      ORDER BY id
      LIMIT 10;
    `);

    console.log('\nFirst 10 Student Records in Database:');
    console.table(sampleRes.rows);

  } catch (err) {
    console.error('Fatal error during student import:', err);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

importStudents();
