/**
 * Market Mayhem Seed Script
 * Seeds fictional stocks, historical prices, round events, and tips for a default game session.
 * Run via: npm run seed-market-mayhem
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

    // 1. Create Default Game
    const gameRes = await client.query(`
      INSERT INTO games (
        name, status, starting_cash, max_team_size, round_timer_seconds, penalty_percentage, sebi_check_round, current_round, current_phase
      ) VALUES (
        'Market Mayhem Season 1', 'LOBBY', 100000.00, 4, 120, 10.00, 4, 1, 'LOBBY'
      ) RETURNING id;
    `);
    const gameId = gameRes.rows[0].id;
    console.log(`🎮 Created Game ID: ${gameId}`);

    // 2. Insert 5 Fictional Stocks
    const stocksData = [
      {
        name: 'Nexora Bank',
        ticker: 'NXB',
        sector: 'Banking',
        description: 'Digital-first banking platform serving tech startups, MSMEs, and young professionals across India.',
        volatility: 'Medium',
        initialPrice: 1200.00,
        historical: [1050.00, 1100.00, 1140.00, 1120.00, 1180.00, 1200.00]
      },
      {
        name: 'ByteForge Systems',
        ticker: 'BFS',
        sector: 'IT',
        description: 'Enterprise cloud infrastructure provider and AI-driven workflow optimization software developer.',
        volatility: 'High',
        initialPrice: 850.00,
        historical: [720.00, 780.00, 810.00, 790.00, 830.00, 850.00]
      },
      {
        name: 'Helixora Pharma',
        ticker: 'HXP',
        sector: 'Pharma',
        description: 'Specialty biopharmaceutical company manufacturing generic vaccines and targeted oncology treatments.',
        volatility: 'Medium',
        initialPrice: 540.00,
        historical: [490.00, 510.00, 500.00, 530.00, 525.00, 540.00]
      },
      {
        name: 'Voltaris Energy',
        ticker: 'VTE',
        sector: 'Energy',
        description: 'Next-generation renewable energy enterprise building solar micro-grids and industrial battery storage.',
        volatility: 'High',
        initialPrice: 1650.00,
        historical: [1400.00, 1480.00, 1550.00, 1510.00, 1600.00, 1650.00]
      },
      {
        name: 'MotoraX Mobility',
        ticker: 'MAX',
        sector: 'Auto',
        description: 'Commercial EV vehicle manufacturer pioneering electric urban transit buses and fleet delivery vans.',
        volatility: 'Low',
        initialPrice: 320.00,
        historical: [300.00, 305.00, 310.00, 312.00, 318.00, 320.00]
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

      // Insert round 0 current price
      await client.query(`
        INSERT INTO stock_prices (game_id, stock_id, round_number, price)
        VALUES ($1, $2, 0, $3);
      `, [gameId, stockId, s.initialPrice]);

      // Insert 6-month historical prices (using negative round numbers -6 to -1 for reference if needed, or storing round 0)
      for (let idx = 0; idx < s.historical.length; idx++) {
        await client.query(`
          INSERT INTO stock_prices (game_id, stock_id, round_number, price)
          VALUES ($1, $2, $3, $4);
        `, [gameId, stockId, -6 + idx, s.historical[idx]]);
      }
    }
    console.log('📈 5 Fictional Stocks & Historical Prices Seeded.');

    // 3. Insert Round Events (Rounds 1 - 5)
    const roundEventsData = [
      // Round 1
      {
        round: 1,
        ticker: 'NXB',
        block_deal_text: 'Domestic institutional investor acquires 2,50,000 equity shares of Nexora Bank.',
        news_text: 'Nexora Bank records 24% YoY surge in digital transaction volume and net interest margin growth.',
        true_price_change: 12.0,
        noise: 1.5
      },
      {
        round: 1,
        ticker: 'BFS',
        block_deal_text: null,
        news_text: 'ByteForge Systems secures multi-year cloud management contract with a global logistics hub.',
        true_price_change: 5.0,
        noise: 0.8
      },
      {
        round: 1,
        ticker: 'HXP',
        block_deal_text: null,
        news_text: 'Helixora Pharma announces successful Phase 1 safety trials for new oncology formulation.',
        true_price_change: 2.0,
        noise: 0.5
      },
      {
        round: 1,
        ticker: 'VTE',
        block_deal_text: null,
        news_text: 'Global crude price drop temporarily dampens renewable energy market sentiment.',
        true_price_change: -4.0,
        noise: 1.0
      },
      {
        round: 1,
        ticker: 'MAX',
        block_deal_text: null,
        news_text: 'MotoraX Mobility delivers 100 electric buses to state transport corporation.',
        true_price_change: 1.0,
        noise: 0.2
      },

      // Round 2
      {
        round: 2,
        ticker: 'BFS',
        block_deal_text: null,
        news_text: 'Global microchip shortage causes 3-week delay in ByteForge enterprise server deployments.',
        true_price_change: -15.0,
        noise: -1.2
      },
      {
        round: 2,
        ticker: 'VTE',
        block_deal_text: 'Surprise block trade executed in Voltaris Energy by green energy venture capital firm.',
        news_text: 'Voltaris Energy unveils groundbreaking 50MW battery storage facility.',
        true_price_change: 18.0,
        noise: 2.0
      },
      {
        round: 2,
        ticker: 'HXP',
        block_deal_text: null,
        news_text: 'Helixora Pharma reports steady Q2 generic drug sales in overseas export markets.',
        true_price_change: 6.0,
        noise: -0.5
      },
      {
        round: 2,
        ticker: 'NXB',
        block_deal_text: null,
        news_text: 'Nexora Bank increases deposit rates by 25 bps to attract retail fixed deposits.',
        true_price_change: -3.0,
        noise: 0.4
      },
      {
        round: 2,
        ticker: 'MAX',
        block_deal_text: null,
        news_text: 'MotoraX Mobility maintains stable electric vehicle production targets.',
        true_price_change: 0.0,
        noise: 0.1
      },

      // Round 3
      {
        round: 3,
        ticker: 'HXP',
        block_deal_text: 'Bulk purchase of 5,00,000 shares of Helixora Pharma by international healthcare fund.',
        news_text: 'Helixora Pharma receives WHO fast-track authorization for mass vaccine deployment.',
        true_price_change: 22.0,
        noise: 1.0
      },
      {
        round: 3,
        ticker: 'BFS',
        block_deal_text: null,
        news_text: 'ByteForge Systems resolves chip supply bottlenecks and resumes normal software integration.',
        true_price_change: 10.0,
        noise: 0.6
      },
      {
        round: 3,
        ticker: 'NXB',
        block_deal_text: null,
        news_text: 'Nexora Bank launches instant AI micro-loan app for small businesses.',
        true_price_change: 4.0,
        noise: -0.2
      },
      {
        round: 3,
        ticker: 'VTE',
        block_deal_text: null,
        news_text: 'Voltaris Energy faces short-term profit booking after recent price rally.',
        true_price_change: -8.0,
        noise: -1.0
      },
      {
        round: 3,
        ticker: 'MAX',
        block_deal_text: null,
        news_text: 'MotoraX Mobility expands EV charging network across 12 smart cities.',
        true_price_change: 3.0,
        noise: 0.3
      },

      // Round 4 (SEBI Check Round)
      {
        round: 4,
        ticker: 'VTE',
        block_deal_text: null,
        news_text: 'Voltaris Energy wins ₹4,500 Crore mega solar grid EPC contract from central power grid.',
        true_price_change: 24.0,
        noise: 1.0
      },
      {
        round: 4,
        ticker: 'MAX',
        block_deal_text: 'Promoter group sells 4% stake in MotoraX Mobility via open market block deal.',
        news_text: 'MotoraX Mobility battery supplier reports temporary factory shutdown due to flooding.',
        true_price_change: -12.0,
        noise: -0.8
      },
      {
        round: 4,
        ticker: 'NXB',
        block_deal_text: null,
        news_text: 'Nexora Bank provisions additional reserves for unsecured credit card defaults.',
        true_price_change: -5.0,
        noise: 0.5
      },
      {
        round: 4,
        ticker: 'BFS',
        block_deal_text: null,
        news_text: 'ByteForge Systems trades flat amid mixed analyst ratings.',
        true_price_change: -2.0,
        noise: 0.2
      },
      {
        round: 4,
        ticker: 'HXP',
        block_deal_text: null,
        news_text: 'Helixora Pharma consolidates gains after previous vaccine approval spike.',
        true_price_change: -4.0,
        noise: -0.4
      },

      // Round 5
      {
        round: 5,
        ticker: 'NXB',
        block_deal_text: 'Final round strategic equity investment in Nexora Bank by global fintech group.',
        news_text: 'Central Bank cuts repo rate by 50 bps; banking stock valuations skyrocket.',
        true_price_change: 18.0,
        noise: 1.2
      },
      {
        round: 5,
        ticker: 'BFS',
        block_deal_text: null,
        news_text: 'ByteForge Systems announces breakthrough Generative AI enterprise suite with high pre-orders.',
        true_price_change: 20.0,
        noise: 1.5
      },
      {
        round: 5,
        ticker: 'MAX',
        block_deal_text: null,
        news_text: 'MotoraX Mobility announces maiden dividend and commercial EV export deal to Southeast Asia.',
        true_price_change: 12.0,
        noise: 0.6
      },
      {
        round: 5,
        ticker: 'VTE',
        block_deal_text: null,
        news_text: 'Voltaris Energy reports stellar annual earnings exceeding street estimates.',
        true_price_change: 10.0,
        noise: 0.8
      },
      {
        round: 5,
        ticker: 'HXP',
        block_deal_text: null,
        news_text: 'Helixora Pharma posts solid quarterly revenue growth across all domestic formulations.',
        true_price_change: 8.0,
        noise: 0.4
      }
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
    console.log('📰 5 Rounds of Events & Price Drivers Seeded.');

    // 4. Insert 12 Sample Tips (Approx 6 True, 4 False, 2 Super Tips)
    const tipsData = [
      // Round 1 Tips
      {
        round: 1,
        ticker: 'NXB',
        source: 'Market Clerk',
        price: 3000,
        isSuper: false,
        isTrue: true,
        effect: 12.0,
        isFlagged: false,
        text: 'Unusual cash and digital deposit inflows observed at Nexora Bank urban branches this week.'
      },
      {
        round: 1,
        ticker: 'BFS',
        source: 'Junior Analyst',
        price: 4000,
        isSuper: false,
        isTrue: true,
        effect: 5.0,
        isFlagged: false,
        text: 'ByteForge Systems expected to comfortably meet Q1 cloud licensing targets.'
      },
      {
        round: 1,
        ticker: 'VTE',
        source: 'Industry Insider',
        price: 5500,
        isSuper: false,
        isTrue: false,
        effect: -4.0,
        isFlagged: false,
        text: 'Rumor: Voltaris Energy facing severe lithium cell procurement bottlenecks this quarter.'
      },

      // Round 2 Tips
      {
        round: 2,
        ticker: 'BFS',
        source: 'Research Assistant',
        price: 6000,
        isSuper: false,
        isTrue: true,
        effect: -15.0,
        isFlagged: true,
        text: 'Leaked memo indicates microchip delivery failure halting ByteForge enterprise server production lines.'
      },
      {
        round: 2,
        ticker: 'VTE',
        source: 'Supplier',
        price: 7500,
        isSuper: false,
        isTrue: true,
        effect: 18.0,
        isFlagged: false,
        text: 'Voltaris battery deliveries to industrial grid projects up 40% over scheduled estimates.'
      },
      {
        round: 2,
        ticker: 'HXP',
        source: 'Board Member',
        price: 8000,
        isSuper: false,
        isTrue: false,
        effect: 6.0,
        isFlagged: false,
        text: 'Internal memo claims Helixora clinical trials hit unexpected regulatory delays.'
      },

      // Round 3 Tips
      {
        round: 3,
        ticker: 'HXP',
        source: 'Industry Insider',
        price: 12000,
        isSuper: true,
        isTrue: true,
        effect: 22.0,
        isFlagged: true,
        text: 'SUPER TIP: World Health Organization approval letter for Helixora vaccine fast-track signed yesterday!'
      },
      {
        round: 3,
        ticker: 'NXB',
        source: 'Market Clerk',
        price: 3500,
        isSuper: false,
        isTrue: true,
        effect: 4.0,
        isFlagged: false,
        text: 'Steady loan disbursement numbers noted across Nexora Bank SME business centers.'
      },

      // Round 4 Tips
      {
        round: 4,
        ticker: 'VTE',
        source: 'Research Assistant',
        price: 9000,
        isSuper: false,
        isTrue: true,
        effect: 24.0,
        isFlagged: true,
        text: 'Voltaris Energy selected as L1 highest bidder for government solar microgrid scheme.'
      },
      {
        round: 4,
        ticker: 'MAX',
        source: 'Junior Analyst',
        price: 4500,
        isSuper: false,
        isTrue: true,
        effect: -12.0,
        isFlagged: false,
        text: 'MotoraX bus delivery schedule disrupted following flood damage at key battery assembly unit.'
      },

      // Round 5 Tips
      {
        round: 5,
        ticker: 'NXB',
        source: 'Board Member',
        price: 15000,
        isSuper: true,
        isTrue: true,
        effect: 18.0,
        isFlagged: false,
        text: 'SUPER TIP: Central Bank preparing emergency 50 bps interest rate cut to boost credit growth!'
      },
      {
        round: 5,
        ticker: 'BFS',
        source: 'Supplier',
        price: 5000,
        isSuper: false,
        isTrue: false,
        effect: 20.0,
        isFlagged: false,
        text: 'ByteForge enterprise client renewals reported declining sharply in Q4.'
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
