const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// PostgreSQL Pool Connection (Neon database SSL configuration)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// ─── Middleware ───
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests from any localhost port (Vite can pick 5173, 5174, etc.)
    // Also allow no-origin requests (curl, Postman)
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// ─── Session Store (PostgreSQL-backed) ───
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'eic-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: false, // set true in production with HTTPS
    sameSite: 'lax'
  }
}));

// ─── Root route ───
app.get('/', (req, res) => {
  res.json({ message: "EIC Backend is running" });
});

// ─── Database Connection Test ───
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as database_time;');
    res.json({
      success: true,
      databaseTime: result.rows[0].database_time
    });
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({
      success: false,
      message: "Database connection failed"
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── AUTH ENDPOINTS ──────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { roll_number, password } = req.body;

    if (!roll_number || !password) {
      return res.status(400).json({
        success: false,
        message: 'Roll number and password are required.'
      });
    }

    // Find student by roll number
    const result = await pool.query(
      'SELECT id, name, roll_number, password_hash, must_change_password FROM students WHERE roll_number = $1',
      [roll_number.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid roll number or password.'
      });
    }

    const student = result.rows[0];

    // Compare password with bcrypt hash
    const isMatch = await bcrypt.compare(password, student.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid roll number or password.'
      });
    }

    // Set session data
    req.session.userId = student.id;
    req.session.rollNumber = student.roll_number;
    req.session.name = student.name;
    req.session.mustChangePassword = student.must_change_password;

    return res.json({
      success: true,
      mustChangePassword: student.must_change_password,
      student: {
        name: student.name,
        rollNumber: student.roll_number
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    });
  }
});

// GET /api/auth/me — Check current authentication status
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      message: 'Not authenticated.'
    });
  }

  return res.json({
    success: true,
    authenticated: true,
    mustChangePassword: req.session.mustChangePassword || false,
    student: {
      name: req.session.name,
      rollNumber: req.session.rollNumber
    }
  });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated.'
      });
    }

    const { newPassword, confirmPassword } = req.body;

    if (!newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password and confirmation are required.'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match.'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long.'
      });
    }

    // Hash new password
    const saltRounds = 12;
    const newHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password and clear must_change_password flag
    await pool.query(
      'UPDATE students SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [newHash, req.session.userId]
    );

    // Update session
    req.session.mustChangePassword = false;

    return res.json({
      success: true,
      message: 'Password changed successfully.'
    });

  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({
        success: false,
        message: 'Logout failed.'
      });
    }
    res.clearCookie('connect.sid');
    return res.json({
      success: true,
      message: 'Logged out successfully.'
    });
  });
});

// ─── Start Server ───
app.listen(PORT, () => {
  console.log(`EIC Backend server running on http://localhost:${PORT}`);
});
