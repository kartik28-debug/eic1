const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();

const { setupMarketMayhem } = require('./marketMayhemServer');
const { initMarketMayhemSchema } = require('./db/marketMayhemSchema');

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Trust reverse proxy on Render/cloud hosts to ensure secure cookies work over HTTPS
if (isProduction) {
  app.set('trust proxy', 1);
}

// ─── Production & Development CORS Configuration ───
function isAllowedOrigin(origin) {
  if (!origin) return true; // Same-origin or non-browser/curl requests
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/.*\.onrender\.com$/.test(origin)) return true;
  if (process.env.RENDER_EXTERNAL_URL && origin === process.env.RENDER_EXTERNAL_URL) return true;
  if (process.env.CLIENT_URL && origin === process.env.CLIENT_URL) return true;
  if (process.env.ALLOWED_ORIGINS) {
    const list = process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim());
    if (list.includes(origin)) return true;
  }
  return false;
}

const corsOptions = {
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  credentials: true
};

// Create HTTP server & Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions
});

// PostgreSQL Pool Connection (supports local without SSL and hosted Neon/Render with SSL)
const isLocalDb = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle pg client:', err.message || err);
});

// Auto-verify Market Mayhem DB Schema on startup
initMarketMayhemSchema(pool).catch(err => {
  console.error('Failed to initialize Market Mayhem DB Schema:', err);
});

// ─── Middleware ───
app.use(cors(corsOptions));
app.use(express.json());

// ─── Static files from Vite build (/dist) ───
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath, { extensions: ['html'] }));

// ─── Session Store (PostgreSQL-backed) ───
const sessionMiddleware = session({
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
    secure: isProduction, // secure cookies over HTTPS in production
    sameSite: 'lax'
  }
});

app.use(sessionMiddleware);

// Share session middleware with Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// ─── Explicit Root Route: Serve Vite Frontend (dist/index.html) ───
app.get('/', (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(500).json({
    status: 'error',
    message: 'Frontend dist/index.html not found. Please ensure npm run build was executed.'
  });
});

// ─── Health check route ───
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    message: 'EIC Backend is running with Market Mayhem Multiplayer Engine'
  });
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── MOUNT MARKET MAYHEM ENGINE ─────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
setupMarketMayhem(app, io, pool);

// ─── Fallback route for HTML / SPA navigation (excludes /api and /socket.io) ───
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next();
  }
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  next();
});

// ─── Start Server ───
server.listen(PORT, () => {
  console.log(`🚀 EIC Backend & Market Mayhem Server running on http://localhost:${PORT}`);
});
