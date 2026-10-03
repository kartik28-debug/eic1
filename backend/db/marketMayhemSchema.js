/**
 * Market Mayhem Database Schema Setup
 * Creates the 12 required PostgreSQL tables for Market Mayhem simulation game.
 */

async function initMarketMayhemSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. games table
    await client.query(`
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        status VARCHAR(20) DEFAULT 'LOBBY',
        starting_cash NUMERIC(12, 2) DEFAULT 100000.00,
        max_team_size INT DEFAULT 4,
        round_timer_seconds INT DEFAULT 120,
        penalty_percentage NUMERIC(5, 2) DEFAULT 10.00,
        sebi_check_round INT DEFAULT 4,
        current_round INT DEFAULT 1,
        current_phase VARCHAR(20) DEFAULT 'LOBBY',
        allow_solo BOOLEAN DEFAULT TRUE,
        created_by INT REFERENCES students(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP,
        ended_at TIMESTAMP
      );
    `);

    // Safe migration: add allow_solo column if it does not already exist
    await client.query(`
      ALTER TABLE games ADD COLUMN IF NOT EXISTS allow_solo BOOLEAN DEFAULT TRUE;
    `);


    // 2. teams table
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        team_name VARCHAR(100) NOT NULL,
        team_code VARCHAR(10) NOT NULL,
        cash_balance NUMERIC(12, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(game_id, team_code)
      );
    `);

    // 3. team_members table
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        student_id INT REFERENCES students(id) ON DELETE CASCADE,
        display_name VARCHAR(100) NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(team_id, student_id)
      );
    `);

    // 4. stocks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        ticker VARCHAR(10) NOT NULL,
        sector VARCHAR(50) NOT NULL,
        description TEXT,
        volatility VARCHAR(20) DEFAULT 'Medium'
      );
    `);

    // 5. stock_prices table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_prices (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        stock_id INT REFERENCES stocks(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        price NUMERIC(10, 2) NOT NULL
      );
    `);

    // 6. holdings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS holdings (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        stock_id INT REFERENCES stocks(id) ON DELETE CASCADE,
        quantity INT NOT NULL DEFAULT 0,
        UNIQUE(team_id, stock_id)
      );
    `);

    // 7. trades table
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        stock_id INT REFERENCES stocks(id) ON DELETE CASCADE,
        type VARCHAR(10) NOT NULL,
        quantity INT NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        total_value NUMERIC(12, 2) NOT NULL,
        round_number INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 8. tips table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tips (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        stock_id INT REFERENCES stocks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        source_label VARCHAR(100) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        is_super_tip BOOLEAN DEFAULT FALSE,
        is_true BOOLEAN DEFAULT TRUE,
        effect_size NUMERIC(5, 2) DEFAULT 0.0,
        is_flagged BOOLEAN DEFAULT FALSE
      );
    `);

    // 9. team_tips table
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_tips (
        id SERIAL PRIMARY KEY,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        tip_id INT REFERENCES tips(id) ON DELETE CASCADE,
        purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        round_number INT NOT NULL,
        UNIQUE(team_id, tip_id)
      );
    `);

    // 10. round_events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS round_events (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        stock_id INT REFERENCES stocks(id) ON DELETE CASCADE,
        block_deal_text TEXT,
        news_text TEXT,
        true_price_change NUMERIC(5, 2) DEFAULT 0.0,
        noise NUMERIC(5, 2) DEFAULT 0.0
      );
    `);

    // 11. team_value_history table
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_value_history (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        cash_value NUMERIC(12, 2) NOT NULL,
        holdings_value NUMERIC(12, 2) NOT NULL,
        total_value NUMERIC(12, 2) NOT NULL
      );
    `);

    // 12. penalties table
    await client.query(`
      CREATE TABLE IF NOT EXISTS penalties (
        id SERIAL PRIMARY KEY,
        game_id INT REFERENCES games(id) ON DELETE CASCADE,
        team_id INT REFERENCES teams(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        reason TEXT NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query('COMMIT');
    console.log('✅ Market Mayhem database schema verified/created successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error initializing Market Mayhem schema:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initMarketMayhemSchema };
