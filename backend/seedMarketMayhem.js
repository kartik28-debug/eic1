/**
 * Market Mayhem Seed Script — Round 1 Configuration
 * Seeds five Round 1 companies (RELY, ADHI, TATV, INFY-R, SMBR),
 * 10 public news events, and 4 insider tips.
 *
 * SECURITY: true_price_change, noise, is_true, effect_size, is_flagged are
 * HOST/ENGINE ONLY and are NEVER sent to the player-facing API.
 *
 * Price guarantees (noise=0.00 for all Round 1 events):
 *   RELY   Rs2,880 -> Rs2,800.80  (-2.75%)
 *   ADHI   Rs2,350 -> Rs2,091.50  (-11.00%)
 *   TATV   Rs960   -> Rs1,065.60  (+11.00%)
 *   INFY-R Rs1,540 -> Rs1,586.20  (+3.00%)
 *   SMBR   Rs410   -> Rs465.35    (+13.50%)
 *
 * Run via: npm run seed-market-mayhem
 * Force-recreate: npm run seed-market-mayhem -- --force
 */

const { Pool } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });
const { initMarketMayhemSchema } = require('./db/marketMayhemSchema');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function seedMarketMayhem(forceRecreation = false) {
  console.log('🌱 Starting Market Mayhem Seeding...');
  await initMarketMayhemSchema(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if an existing default game exists
    const existingGame = await client.query("SELECT id FROM games WHERE name = 'Market Mayhem Season 1' LIMIT 1;");
    
    if (existingGame.rows.length > 0 && !forceRecreation) {
      console.log(`ℹ️ Default game 'Market Mayhem Season 1' already exists (ID: ${existingGame.rows[0].id}). Skipping seed.`);
      await client.query('COMMIT');
      return existingGame.rows[0].id;
    }

    if (existingGame.rows.length > 0 && forceRecreation) {
      console.log(`🧹 Force option set. Removing existing game ID ${existingGame.rows[0].id}...`);
      await client.query('DELETE FROM games WHERE id = $1;', [existingGame.rows[0].id]);
    }

    // 1. Create Default Game (Round 1 — sebi_check_round=1 since only 1 round)
    const gameRes = await client.query(`
      INSERT INTO games (
        name, status, starting_cash, max_team_size, round_timer_seconds, penalty_percentage, sebi_check_round, current_round, current_phase
      ) VALUES (
        'Market Mayhem Season 1', 'LOBBY', 100000.00, 4, 120, 10.00, 1, 1, 'LOBBY'
      ) RETURNING id;
    `);
    const gameId = gameRes.rows[0].id;
    console.log(`🎮 Created Game ID: ${gameId} — Round 1 configuration`);

    // 2. Insert 5 Round 1 Stocks
    const stocksData = [
      {
        name: 'Relyant Industries', ticker: 'RELY',
        sector: 'Energy, Retail, Telecom',
        description: 'Diversified conglomerate spanning energy distribution, organised retail, and telecom infrastructure across India.',
        volatility: 'Medium', initialPrice: 2880.00,
        historical: [2650.00, 2700.00, 2740.00, 2780.00, 2820.00, 2880.00]
      },
      {
        name: 'Adhira Ports & Infra', ticker: 'ADHI',
        sector: 'Ports, Airports, Power',
        description: 'Major infrastructure developer operating ports, airports, and power transmission projects across coastal India.',
        volatility: 'Medium', initialPrice: 2350.00,
        historical: [2100.00, 2150.00, 2200.00, 2250.00, 2300.00, 2350.00]
      },
      {
        name: 'Tatva Motors', ticker: 'TATV',
        sector: 'Automobiles',
        description: 'Passenger and commercial vehicle manufacturer known for its festive-season launches and growing EV portfolio.',
        volatility: 'Medium', initialPrice: 960.00,
        historical: [850.00, 870.00, 900.00, 920.00, 940.00, 960.00]
      },
      {
        name: 'Infyra Technologies', ticker: 'INFY-R',
        sector: 'IT Services',
        description: 'Mid-cap IT services firm specialising in cloud migration, enterprise software, and digital transformation contracts.',
        volatility: 'Low', initialPrice: 1540.00,
        historical: [1420.00, 1450.00, 1480.00, 1500.00, 1520.00, 1540.00]
      },
      {
        name: 'Sambar from Una', ticker: 'SMBR',
        sector: 'Food Services',
        description: 'Fast-growing regional food-service chain known for authentic South Indian cuisine, rapidly expanding into tier-2 cities.',
        volatility: 'High', initialPrice: 410.00,
        historical: [340.00, 355.00, 370.00, 385.00, 395.00, 410.00]
      }
    ];

    const stockMap = {};

    for (const s of stocksData) {
      const stockRes = await client.query(`
        INSERT INTO stocks (game_id, name, ticker, sector, description, volatility)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id;
      `, [gameId, s.name, s.ticker, s.sector, s.description, s.volatility]);

      const stockId = stockRes.rows[0].id;
      stockMap[s.ticker] = stockId;

      // Insert round 0 = reference/starting price shown to students
      await client.query(`
        INSERT INTO stock_prices (game_id, stock_id, round_number, price)
        VALUES ($1, $2, 0, $3);
      `, [gameId, stockId, s.initialPrice]);

      // Insert historical prices (rounds -5 to -1) for chart display
      for (let idx = 0; idx < s.historical.length; idx++) {
        await client.query(`
          INSERT INTO stock_prices (game_id, stock_id, round_number, price)
          VALUES ($1, $2, $3, $4);
        `, [gameId, stockId, -5 + idx, s.historical[idx]]);
      }
    }
    console.log('📈 5 Round 1 Stocks & Historical Prices Seeded.');

    // 3. Insert Round 1 News Events (2 per stock = 10 total)
    // SECURITY: true_price_change and noise are HOST/ENGINE ONLY.
    // The player API NEVER exposes these fields.
    // noise=0.00 ensures exact predetermined final prices.
    const roundEventsData = [
      // RELY (Final: -2.75%, noise=0)
      { round: 1, ticker: 'RELY', block_deal_text: null,
        news_text: "Relyant's retail arm reports its busiest month of store footfall this year, with festive-season stocking starting early.",
        true_price_change: -2.75, noise: 0.00 },
      { round: 1, ticker: 'RELY', block_deal_text: null,
        news_text: "Relyant's telecom unit says tariff talks with regulators have not started, so no pricing change is expected soon.",
        true_price_change: 0.00, noise: 0.00 },
      // ADHI (Final: -11.00%, noise=0)
      { round: 1, ticker: 'ADHI', block_deal_text: null,
        news_text: "Adhira's new port expansion is stuck waiting for approvals, and its financing costs keep rising as interest rates stay high.",
        true_price_change: -11.00, noise: 0.00 },
      { round: 1, ticker: 'ADHI', block_deal_text: null,
        news_text: 'Adhira signs a long-term cargo handling contract with a shipping line, adding steady port revenue over the coming years.',
        true_price_change: 0.00, noise: 0.00 },
      // TATV (Final: +11.00%, noise=0)
      { round: 1, ticker: 'TATV', block_deal_text: null,
        news_text: "Tatva's vehicle bookings are up sharply ahead of the festive season, and dealers report waiting lists on its top models.",
        true_price_change: 11.00, noise: 0.00 },
      { round: 1, ticker: 'TATV', block_deal_text: null,
        news_text: "Falling steel and aluminium prices are expected to improve Tatva's profit margins.",
        true_price_change: 0.00, noise: 0.00 },
      // INFY-R (Final: +3.00%, noise=0)
      { round: 1, ticker: 'INFY-R', block_deal_text: null,
        news_text: 'Infyra wins a cloud migration contract from a large European retailer.',
        true_price_change: 3.00, noise: 0.00 },
      { round: 1, ticker: 'INFY-R', block_deal_text: null,
        news_text: 'Infyra says some clients are delaying new technology spending until next year.',
        true_price_change: 0.00, noise: 0.00 },
      // SMBR (Final: +13.50%, noise=0)
      { round: 1, ticker: 'SMBR', block_deal_text: null,
        news_text: 'Sambar from Una opens three new outlets in smaller cities, and early crowds are strong.',
        true_price_change: 13.50, noise: 0.00 },
      { round: 1, ticker: 'SMBR', block_deal_text: null,
        news_text: 'A food-industry survey says people are eating out more often in smaller cities, a market Sambar already serves.',
        true_price_change: 0.00, noise: 0.00 }
    ];

    for (const ev of roundEventsData) {
      await client.query(`
        INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `, [
        gameId,
        ev.round,
        stockMap[ev.ticker],
        ev.block_deal_text,
        ev.news_text,
        ev.true_price_change,
        ev.noise
      ]);
    }
    console.log('📰 10 Round 1 News Events Seeded (2 per stock).');

    // 4. Insert 4 Round 1 Insider Tips
    // SECURITY: is_true, effect_size, is_flagged are HOST/ENGINE ONLY.
    // Player API never exposes stock_id, is_true, effect_size, or is_flagged.
    const tipsData = [
      {
        round: 1, ticker: 'SMBR', source: 'Board Member', price: 3000, isSuper: false,
        isTrue: true, effect: 11.0, isFlagged: false,
        text: 'Something big is coming for Sambar. Sources say a major supplier tie-up is about to be announced.'
      },
      {
        round: 1, ticker: 'ADHI', source: 'Middle Manager', price: 1500, isSuper: false,
        isTrue: true, effect: -5.0, isFlagged: false,
        text: "Adhira's expansion trouble is worse than the public news suggests. Lenders are getting nervous."
      },
      {
        round: 1, ticker: 'TATV', source: 'Clerk', price: 500, isSuper: false,
        isTrue: true, effect: 5.0, isFlagged: false,
        text: "Tatva's order book is stronger than reported, and a large fleet order may be on the way."
      },
      {
        round: 1, ticker: 'INFY-R', source: 'Clerk', price: 500, isSuper: false,
        isTrue: true, effect: 1.0, isFlagged: false,
        text: 'Infyra may land a small extra contract this month. Not a huge deal, but positive.'
      }
    ];

    for (const t of tipsData) {
      await client.query(`
        INSERT INTO tips (
          game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `, [
        gameId,
        t.round,
        stockMap[t.ticker],
        t.text,
        t.source,
        t.price,
        t.isSuper,
        t.isTrue,
        t.effect,
        t.isFlagged
      ]);
    }
    console.log('💡 12 Sample Tips (True, False, Super Tips & SEBI Flagged) Seeded.');

    await client.query('COMMIT');
    console.log('✅ Market Mayhem Seeding Completed Successfully!');
    return gameId;

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error seeding Market Mayhem:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Execute if run directly via CLI
if (require.main === module) {
  const force = process.argv.includes('--force');
  seedMarketMayhem(force)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { seedMarketMayhem };
