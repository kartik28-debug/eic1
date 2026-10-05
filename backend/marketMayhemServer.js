/**
 * Market Mayhem Server Logic & Socket.io Engine
 * Handles PostgreSQL transactions, real-time multiplayer events,
 * trading validations, tip shop, price reveals, and host controls.
 */

const crypto = require('crypto');

// Generate 5-character unique team code without confusing characters (0, O, 1, I)
function generateTeamCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function setupMarketMayhem(app, io, pool) {
  // In-memory active timer state for active games
  const activeTimers = {}; // { gameId: { intervalId, remainingSeconds, isPaused } }

  // ─── Helper Functions ───

  // Get the current active (non-ENDED) game — used for live game actions
  async function getActiveGame() {
    const res = await pool.query("SELECT * FROM games WHERE status NOT IN ('ENDED') ORDER BY id DESC LIMIT 1;");
    return res.rows[0] || null;
  }

  // Get a specific game by ID — used for results, history, ended games
  async function getGameById(gameId) {
    const res = await pool.query('SELECT * FROM games WHERE id = $1;', [gameId]);
    return res.rows[0] || null;
  }

  // Get the most recently ended game — used for debrief/results when no active game
  async function getLatestEndedGame() {
    const res = await pool.query("SELECT * FROM games WHERE status = 'ENDED' ORDER BY ended_at DESC LIMIT 1;");
    return res.rows[0] || null;
  }

  // Stop and clear the round timer for a game
  function stopRoundTimer(gameId) {
    if (activeTimers[gameId] && activeTimers[gameId].intervalId) {
      clearInterval(activeTimers[gameId].intervalId);
      delete activeTimers[gameId];
    }
  }

  // Get prices for a specific round (falls back to round 0 if current round price not yet revealed)
  async function getStockPrices(gameId, roundNumber) {
    const query = `
      SELECT DISTINCT ON (s.id) 
        s.id, s.name, s.ticker, s.sector, s.description, s.volatility,
        COALESCE(p.price, p0.price, 100.00) as current_price,
        p0.price as initial_price
      FROM stocks s
      LEFT JOIN stock_prices p ON p.stock_id = s.id AND p.game_id = s.game_id AND p.round_number = $2
      LEFT JOIN stock_prices p0 ON p0.stock_id = s.id AND p0.game_id = s.game_id AND p0.round_number = 0
      WHERE s.game_id = $1
      ORDER BY s.id;
    `;
    const res = await pool.query(query, [gameId, roundNumber]);
    return res.rows;
  }

  // Get full leaderboard calculated server-side
  async function getLeaderboard(gameId) {
    const gameRes = await pool.query('SELECT current_round FROM games WHERE id = $1;', [gameId]);
    if (gameRes.rows.length === 0) return [];
    const currentRound = gameRes.rows[0].current_round;

    const stocks = await getStockPrices(gameId, currentRound);
    const stockPriceMap = {};
    stocks.forEach(s => stockPriceMap[s.id] = parseFloat(s.current_price));

    const teamsRes = await pool.query(`
      SELECT t.id, t.team_name, t.team_code, t.cash_balance,
             COALESCE(json_agg(json_build_object('student_id', tm.student_id, 'name', tm.display_name)) 
             FILTER (WHERE tm.id IS NOT NULL), '[]') as members
      FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id
      WHERE t.game_id = $1
      GROUP BY t.id;
    `, [gameId]);

    const holdingsRes = await pool.query('SELECT team_id, stock_id, quantity FROM holdings WHERE game_id = $1;', [gameId]);
    const holdingsByTeam = {};
    holdingsRes.rows.forEach(h => {
      if (!holdingsByTeam[h.team_id]) holdingsByTeam[h.team_id] = [];
      holdingsByTeam[h.team_id].push(h);
    });

    const leaderboard = teamsRes.rows.map(team => {
      const cash = parseFloat(team.cash_balance);
      const teamHoldings = holdingsByTeam[team.id] || [];
      let holdingsValue = 0;
      teamHoldings.forEach(h => {
        const p = stockPriceMap[h.stock_id] || 0;
        holdingsValue += h.quantity * p;
      });

      const totalValue = cash + holdingsValue;
      return {
        teamId: team.id,
        teamName: team.team_name,
        teamCode: team.team_code,
        members: team.members,
        cashBalance: cash,
        holdingsValue: holdingsValue,
        totalValue: totalValue
      };
    });

    leaderboard.sort((a, b) => b.totalValue - a.totalValue);
    leaderboard.forEach((t, idx) => t.rank = idx + 1);

    return leaderboard;
  }

  // Broadcast game state & timer to rooms
  async function broadcastGameState(gameId) {
    const game = await pool.query('SELECT * FROM games WHERE id = $1;', [gameId]);
    if (game.rows.length === 0) return;
    const g = game.rows[0];

    const leaderboard = await getLeaderboard(gameId);
    const timerInfo = activeTimers[gameId] ? activeTimers[gameId].remainingSeconds : g.round_timer_seconds;

    io.to(`game_${gameId}`).emit('game-state-updated', {
      gameId: g.id,
      status: g.status,
      currentRound: g.current_round,
      currentPhase: g.current_phase,
      timerSeconds: timerInfo,
      leaderboard: leaderboard,
      allowSolo: g.allow_solo
    });
  }

  // Timer loop runner
  function startRoundTimer(gameId, durationSeconds) {
    if (activeTimers[gameId] && activeTimers[gameId].intervalId) {
      clearInterval(activeTimers[gameId].intervalId);
    }

    activeTimers[gameId] = {
      remainingSeconds: durationSeconds,
      isPaused: false,
      intervalId: setInterval(async () => {
        if (activeTimers[gameId].isPaused) return;

        activeTimers[gameId].remainingSeconds -= 1;
        const remaining = activeTimers[gameId].remainingSeconds;

        io.to(`game_${gameId}`).emit('timer-tick', { remainingSeconds: remaining });

        if (remaining <= 0) {
          clearInterval(activeTimers[gameId].intervalId);
          activeTimers[gameId].remainingSeconds = 0;
          io.to(`game_${gameId}`).emit('timer-ended', { gameId });
        }
      }, 1000)
    };
  }

  function pauseRoundTimer(gameId) {
    if (activeTimers[gameId]) {
      activeTimers[gameId].isPaused = true;
      io.to(`game_${gameId}`).emit('game-paused', { gameId });
    }
  }

  function resumeRoundTimer(gameId) {
    if (activeTimers[gameId]) {
      activeTimers[gameId].isPaused = false;
      io.to(`game_${gameId}`).emit('game-resumed', { gameId });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ─── REST ENDPOINTS ──────────────────────────────────────────
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // 1. GET /api/market-mayhem/active-game
  app.get('/api/market-mayhem/active-game', async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) {
        return res.status(404).json({ success: false, message: 'No active game found.' });
      }
      return res.json({ success: true, game });
    } catch (err) {
      console.error('Error fetching active game:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // 1b. GET /api/market-mayhem/games/history — list all games (host only reference)
  app.get('/api/market-mayhem/games/history', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, name, status, current_round, current_phase, created_at, started_at, ended_at FROM games ORDER BY id DESC;');
      return res.json({ success: true, games: result.rows });
    } catch (err) {
      console.error('Error fetching game history:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ─── Internal: Seed a new game with default stocks, events, and tips ───
  async function seedNewGame(client, gameId) {
    const stocksData = [
      { name: 'Nexora Bank', ticker: 'NXB', sector: 'Banking', description: 'Digital-first banking platform serving tech startups, MSMEs, and young professionals across India.', volatility: 'Medium', initialPrice: 1200.00, historical: [1050.00, 1100.00, 1140.00, 1120.00, 1180.00, 1200.00] },
      { name: 'ByteForge Systems', ticker: 'BFS', sector: 'IT', description: 'Enterprise cloud infrastructure provider and AI-driven workflow optimization software developer.', volatility: 'High', initialPrice: 850.00, historical: [720.00, 780.00, 810.00, 790.00, 830.00, 850.00] },
      { name: 'Helixora Pharma', ticker: 'HXP', sector: 'Pharma', description: 'Specialty biopharmaceutical company manufacturing generic vaccines and targeted oncology treatments.', volatility: 'Medium', initialPrice: 540.00, historical: [490.00, 510.00, 500.00, 530.00, 525.00, 540.00] },
      { name: 'Voltaris Energy', ticker: 'VTE', sector: 'Energy', description: 'Next-generation renewable energy enterprise building solar micro-grids and industrial battery storage.', volatility: 'High', initialPrice: 1650.00, historical: [1400.00, 1480.00, 1550.00, 1510.00, 1600.00, 1650.00] },
      { name: 'MotoraX Mobility', ticker: 'MAX', sector: 'Auto', description: 'Commercial EV vehicle manufacturer pioneering electric urban transit buses and fleet delivery vans.', volatility: 'Low', initialPrice: 320.00, historical: [300.00, 305.00, 310.00, 312.00, 318.00, 320.00] }
    ];

    const stockMap = {};
    for (const s of stocksData) {
      const r = await client.query(
        'INSERT INTO stocks (game_id, name, ticker, sector, description, volatility) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id;',
        [gameId, s.name, s.ticker, s.sector, s.description, s.volatility]
      );
      const stockId = r.rows[0].id;
      stockMap[s.ticker] = stockId;
      await client.query('INSERT INTO stock_prices (game_id, stock_id, round_number, price) VALUES ($1,$2,0,$3);', [gameId, stockId, s.initialPrice]);
      for (let idx = 0; idx < s.historical.length; idx++) {
        await client.query('INSERT INTO stock_prices (game_id, stock_id, round_number, price) VALUES ($1,$2,$3,$4);', [gameId, stockId, -6 + idx, s.historical[idx]]);
      }
    }

    const roundEventsData = [
      { round: 1, ticker: 'NXB', block_deal_text: 'Domestic institutional investor acquires 2,50,000 equity shares of Nexora Bank.', news_text: 'Nexora Bank records 24% YoY surge in digital transaction volume and net interest margin growth.', true_price_change: 12.0, noise: 1.5 },
      { round: 1, ticker: 'BFS', block_deal_text: null, news_text: 'ByteForge Systems secures multi-year cloud management contract with a global logistics hub.', true_price_change: 5.0, noise: 0.8 },
      { round: 1, ticker: 'HXP', block_deal_text: null, news_text: 'Helixora Pharma announces successful Phase 1 safety trials for new oncology formulation.', true_price_change: 2.0, noise: 0.5 },
      { round: 1, ticker: 'VTE', block_deal_text: null, news_text: 'Global crude price drop temporarily dampens renewable energy market sentiment.', true_price_change: -4.0, noise: 1.0 },
      { round: 1, ticker: 'MAX', block_deal_text: null, news_text: 'MotoraX Mobility delivers 100 electric buses to state transport corporation.', true_price_change: 1.0, noise: 0.2 },
      { round: 2, ticker: 'BFS', block_deal_text: null, news_text: 'Global microchip shortage causes 3-week delay in ByteForge enterprise server deployments.', true_price_change: -15.0, noise: -1.2 },
      { round: 2, ticker: 'VTE', block_deal_text: 'Surprise block trade executed in Voltaris Energy by green energy venture capital firm.', news_text: 'Voltaris Energy unveils groundbreaking 50MW battery storage facility.', true_price_change: 18.0, noise: 2.0 },
      { round: 2, ticker: 'HXP', block_deal_text: null, news_text: 'Helixora Pharma reports steady Q2 generic drug sales in overseas export markets.', true_price_change: 6.0, noise: -0.5 },
      { round: 2, ticker: 'NXB', block_deal_text: null, news_text: 'Nexora Bank increases deposit rates by 25 bps to attract retail fixed deposits.', true_price_change: -3.0, noise: 0.4 },
      { round: 2, ticker: 'MAX', block_deal_text: null, news_text: 'MotoraX Mobility maintains stable electric vehicle production targets.', true_price_change: 0.0, noise: 0.1 },
      { round: 3, ticker: 'HXP', block_deal_text: 'Bulk purchase of 5,00,000 shares of Helixora Pharma by international healthcare fund.', news_text: 'Helixora Pharma receives WHO fast-track authorization for mass vaccine deployment.', true_price_change: 22.0, noise: 1.0 },
      { round: 3, ticker: 'BFS', block_deal_text: null, news_text: 'ByteForge Systems resolves chip supply bottlenecks and resumes normal software integration.', true_price_change: 10.0, noise: 0.6 },
      { round: 3, ticker: 'NXB', block_deal_text: null, news_text: 'Nexora Bank launches instant AI micro-loan app for small businesses.', true_price_change: 4.0, noise: -0.2 },
      { round: 3, ticker: 'VTE', block_deal_text: null, news_text: 'Voltaris Energy faces short-term profit booking after recent price rally.', true_price_change: -8.0, noise: -1.0 },
      { round: 3, ticker: 'MAX', block_deal_text: null, news_text: 'MotoraX Mobility expands EV charging network across 12 smart cities.', true_price_change: 3.0, noise: 0.3 },
      { round: 4, ticker: 'VTE', block_deal_text: null, news_text: 'Voltaris Energy wins ₹4,500 Crore mega solar grid EPC contract from central power grid.', true_price_change: 24.0, noise: 1.0 },
      { round: 4, ticker: 'MAX', block_deal_text: 'Promoter group sells 4% stake in MotoraX Mobility via open market block deal.', news_text: 'MotoraX Mobility battery supplier reports temporary factory shutdown due to flooding.', true_price_change: -12.0, noise: -0.8 },
      { round: 4, ticker: 'NXB', block_deal_text: null, news_text: 'Nexora Bank provisions additional reserves for unsecured credit card defaults.', true_price_change: -5.0, noise: 0.5 },
      { round: 4, ticker: 'BFS', block_deal_text: null, news_text: 'ByteForge Systems trades flat amid mixed analyst ratings.', true_price_change: -2.0, noise: 0.2 },
      { round: 4, ticker: 'HXP', block_deal_text: null, news_text: 'Helixora Pharma consolidates gains after previous vaccine approval spike.', true_price_change: -4.0, noise: -0.4 },
      { round: 5, ticker: 'NXB', block_deal_text: 'Final round strategic equity investment in Nexora Bank by global fintech group.', news_text: 'Central Bank cuts repo rate by 50 bps; banking stock valuations skyrocket.', true_price_change: 18.0, noise: 1.2 },
      { round: 5, ticker: 'BFS', block_deal_text: null, news_text: 'ByteForge Systems announces breakthrough Generative AI enterprise suite with high pre-orders.', true_price_change: 20.0, noise: 1.5 },
      { round: 5, ticker: 'MAX', block_deal_text: null, news_text: 'MotoraX Mobility announces maiden dividend and commercial EV export deal to Southeast Asia.', true_price_change: 12.0, noise: 0.6 },
      { round: 5, ticker: 'VTE', block_deal_text: null, news_text: 'Voltaris Energy reports stellar annual earnings exceeding street estimates.', true_price_change: 10.0, noise: 0.8 },
      { round: 5, ticker: 'HXP', block_deal_text: null, news_text: 'Helixora Pharma posts solid quarterly revenue growth across all domestic formulations.', true_price_change: 8.0, noise: 0.4 }
    ];
    for (const ev of roundEventsData) {
      await client.query(
        'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
        [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
      );
    }

    const tipsData = [
      { round: 1, ticker: 'NXB', source: 'Market Clerk', price: 3000, isSuper: false, isTrue: true, effect: 12.0, isFlagged: false, text: 'Unusual cash and digital deposit inflows observed at Nexora Bank urban branches this week.' },
      { round: 1, ticker: 'BFS', source: 'Junior Analyst', price: 4000, isSuper: false, isTrue: true, effect: 5.0, isFlagged: false, text: 'ByteForge Systems expected to comfortably meet Q1 cloud licensing targets.' },
      { round: 1, ticker: 'VTE', source: 'Industry Insider', price: 5500, isSuper: false, isTrue: false, effect: -4.0, isFlagged: false, text: 'Rumor: Voltaris Energy facing severe lithium cell procurement bottlenecks this quarter.' },
      { round: 2, ticker: 'BFS', source: 'Research Assistant', price: 6000, isSuper: false, isTrue: true, effect: -15.0, isFlagged: true, text: 'Leaked memo indicates microchip delivery failure halting ByteForge enterprise server production lines.' },
      { round: 2, ticker: 'VTE', source: 'Supplier', price: 7500, isSuper: false, isTrue: true, effect: 18.0, isFlagged: false, text: 'Voltaris battery deliveries to industrial grid projects up 40% over scheduled estimates.' },
      { round: 2, ticker: 'HXP', source: 'Board Member', price: 8000, isSuper: false, isTrue: false, effect: 6.0, isFlagged: false, text: 'Internal memo claims Helixora clinical trials hit unexpected regulatory delays.' },
      { round: 3, ticker: 'HXP', source: 'Industry Insider', price: 12000, isSuper: true, isTrue: true, effect: 22.0, isFlagged: true, text: 'SUPER TIP: World Health Organization approval letter for Helixora vaccine fast-track signed yesterday!' },
      { round: 3, ticker: 'NXB', source: 'Market Clerk', price: 3500, isSuper: false, isTrue: true, effect: 4.0, isFlagged: false, text: 'Steady loan disbursement numbers noted across Nexora Bank SME business centers.' },
      { round: 4, ticker: 'VTE', source: 'Research Assistant', price: 9000, isSuper: false, isTrue: true, effect: 24.0, isFlagged: true, text: 'Voltaris Energy selected as L1 highest bidder for government solar microgrid scheme.' },
      { round: 4, ticker: 'MAX', source: 'Junior Analyst', price: 4500, isSuper: false, isTrue: true, effect: -12.0, isFlagged: false, text: 'MotoraX bus delivery schedule disrupted following flood damage at key battery assembly unit.' },
      { round: 5, ticker: 'NXB', source: 'Board Member', price: 15000, isSuper: true, isTrue: true, effect: 18.0, isFlagged: false, text: 'SUPER TIP: Central Bank preparing emergency 50 bps interest rate cut to boost credit growth!' },
      { round: 5, ticker: 'BFS', source: 'Supplier', price: 5000, isSuper: false, isTrue: false, effect: 20.0, isFlagged: false, text: 'ByteForge enterprise client renewals reported declining sharply in Q4.' }
    ];
    for (const t of tipsData) {
      await client.query(
        'INSERT INTO tips (game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);',
        [gameId, t.round, stockMap[t.ticker], t.text, t.source, t.price, t.isSuper, t.isTrue, t.effect, t.isFlagged]
      );
    }
  }

  // 1c. POST /api/market-mayhem/games — Create a brand-new game (host only)
  app.post('/api/market-mayhem/games', requireHost, async (req, res) => {
    const client = await pool.connect();
    try {
      const { gameName, startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound } = req.body;

      const name = (gameName && gameName.trim()) || 'Market Mayhem';
      const cash = parseFloat(startingCash) || 100000.00;
      const teamSize = parseInt(maxTeamSize) || 4;
      const timer = parseInt(roundTimerSeconds) || 120;
      const penalty = parseFloat(penaltyPercentage) || 10.00;
      const sebi = parseInt(sebiCheckRound) || 4;

      await client.query('BEGIN');

      // Insert new game row
      const gameRes = await client.query(`
        INSERT INTO games (name, status, starting_cash, max_team_size, round_timer_seconds, penalty_percentage, sebi_check_round, current_round, current_phase, allow_solo)
        VALUES ($1, 'LOBBY', $2, $3, $4, $5, $6, 1, 'LOBBY', TRUE)
        RETURNING *;
      `, [name, cash, teamSize, timer, penalty, sebi]);

      const newGame = gameRes.rows[0];

      // Seed stocks, events, and tips for the new game
      await seedNewGame(client, newGame.id);

      await client.query('COMMIT');

      console.log(`🎮 New game created: ID ${newGame.id} — ${newGame.name}`);

      return res.json({
        success: true,
        game: {
          id: newGame.id,
          name: newGame.name,
          status: newGame.status,
          current_round: newGame.current_round,
          current_phase: newGame.current_phase,
          starting_cash: newGame.starting_cash,
          max_team_size: newGame.max_team_size,
          round_timer_seconds: newGame.round_timer_seconds,
          allow_solo: newGame.allow_solo
        }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Create game error:', err);
      res.status(500).json({ success: false, message: `Failed to create game: ${err.message}` });
    } finally {
      client.release();
    }
  });

  // 2. GET /api/market-mayhem/fact-sheet
  app.get('/api/market-mayhem/fact-sheet', async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

      const stocksRes = await pool.query(`
        SELECT id, name, ticker, sector, description, volatility
        FROM stocks WHERE game_id = $1 ORDER BY id;
      `, [game.id]);

      const historyRes = await pool.query(`
        SELECT stock_id, round_number, price
        FROM stock_prices WHERE game_id = $1
        ORDER BY stock_id, round_number;
      `, [game.id]);

      const historyByStock = {};
      historyRes.rows.forEach(r => {
        if (!historyByStock[r.stock_id]) historyByStock[r.stock_id] = [];
        historyByStock[r.stock_id].push({ round: r.round_number, price: parseFloat(r.price) });
      });

      const factSheet = stocksRes.rows.map(s => ({
        ...s,
        history: historyByStock[s.id] || []
      }));

      return res.json({ success: true, stocks: factSheet });
    } catch (err) {
      console.error('Fact sheet error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // 3. GET /api/market-mayhem/my-team
  // Returns team for the active game, or by ?gameId= for specific game (e.g., ended game)
  app.get('/api/market-mayhem/my-team', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      // Support ?gameId= for fetching team in a specific (e.g. ended) game
      let game = null;
      if (req.query.gameId) {
        game = await getGameById(parseInt(req.query.gameId));
      } else {
        game = await getActiveGame();
        if (!game) game = await getLatestEndedGame();
      }
      if (!game) return res.json({ success: true, inTeam: false });

      const memberRes = await pool.query(`
        SELECT tm.team_id, tm.display_name, t.team_name, t.team_code, t.cash_balance, t.game_id
        FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2;
      `, [req.session.userId, game.id]);

      if (memberRes.rows.length === 0) {
        return res.json({ success: true, inTeam: false });
      }

      const team = memberRes.rows[0];

      // Get teammates
      const teammatesRes = await pool.query(`
        SELECT student_id, display_name, joined_at
        FROM team_members WHERE team_id = $1 ORDER BY joined_at;
      `, [team.team_id]);

      return res.json({
        success: true,
        inTeam: true,
        team: {
          id: team.team_id,
          gameId: team.game_id,
          name: team.team_name,
          code: team.team_code,
          cashBalance: parseFloat(team.cash_balance),
          displayName: team.display_name,
          members: teammatesRes.rows
        }
      });
    } catch (err) {
      console.error('Error fetching student team:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // 4. POST /api/market-mayhem/teams/create
  app.post('/api/market-mayhem/teams/create', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const { teamName, displayName } = req.body;
      if (!teamName || !teamName.trim()) {
        return res.status(400).json({ success: false, message: 'Team name is required.' });
      }

      const game = await getActiveGame();
      if (!game) return res.status(400).json({ success: false, message: 'No active game available.' });

      // Security: reject team creation for ENDED games
      if (game.status === 'ENDED') {
        return res.status(400).json({ success: false, message: 'Game has ended. Team creation disabled.' });
      }

      if (game.status !== 'LOBBY') {
        return res.status(400).json({ success: false, message: 'Game has already started. Team creation disabled.' });
      }

      // Check if student is already in a team for this game
      const existing = await pool.query(`
        SELECT tm.id FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2;
      `, [req.session.userId, game.id]);

      if (existing.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'You are already in a team for this game.' });
      }

      // Generate unique 5-char code
      let code = generateTeamCode();
      let codeCheck = await pool.query('SELECT id FROM teams WHERE game_id = $1 AND team_code = $2;', [game.id, code]);
      while (codeCheck.rows.length > 0) {
        code = generateTeamCode();
        codeCheck = await pool.query('SELECT id FROM teams WHERE game_id = $1 AND team_code = $2;', [game.id, code]);
      }

      const playerDispName = (displayName && displayName.trim()) || req.session.name || 'Player';

      // Insert team and team_member inside transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const teamRes = await client.query(`
          INSERT INTO teams (game_id, team_name, team_code, cash_balance)
          VALUES ($1, $2, $3, $4) RETURNING id;
        `, [game.id, teamName.trim(), code, game.starting_cash]);

        const teamId = teamRes.rows[0].id;

        await client.query(`
          INSERT INTO team_members (team_id, student_id, display_name)
          VALUES ($1, $2, $3);
        `, [teamId, req.session.userId, playerDispName]);

        await client.query('COMMIT');

        io.to(`game_${game.id}`).emit('lobby-updated', { gameId: game.id });

        return res.json({
          success: true,
          team: {
            id: teamId,
            gameId: game.id,
            name: teamName.trim(),
            code: code,
            cashBalance: parseFloat(game.starting_cash),
            displayName: playerDispName,
            members: [{ student_id: req.session.userId, display_name: playerDispName }]
          }
        });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

    } catch (err) {
      console.error('Create team error:', err);
      res.status(500).json({ success: false, message: 'Failed to create team.' });
    }
  });

  // 5. POST /api/market-mayhem/teams/join
  app.post('/api/market-mayhem/teams/join', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const { teamCode, displayName } = req.body;
      if (!teamCode || !teamCode.trim()) {
        return res.status(400).json({ success: false, message: 'Team code is required.' });
      }

      const game = await getActiveGame();
      if (!game) return res.status(400).json({ success: false, message: 'No active game.' });

      // Security: reject joining for ENDED games
      if (game.status === 'ENDED') {
        return res.status(400).json({ success: false, message: 'Game has ended. Joining disabled.' });
      }

      if (game.status !== 'LOBBY') {
        return res.status(400).json({ success: false, message: 'Game has already started. Joining disabled.' });
      }

      // Check if student is already in a team
      const existing = await pool.query(`
        SELECT tm.id FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2;
      `, [req.session.userId, game.id]);

      if (existing.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'You are already in a team.' });
      }

      // Find team by code
      const teamRes = await pool.query(`
        SELECT id, team_name, team_code, cash_balance FROM teams
        WHERE game_id = $1 AND UPPER(team_code) = $2;
      `, [game.id, teamCode.trim().toUpperCase()]);

      if (teamRes.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Invalid team code.' });
      }

      const team = teamRes.rows[0];

      // Check capacity
      const countRes = await pool.query('SELECT COUNT(*) FROM team_members WHERE team_id = $1;', [team.id]);
      const currentCount = parseInt(countRes.rows[0].count);

      if (currentCount >= game.max_team_size) {
        return res.status(400).json({ success: false, message: `Team is full (Max ${game.max_team_size} members).` });
      }

      const playerDispName = (displayName && displayName.trim()) || req.session.name || 'Player';

      await pool.query(`
        INSERT INTO team_members (team_id, student_id, display_name)
        VALUES ($1, $2, $3);
      `, [team.id, req.session.userId, playerDispName]);

      // Get updated member list
      const membersRes = await pool.query('SELECT student_id, display_name, joined_at FROM team_members WHERE team_id = $1;', [team.id]);

      io.to(`game_${game.id}`).emit('lobby-updated', { gameId: game.id });
      io.to(`team_${team.id}`).emit('team-updated', { teamId: team.id, members: membersRes.rows });

      return res.json({
        success: true,
        team: {
          id: team.id,
          gameId: game.id,
          name: team.team_name,
          code: team.team_code,
          cashBalance: parseFloat(team.cash_balance),
          displayName: playerDispName,
          members: membersRes.rows
        }
      });

    } catch (err) {
      console.error('Join team error:', err);
      res.status(500).json({ success: false, message: 'Failed to join team.' });
    }
  });

  // 6. GET /api/market-mayhem/state
  // When game is ENDED, falls back to latest ended game so players still see results on refresh
  app.get('/api/market-mayhem/state', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      // Try active game first; fall back to latest ended game
      let game = await getActiveGame();
      if (!game) game = await getLatestEndedGame();
      if (!game) return res.status(404).json({ success: false, message: 'No active game' });

      // Find user team (scoped to this game)
      const memberRes = await pool.query(`
        SELECT tm.team_id, t.team_name, t.team_code, t.cash_balance
        FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2;
      `, [req.session.userId, game.id]);

      let team = null;
      let holdings = [];
      let purchasedTips = [];
      let trades = [];
      let penalties = [];

      if (memberRes.rows.length > 0) {
        const t = memberRes.rows[0];
        team = {
          id: t.team_id,
          name: t.team_name,
          code: t.team_code,
          cashBalance: parseFloat(t.cash_balance)
        };

        // Holdings (scoped to this game)
        const hRes = await pool.query(`
          SELECT h.stock_id, h.quantity, s.name, s.ticker
          FROM holdings h
          JOIN stocks s ON s.id = h.stock_id
          WHERE h.team_id = $1 AND h.quantity > 0 AND h.game_id = $2;
        `, [team.id, game.id]);
        holdings = hRes.rows;

        // Purchased Tips for team — HIDDEN FIELDS STRICTLY EXCLUDED!
        const tipsRes = await pool.query(`
          SELECT tt.id as purchase_id, tt.round_number, t.id as tip_id, t.stock_id, t.text, t.source_label, t.price, t.is_super_tip, s.name as stock_name, s.ticker as stock_ticker
          FROM team_tips tt
          JOIN tips t ON t.id = tt.tip_id
          JOIN stocks s ON s.id = t.stock_id
          WHERE tt.team_id = $1 AND t.game_id = $2
          ORDER BY tt.purchased_at DESC;
        `, [team.id, game.id]);
        purchasedTips = tipsRes.rows;

        // Recent trades (scoped to this game)
        const tradesRes = await pool.query(`
          SELECT tr.id, tr.stock_id, s.ticker, s.name, tr.type, tr.quantity, tr.price, tr.total_value, tr.round_number, tr.created_at
          FROM trades tr
          JOIN stocks s ON s.id = tr.stock_id
          WHERE tr.team_id = $1 AND tr.game_id = $2
          ORDER BY tr.created_at DESC LIMIT 20;
        `, [team.id, game.id]);
        trades = tradesRes.rows;

        // Penalties (scoped to this game)
        const penRes = await pool.query(`
          SELECT id, round_number, reason, amount, created_at
          FROM penalties WHERE team_id = $1 AND game_id = $2 ORDER BY created_at DESC;
        `, [team.id, game.id]);
        penalties = penRes.rows;
      }

      // Stock prices for current round
      const stocks = await getStockPrices(game.id, game.current_round);

      // Current round events (Block deal & news for current round)
      const eventsRes = await pool.query(`
        SELECT re.round_number, re.stock_id, s.ticker, s.name as stock_name, re.block_deal_text, re.news_text
        FROM round_events re
        JOIN stocks s ON s.id = re.stock_id
        WHERE re.game_id = $1 AND re.round_number <= $2
        ORDER BY re.round_number ASC;
      `, [game.id, game.current_round]);

      // Available tips in Tip Shop for current round
      // SECURITY: only return safe metadata — NEVER expose text, is_true, effect_size, is_flagged
      const availableTipsRes = await pool.query(`
        SELECT t.id, t.round_number, t.stock_id, s.name as stock_name, s.ticker as stock_ticker,
               t.source_label, t.price, t.is_super_tip
        FROM tips t
        JOIN stocks s ON s.id = t.stock_id
        WHERE t.game_id = $1 AND t.round_number = $2;
      `, [game.id, game.current_round]);

      // Leaderboard
      const leaderboard = await getLeaderboard(game.id);

      // Timer info
      const timerInfo = activeTimers[game.id] ? activeTimers[game.id].remainingSeconds : game.round_timer_seconds;

      return res.json({
        success: true,
        game: {
          id: game.id,
          name: game.name,
          status: game.status,
          currentRound: game.current_round,
          currentPhase: game.current_phase,
          startingCash: parseFloat(game.starting_cash),
          penaltyPercentage: parseFloat(game.penalty_percentage),
          sebiCheckRound: game.sebi_check_round,
          roundTimerSeconds: game.round_timer_seconds,
          timerRemaining: timerInfo
        },
        team,
        holdings,
        stocks,
        events: eventsRes.rows,
        availableTips: availableTipsRes.rows,
        purchasedTips,
        trades,
        penalties,
        leaderboard
      });

    } catch (err) {
      console.error('Error fetching player game state:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // 7. POST /api/market-mayhem/trade (BUY / SELL with DB Transaction)
  app.post('/api/market-mayhem/trade', async (req, res) => {
    const client = await pool.connect();
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const { stockId, type, quantity } = req.body;
      const qty = parseInt(quantity);

      if (!stockId || !type || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid trade parameters.' });
      }

      const tradeType = type.toUpperCase();
      if (tradeType !== 'BUY' && tradeType !== 'SELL') {
        return res.status(400).json({ success: false, message: 'Trade type must be BUY or SELL.' });
      }

      await client.query('BEGIN');

      const game = await getActiveGame();
      if (!game) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'No active game.' });
      }

      // Security: reject trades if game is not ACTIVE (catches ENDED, LOBBY)
      if (game.status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Game is not active. Trading is disabled.' });
      }

      if (game.current_phase !== 'TRADING') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Trading is only allowed during the TRADING phase.' });
      }

      // Check student team
      const memberRes = await client.query(`
        SELECT tm.team_id, t.cash_balance FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2 FOR UPDATE OF t;
      `, [req.session.userId, game.id]);

      if (memberRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'You are not on a team.' });
      }

      const teamId = memberRes.rows[0].team_id;
      let cashBalance = parseFloat(memberRes.rows[0].cash_balance);

      // Get authoritative stock price for current round
      const stockRes = await client.query(`
        SELECT s.id, s.ticker, s.name, COALESCE(p.price, p0.price) as current_price
        FROM stocks s
        LEFT JOIN stock_prices p ON p.stock_id = s.id AND p.game_id = s.game_id AND p.round_number = $2
        LEFT JOIN stock_prices p0 ON p0.stock_id = s.id AND p0.game_id = s.game_id AND p0.round_number = 0
        WHERE s.id = $1 AND s.game_id = $3;
      `, [stockId, game.current_round, game.id]);

      if (stockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Stock not found.' });
      }

      const stock = stockRes.rows[0];
      const price = parseFloat(stock.current_price);
      const totalCost = qty * price;

      if (tradeType === 'BUY') {
        if (cashBalance < totalCost) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: `Insufficient cash balance. Required: ₹${totalCost.toLocaleString()}, Available: ₹${cashBalance.toLocaleString()}`
          });
        }

        // Deduct cash balance
        cashBalance -= totalCost;
        await client.query('UPDATE teams SET cash_balance = $1 WHERE id = $2;', [cashBalance, teamId]);

        // Upsert holding
        await client.query(`
          INSERT INTO holdings (game_id, team_id, stock_id, quantity)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (team_id, stock_id)
          DO UPDATE SET quantity = holdings.quantity + EXCLUDED.quantity;
        `, [game.id, teamId, stockId, qty]);

      } else if (tradeType === 'SELL') {
        // Check current holding (scoped to this game)
        const holdingRes = await client.query(`
          SELECT quantity FROM holdings WHERE team_id = $1 AND stock_id = $2 AND game_id = $3 FOR UPDATE;
        `, [teamId, stockId, game.id]);

        const ownedQty = holdingRes.rows.length > 0 ? holdingRes.rows[0].quantity : 0;
        if (ownedQty < qty) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            message: `Insufficient shares to sell. Owned: ${ownedQty}, Requested: ${qty}`
          });
        }

        // Add cash balance
        cashBalance += totalCost;
        await client.query('UPDATE teams SET cash_balance = $1 WHERE id = $2;', [cashBalance, teamId]);

        // Deduct holding (scoped to this game)
        await client.query(`
          UPDATE holdings SET quantity = quantity - $1 WHERE team_id = $2 AND stock_id = $3 AND game_id = $4;
        `, [qty, teamId, stockId, game.id]);
      }

      // Insert trade record
      await client.query(`
        INSERT INTO trades (game_id, team_id, stock_id, type, quantity, price, total_value, round_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [game.id, teamId, stockId, tradeType, qty, price, totalCost, game.current_round]);

      await client.query('COMMIT');

      // Recalculate leaderboard for host monitor
      const updatedLeaderboard = await getLeaderboard(game.id);

      // Get team name for host display
      const teamNameRes = await pool.query('SELECT team_name FROM teams WHERE id = $1;', [teamId]);
      const teamName = teamNameRes.rows.length > 0 ? teamNameRes.rows[0].team_name : 'Team';

      const tradePayload = {
        teamId,
        teamName,
        stockTicker: stock.ticker,
        stockName: stock.name,
        type: tradeType,
        quantity: qty,
        price,
        totalAmount: totalCost,
        newCashBalance: cashBalance,
        createdAt: new Date().toISOString()
      };

      // Notify team members their own trade
      io.to(`team_${teamId}`).emit('trade-executed', tradePayload);

      // Notify host dashboard (game room) of live trade feed
      io.to(`game_${game.id}`).emit('trade-executed', tradePayload);

      io.to(`game_${game.id}`).emit('leaderboard-updated', {
        leaderboard: updatedLeaderboard
      });

      return res.json({
        success: true,
        message: `${tradeType} trade executed successfully: ${qty} x ${stock.ticker} @ ₹${price}`,
        newCashBalance: cashBalance
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Trade error:', err);
      res.status(500).json({ success: false, message: 'Trade transaction failed.' });
    } finally {
      client.release();
    }
  });

  // 8. POST /api/market-mayhem/tips/buy
  app.post('/api/market-mayhem/tips/buy', async (req, res) => {
    const client = await pool.connect();
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const { tipId } = req.body;
      if (!tipId) return res.status(400).json({ success: false, message: 'Tip ID is required.' });

      await client.query('BEGIN');

      const game = await getActiveGame();
      if (!game) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'No active game' });
      }

      // Security: reject tip purchases if game is not ACTIVE
      if (game.status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Game is not active. Tip purchases are disabled.' });
      }

      // Security: tips can ONLY be purchased during TIP_SHOP phase
      if (game.current_phase !== 'TIP_SHOP') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Tips can only be purchased during the TIP_SHOP phase.' });
      }

      const memberRes = await client.query(`
        SELECT tm.team_id, t.cash_balance FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2 FOR UPDATE OF t;
      `, [req.session.userId, game.id]);

      if (memberRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'You are not on a team.' });
      }

      const teamId = memberRes.rows[0].team_id;
      let cashBalance = parseFloat(memberRes.rows[0].cash_balance);

      // Check max 2 tips per round per team
      const countRes = await client.query(`
        SELECT COUNT(*) FROM team_tips WHERE team_id = $1 AND round_number = $2;
      `, [teamId, game.current_round]);

      if (parseInt(countRes.rows[0].count) >= 2) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Maximum 2 tips allowed per team per round.' });
      }

      // Get tip details
      const tipRes = await client.query('SELECT * FROM tips WHERE id = $1 AND game_id = $2;', [tipId, game.id]);
      if (tipRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Tip not found.' });
      }

      const tip = tipRes.rows[0];

      // Security: tip must belong to the current round
      if (tip.round_number !== game.current_round) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `This tip is for Round ${tip.round_number}, not the current Round ${game.current_round}.`
        });
      }

      const price = parseFloat(tip.price);

      if (cashBalance < price) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Insufficient cash balance. Required: ₹${price.toLocaleString()}, Available: ₹${cashBalance.toLocaleString()}`
        });
      }

      // Check if already bought
      const alreadyBought = await client.query('SELECT id FROM team_tips WHERE team_id = $1 AND tip_id = $2;', [teamId, tipId]);
      if (alreadyBought.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Your team already purchased this tip.' });
      }

      // Deduct cash
      cashBalance -= price;
      await client.query('UPDATE teams SET cash_balance = $1 WHERE id = $2;', [cashBalance, teamId]);

      // Record purchase
      await client.query(`
        INSERT INTO team_tips (team_id, tip_id, round_number)
        VALUES ($1, $2, $3);
      `, [teamId, tipId, game.current_round]);

      await client.query('COMMIT');

      // Fetch stock details for client notification
      const stockRes = await pool.query('SELECT name, ticker FROM stocks WHERE id = $1;', [tip.stock_id]);
      const stockName = stockRes.rows.length > 0 ? stockRes.rows[0].name : '';
      const stockTicker = stockRes.rows.length > 0 ? stockRes.rows[0].ticker : '';

      const purchasedTipData = {
        purchase_id: Date.now(),
        round_number: game.current_round,
        tip_id: tip.id,
        stock_id: tip.stock_id,
        stock_name: stockName,
        stock_ticker: stockTicker,
        text: tip.text,
        source_label: tip.source_label,
        price: parseFloat(tip.price),
        is_super_tip: tip.is_super_tip
        // HIDDEN FIELDS EXCLUDED!
      };

      io.to(`team_${teamId}`).emit('tip-purchased', {
        teamId,
        tip: purchasedTipData,
        newCashBalance: cashBalance
      });

      return res.json({
        success: true,
        message: 'Tip purchased successfully!',
        tip: purchasedTipData,
        newCashBalance: cashBalance
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Buy tip error:', err);
      res.status(500).json({ success: false, message: 'Failed to buy tip.' });
    } finally {
      client.release();
    }
  });

  // 9. GET /api/market-mayhem/debrief — Final Game Reveal Debrief
  // Works for active game, ended game (via fallback), or specific game via ?gameId=
  app.get('/api/market-mayhem/debrief', async (req, res) => {
    try {
      let game = null;
      if (req.query.gameId) {
        game = await getGameById(parseInt(req.query.gameId));
      } else {
        // Try active first, then fall back to most recently ended
        game = await getActiveGame();
        if (!game) game = await getLatestEndedGame();
      }
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

      // Debrief data contains full tip information including hidden fields
      const tipsRes = await pool.query(`
        SELECT t.id, t.round_number, t.text, t.source_label, t.price, t.is_super_tip,
               t.is_true, t.effect_size, t.is_flagged, s.name as stock_name, s.ticker as stock_ticker
        FROM tips t
        JOIN stocks s ON s.id = t.stock_id
        WHERE t.game_id = $1
        ORDER BY t.round_number ASC, t.id ASC;
      `, [game.id]);

      const leaderboard = await getLeaderboard(game.id);

      // Penalties history (scoped to this game)
      const penaltiesRes = await pool.query(`
        SELECT p.id, p.team_id, tm.team_name, p.round_number, p.reason, p.amount
        FROM penalties p
        JOIN teams tm ON tm.id = p.team_id
        WHERE p.game_id = $1 ORDER BY p.round_number ASC;
      `, [game.id]);

      // Stock price history round by round (scoped to this game)
      const pricesRes = await pool.query(`
        SELECT sp.stock_id, s.ticker, s.name, sp.round_number, sp.price
        FROM stock_prices sp
        JOIN stocks s ON s.id = sp.stock_id
        WHERE sp.game_id = $1 AND sp.round_number >= 0
        ORDER BY sp.stock_id, sp.round_number ASC;
      `, [game.id]);

      return res.json({
        success: true,
        gameId: game.id,
        gameName: game.name,
        gameStatus: game.status,
        tips: tipsRes.rows,
        leaderboard,
        penalties: penaltiesRes.rows,
        priceHistory: pricesRes.rows
      });

    } catch (err) {
      console.error('Debrief error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ─── HOST REST ENDPOINTS ──────────────────────────────────
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Host auth middleware
  function requireHost(req, res, next) {
    if (req.session.isHost || req.headers['x-host-key'] === (process.env.HOST_KEY || 'EIC_HOST_2026')) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Host authorization required.' });
  }

  // POST /api/market-mayhem/host/login
  app.post('/api/market-mayhem/host/login', (req, res) => {
    const { hostKey } = req.body;
    const validKey = process.env.HOST_KEY || 'EIC_HOST_2026';
    if (hostKey === validKey) {
      req.session.isHost = true;
      return res.json({ success: true, message: 'Host logged in successfully.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid Host Access Key.' });
  });

  // POST /api/market-mayhem/host/config — Configure game parameters
  app.post('/api/market-mayhem/host/config', requireHost, async (req, res) => {
    try {
      const { startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound, allowSolo } = req.body;
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

      await pool.query(`
        UPDATE games
        SET starting_cash = COALESCE($1, starting_cash),
            max_team_size = COALESCE($2, max_team_size),
            round_timer_seconds = COALESCE($3, round_timer_seconds),
            penalty_percentage = COALESCE($4, penalty_percentage),
            sebi_check_round = COALESCE($5, sebi_check_round),
            allow_solo = COALESCE($6, allow_solo)
        WHERE id = $7;
      `, [startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound,
          allowSolo !== undefined ? allowSolo : null, game.id]);

      await broadcastGameState(game.id);
      return res.json({ success: true, message: 'Game settings updated.' });
    } catch (err) {
      console.error('Host config error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });


  // POST /api/market-mayhem/host/phase-change — Control game phase state machine
  app.post('/api/market-mayhem/host/phase-change', requireHost, async (req, res) => {
    try {
      const { newPhase, newRound } = req.body;
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No active game found' });

      let roundToSet = newRound || game.current_round;
      let phaseToSet = newPhase || game.current_phase;
      let statusToSet = game.status;
      let isStartingGame = false;
      let isEndingGame = false;

      if (phaseToSet === 'START_GAME') {
        // Validate: need at least one team
        const teamsCount = await pool.query('SELECT COUNT(*) FROM teams WHERE game_id = $1;', [game.id]);
        if (parseInt(teamsCount.rows[0].count) === 0) {
          return res.status(400).json({ success: false, message: 'Cannot start: no teams have registered yet.' });
        }
        statusToSet = 'ACTIVE';
        phaseToSet = 'TIP_SHOP';  // Every round starts with TIP_SHOP
        roundToSet = 1;
        isStartingGame = true;
      } else if (phaseToSet === 'END_GAME') {
        // Host pressed END GAME — immediately end the game regardless of current round
        statusToSet = 'ENDED';
        phaseToSet = 'REVEAL';
        roundToSet = game.current_round; // keep current round
        isEndingGame = true;
      } else if (phaseToSet === 'NEXT_ROUND') {
        if (roundToSet >= 5) {
          statusToSet = 'ENDED';
          phaseToSet = 'REVEAL';
          isEndingGame = true;
        } else {
          roundToSet += 1;
          phaseToSet = 'TIP_SHOP';  // Every new round begins with TIP_SHOP
        }
      }

      // Fix: separate CASE logic to avoid PostgreSQL 42P08 type ambiguity
      // Use explicit JS conditionals to build the final UPDATE
      const now = new Date().toISOString();
      const shouldSetStartedAt = (statusToSet === 'ACTIVE' && !game.started_at);
      const shouldSetEndedAt = (statusToSet === 'ENDED');

      if (shouldSetStartedAt) {
        await pool.query(
          `UPDATE games SET status = $1, current_phase = $2, current_round = $3, started_at = CURRENT_TIMESTAMP WHERE id = $4;`,
          [statusToSet, phaseToSet, roundToSet, game.id]
        );
      } else if (shouldSetEndedAt) {
        await pool.query(
          `UPDATE games SET status = $1, current_phase = $2, current_round = $3, ended_at = CURRENT_TIMESTAMP WHERE id = $4;`,
          [statusToSet, phaseToSet, roundToSet, game.id]
        );
      } else {
        await pool.query(
          `UPDATE games SET status = $1, current_phase = $2, current_round = $3 WHERE id = $4;`,
          [statusToSet, phaseToSet, roundToSet, game.id]
        );
      }

      // If game is ending, stop the timer immediately
      if (isEndingGame) {
        stopRoundTimer(game.id);
      }

      // If phase changes to REVEAL, execute price engine
      if (phaseToSet === 'REVEAL') {
        await executePriceEngine(game.id, roundToSet);
      }

      // If phase is TRADING, start timer
      if (phaseToSet === 'TRADING') {
        startRoundTimer(game.id, game.round_timer_seconds);
      }

      // Emit phase-changed to all participants
      io.to(`game_${game.id}`).emit('phase-changed', {
        gameId: game.id,
        status: statusToSet,
        currentPhase: phaseToSet,
        currentRound: roundToSet
      });

      // If game was just started, emit dedicated game-started event
      if (isStartingGame) {
        io.to(`game_${game.id}`).emit('game-started', {
          gameId: game.id,
          status: statusToSet,
          round: roundToSet,
          phase: phaseToSet
        });
        console.log(`🚀 Game ${game.id} STARTED — emitting game-started to room game_${game.id}`);
      }

      // If game just ended, emit dedicated game-ended event with final leaderboard
      if (isEndingGame) {
        const finalLeaderboard = await getLeaderboard(game.id);
        io.to(`game_${game.id}`).emit('game-ended', {
          gameId: game.id,
          status: 'ENDED',
          currentPhase: phaseToSet,
          currentRound: roundToSet,
          leaderboard: finalLeaderboard,
          message: 'The game has ended. Final results are now available.'
        });
        console.log(`🏁 Game ${game.id} ENDED — emitting game-ended to room game_${game.id}`);
      }

      await broadcastGameState(game.id);

      return res.json({
        success: true,
        message: `Phase updated to ${phaseToSet} (Round ${roundToSet})`,
        status: statusToSet,
        phase: phaseToSet,
        round: roundToSet
      });

    } catch (err) {
      console.error('Phase change error:', err);
      res.status(500).json({ success: false, message: `Failed to change phase: ${err.message}` });
    }
  });

  // POST /api/market-mayhem/host/new-game — Create a fresh game after the current one ends
  // Validates previous game is ENDED before creating a new one with a new ID
  app.post('/api/market-mayhem/host/new-game', requireHost, async (req, res) => {
    const client = await pool.connect();
    try {
      const { gameName, startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound } = req.body;

      // Verify no currently active game exists
      const currentActive = await getActiveGame();
      if (currentActive) {
        return res.status(400).json({
          success: false,
          message: `Cannot create new game: Game "${currentActive.name}" (ID #${currentActive.id}) is still active. End it first.`
        });
      }

      const name = (gameName && gameName.trim()) || 'Market Mayhem';
      const cash = parseFloat(startingCash) || 100000.00;
      const teamSize = parseInt(maxTeamSize) || 4;
      const timer = parseInt(roundTimerSeconds) || 120;
      const penalty = parseFloat(penaltyPercentage) || 10.00;
      const sebi = parseInt(sebiCheckRound) || 4;

      await client.query('BEGIN');

      // Create fresh game row with a new ID — does NOT touch old game
      const gameRes = await client.query(`
        INSERT INTO games (name, status, starting_cash, max_team_size, round_timer_seconds, penalty_percentage, sebi_check_round, current_round, current_phase, allow_solo)
        VALUES ($1, 'LOBBY', $2, $3, $4, $5, $6, 1, 'LOBBY', TRUE)
        RETURNING *;
      `, [name, cash, teamSize, timer, penalty, sebi]);

      const newGame = gameRes.rows[0];

      // Seed fresh stocks, round events, and tips for the new game
      await seedNewGame(client, newGame.id);

      await client.query('COMMIT');

      console.log(`🎮 New game created via host/new-game: ID ${newGame.id} — ${newGame.name}`);

      return res.json({
        success: true,
        message: `New game "${newGame.name}" created successfully.`,
        game: {
          id: newGame.id,
          name: newGame.name,
          status: newGame.status,
          current_round: newGame.current_round,
          current_phase: newGame.current_phase,
          starting_cash: newGame.starting_cash,
          max_team_size: newGame.max_team_size,
          round_timer_seconds: newGame.round_timer_seconds,
          penalty_percentage: newGame.penalty_percentage,
          sebi_check_round: newGame.sebi_check_round,
          allow_solo: newGame.allow_solo
        }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('New game creation error:', err);
      res.status(500).json({ success: false, message: `Failed to create new game: ${err.message}` });
    } finally {
      client.release();
    }
  });

  // POST /api/market-mayhem/host/create-game — alias for /host/new-game (per spec)
  // Identical logic: validates previous game ENDED, creates a fresh game with new ID
  app.post('/api/market-mayhem/host/create-game', requireHost, async (req, res) => {
    const client = await pool.connect();
    try {
      const { gameName, startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound } = req.body;

      const currentActive = await getActiveGame();
      if (currentActive) {
        return res.status(400).json({
          success: false,
          message: `Cannot create new game: Game "${currentActive.name}" (ID #${currentActive.id}) is still active. End it first.`
        });
      }

      const name = (gameName && gameName.trim()) || 'Market Mayhem';
      const cash = parseFloat(startingCash) || 100000.00;
      const teamSize = parseInt(maxTeamSize) || 4;
      const timer = parseInt(roundTimerSeconds) || 120;
      const penalty = parseFloat(penaltyPercentage) || 10.00;
      const sebi = parseInt(sebiCheckRound) || 4;

      await client.query('BEGIN');

      const gameRes = await client.query(`
        INSERT INTO games (name, status, starting_cash, max_team_size, round_timer_seconds, penalty_percentage, sebi_check_round, current_round, current_phase, allow_solo)
        VALUES ($1, 'LOBBY', $2, $3, $4, $5, $6, 1, 'LOBBY', TRUE)
        RETURNING *;
      `, [name, cash, teamSize, timer, penalty, sebi]);

      const newGame = gameRes.rows[0];
      await seedNewGame(client, newGame.id);
      await client.query('COMMIT');

      console.log(`🎮 New game created via host/create-game: ID ${newGame.id} — ${newGame.name}`);

      return res.json({
        success: true,
        message: `New game "${newGame.name}" created successfully.`,
        game: {
          id: newGame.id, name: newGame.name, status: newGame.status,
          current_round: newGame.current_round, current_phase: newGame.current_phase,
          starting_cash: newGame.starting_cash, max_team_size: newGame.max_team_size,
          round_timer_seconds: newGame.round_timer_seconds, penalty_percentage: newGame.penalty_percentage,
          sebi_check_round: newGame.sebi_check_round, allow_solo: newGame.allow_solo
        }
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Create game error:', err);
      res.status(500).json({ success: false, message: `Failed to create game: ${err.message}` });
    } finally {
      client.release();
    }
  });

  // Price Calculation Engine (Strictly enforces -25% <= price_change <= +25%)
  async function executePriceEngine(gameId, roundNumber) {
    const eventsRes = await pool.query('SELECT stock_id, true_price_change, noise FROM round_events WHERE game_id = $1 AND round_number = $2;', [gameId, roundNumber]);
    const prevPricesRes = await pool.query(`
      SELECT DISTINCT ON (stock_id) stock_id, price FROM stock_prices
      WHERE game_id = $1 AND round_number < $2 ORDER BY stock_id, round_number DESC;
    `, [gameId, roundNumber]);

    const prevPriceMap = {};
    prevPricesRes.rows.forEach(r => prevPriceMap[r.stock_id] = parseFloat(r.price));

    for (const ev of eventsRes.rows) {
      const stockId = ev.stock_id;
      const prevPrice = prevPriceMap[stockId] || 100.00;

      let pctChange = parseFloat(ev.true_price_change) + parseFloat(ev.noise);
      // Hard clamp: -25% <= pctChange <= +25%
      pctChange = Math.max(-25.0, Math.min(25.0, pctChange));

      const newPrice = Math.max(1.0, Math.round((prevPrice * (1 + pctChange / 100)) * 100) / 100);

      // Insert new price for this round (guard against duplicates on repeated REVEAL)
      const existing = await pool.query('SELECT id FROM stock_prices WHERE game_id = $1 AND stock_id = $2 AND round_number = $3;', [gameId, stockId, roundNumber]);
      if (existing.rows.length === 0) {
        await pool.query(`
          INSERT INTO stock_prices (game_id, stock_id, round_number, price)
          VALUES ($1, $2, $3, $4);
        `, [gameId, stockId, roundNumber, newPrice]);
      }
    }

    // Record team value history at end of round
    const leaderboard = await getLeaderboard(gameId);
    for (const team of leaderboard) {
      // Avoid duplicate history records
      const existingHistory = await pool.query('SELECT id FROM team_value_history WHERE game_id = $1 AND team_id = $2 AND round_number = $3;', [gameId, team.teamId, roundNumber]);
      if (existingHistory.rows.length === 0) {
        await pool.query(`
          INSERT INTO team_value_history (game_id, team_id, round_number, cash_value, holdings_value, total_value)
          VALUES ($1, $2, $3, $4, $5, $6);
        `, [gameId, team.teamId, roundNumber, team.cashBalance, team.holdingsValue, team.totalValue]);
      }
    }
  }

  // GET /api/market-mayhem/game/:gameId/state — Player game state for a specific game
  app.get('/api/market-mayhem/game/:gameId/state', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const gameId = parseInt(req.params.gameId);
      if (isNaN(gameId)) return res.status(400).json({ success: false, message: 'Invalid game ID.' });

      const gameRes = await pool.query('SELECT * FROM games WHERE id = $1;', [gameId]);
      if (gameRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Game not found.' });

      const game = gameRes.rows[0];

      // Find player's team in this game
      const memberRes = await pool.query(`
        SELECT tm.team_id, t.team_name, t.team_code, t.cash_balance
        FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2;
      `, [req.session.userId, gameId]);

      let team = null;
      let holdings = [];

      if (memberRes.rows.length > 0) {
        const t = memberRes.rows[0];
        team = { id: t.team_id, name: t.team_name, code: t.team_code, cashBalance: parseFloat(t.cash_balance) };

        const hRes = await pool.query(`
          SELECT h.stock_id, h.quantity, s.name, s.ticker
          FROM holdings h JOIN stocks s ON s.id = h.stock_id
          WHERE h.team_id = $1 AND h.quantity > 0;
        `, [team.id]);
        holdings = hRes.rows;
      }

      const stocks = await getStockPrices(gameId, game.current_round);
      const leaderboard = await getLeaderboard(gameId);
      const timerInfo = activeTimers[gameId] ? activeTimers[gameId].remainingSeconds : game.round_timer_seconds;

      return res.json({
        success: true,
        game: {
          id: game.id,
          name: game.name,
          status: game.status,
          currentRound: game.current_round,
          currentPhase: game.current_phase,
          startingCash: parseFloat(game.starting_cash),
          roundTimerSeconds: game.round_timer_seconds,
          timerRemaining: timerInfo,
          allowSolo: game.allow_solo
        },
        team,
        holdings,
        stocks,
        leaderboard
      });
    } catch (err) {
      console.error('Game state error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /api/market-mayhem/host/market-event (Market Crash or Bull Run)
  app.post('/api/market-mayhem/host/market-event', requireHost, async (req, res) => {
    try {
      const { eventType } = req.body; // 'CRASH' or 'BULL_RUN'
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No active game found' });

      // Security: reject market events if game is ENDED
      if (game.status === 'ENDED') {
        return res.status(400).json({ success: false, message: 'Game has ended. Market events disabled.' });
      }

      const stocksRes = await pool.query('SELECT id FROM stocks WHERE game_id = $1;', [game.id]);

      for (const stock of stocksRes.rows) {
        // Calculate random movement: Crash (-15% to -25%), Bull Run (+15% to +25%)
        let change = eventType === 'CRASH'
          ? -(15 + Math.random() * 10)
          : (15 + Math.random() * 10);
        change = Math.max(-25.0, Math.min(25.0, change));

        // Get latest price
        const latestPriceRes = await pool.query('SELECT price FROM stock_prices WHERE game_id = $1 AND stock_id = $2 ORDER BY round_number DESC LIMIT 1;', [game.id, stock.id]);
        const currentP = latestPriceRes.rows.length > 0 ? parseFloat(latestPriceRes.rows[0].price) : 100.00;
        const newP = Math.max(1.0, Math.round((currentP * (1 + change / 100)) * 100) / 100);

        await pool.query('INSERT INTO stock_prices (game_id, stock_id, round_number, price) VALUES ($1, $2, $3, $4);', [game.id, stock.id, game.current_round, newP]);
      }

      await broadcastGameState(game.id);

      io.to(`game_${game.id}`).emit('market-event-triggered', {
        eventType,
        message: eventType === 'CRASH' ? '⚠️ MARKET CRASH TRIGGERED! High volatility across all sectors.' : '🚀 MARKET BULL RUN TRIGGERED! Sector-wide rally in progress.'
      });

      return res.json({ success: true, message: `Market event ${eventType} executed.` });

    } catch (err) {
      console.error('Market event error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /api/market-mayhem/host/pause-timer
  app.post('/api/market-mayhem/host/pause-timer', requireHost, async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });
      pauseRoundTimer(game.id);
      return res.json({ success: true, message: 'Timer paused.' });
    } catch (err) {
      console.error('Pause timer error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /api/market-mayhem/host/resume-timer
  app.post('/api/market-mayhem/host/resume-timer', requireHost, async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });
      resumeRoundTimer(game.id);
      return res.json({ success: true, message: 'Timer resumed.' });
    } catch (err) {
      console.error('Resume timer error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /api/market-mayhem/host/sebi-check — SEBI Regulatory Check for Insider Trading
  app.post('/api/market-mayhem/host/sebi-check', requireHost, async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No active game found' });

      // Security: reject SEBI check if game is ENDED
      if (game.status === 'ENDED') {
        return res.status(400).json({ success: false, message: 'Game has ended. SEBI check disabled.' });
      }

      const penaltyPct = parseFloat(game.penalty_percentage) / 100;
      const penaltiesApplied = [];

      // Find teams that bought flagged tips
      const flaggedPurchases = await pool.query(`
        SELECT DISTINCT tt.team_id, t.stock_id, t.round_number
        FROM team_tips tt
        JOIN tips t ON t.id = tt.tip_id
        WHERE t.game_id = $1 AND t.is_flagged = TRUE;
      `, [game.id]);

      for (const fp of flaggedPurchases.rows) {
        const teamId = fp.team_id;
        const stockId = fp.stock_id;

        // Check if team traded that stock (scoped to this game)
        const tradeCheck = await pool.query(`
          SELECT id FROM trades WHERE team_id = $1 AND stock_id = $2 AND game_id = $3;
        `, [teamId, stockId, game.id]);

        if (tradeCheck.rows.length > 0) {
          // Check if penalty already applied this round (scoped to this game)
          const existingPen = await pool.query('SELECT id FROM penalties WHERE team_id = $1 AND round_number = $2 AND game_id = $3;', [teamId, game.current_round, game.id]);
          if (existingPen.rows.length === 0) {
            // Get team total value
            const leaderboard = await getLeaderboard(game.id);
            const teamEntry = leaderboard.find(t => t.teamId === teamId);
            const portfolioVal = teamEntry ? teamEntry.totalValue : 100000;
            const penaltyAmt = Math.round(portfolioVal * penaltyPct * 100) / 100;

            // Apply penalty: deduct cash
            await pool.query('UPDATE teams SET cash_balance = GREATEST(0, cash_balance - $1) WHERE id = $2;', [penaltyAmt, teamId]);

            // Record penalty
            await pool.query(`
              INSERT INTO penalties (game_id, team_id, round_number, reason, amount)
              VALUES ($1, $2, $3, $4, $5);
            `, [game.id, teamId, game.current_round, 'REGULATORY PENALTY: Trading on flagged non-public insider tip.', penaltyAmt]);

            penaltiesApplied.push({ teamId, teamName: teamEntry ? teamEntry.teamName : 'Team', amount: penaltyAmt });

            // Notify team socket
            io.to(`team_${teamId}`).emit('sebi-penalty-applied', {
              penaltyAmount: penaltyAmt,
              reason: 'REGULATORY CHECK: A flagged stock was traded after your team purchased non-public insider information.'
            });
          }
        }
      }

      await broadcastGameState(game.id);

      return res.json({
        success: true,
        message: `SEBI Check executed. ${penaltiesApplied.length} teams penalized.`,
        penalties: penaltiesApplied
      });

    } catch (err) {
      console.error('SEBI check error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // POST /api/market-mayhem/host/super-tip/assign — Server-side Random Assignment of Super Tip
  app.post('/api/market-mayhem/host/super-tip/assign', requireHost, async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No active game found' });

      // Security: reject super tip assignment if game is ENDED
      if (game.status === 'ENDED') {
        return res.status(400).json({ success: false, message: 'Game has ended. Super tip assignment disabled.' });
      }

      // Find super tip for current round (scoped to this game)
      const tipRes = await pool.query('SELECT * FROM tips WHERE game_id = $1 AND round_number = $2 AND is_super_tip = TRUE LIMIT 1;', [game.id, game.current_round]);
      if (tipRes.rows.length === 0) {
        return res.status(404).json({ success: false, message: `No super tip found for Round ${game.current_round}` });
      }
      const superTip = tipRes.rows[0];

      // Find all teams in game
      const teamsRes = await pool.query('SELECT id, team_name FROM teams WHERE game_id = $1;', [game.id]);
      if (teamsRes.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'No teams registered in game.' });
      }

      // Pick random team server-side
      const teams = teamsRes.rows;
      const selectedTeam = teams[Math.floor(Math.random() * teams.length)];

      // Assign super tip (insert into team_tips)
      await pool.query(`
        INSERT INTO team_tips (team_id, tip_id, round_number)
        VALUES ($1, $2, $3)
        ON CONFLICT (team_id, tip_id) DO NOTHING;
      `, [selectedTeam.id, superTip.id, game.current_round]);

      // Stock details
      const stockRes = await pool.query('SELECT name, ticker FROM stocks WHERE id = $1;', [superTip.stock_id]);
      const stockName = stockRes.rows.length > 0 ? stockRes.rows[0].name : '';

      // Notify ONLY the selected team socket
      io.to(`team_${selectedTeam.id}`).emit('super-tip-assigned', {
        teamId: selectedTeam.id,
        tip: {
          purchase_id: Date.now(),
          round_number: game.current_round,
          tip_id: superTip.id,
          stock_id: superTip.stock_id,
          stock_name: stockName,
          text: superTip.text,
          source_label: superTip.source_label,
          price: 0,
          is_super_tip: true
        }
      });

      return res.json({
        success: true,
        message: `Super Tip randomly assigned to ${selectedTeam.team_name}.`,
        assignedTeam: selectedTeam.team_name
      });

    } catch (err) {
      console.error('Assign super tip error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ─── SOCKET.IO CONNECTIONS ────────────────────────────────
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  io.on('connection', (socket) => {
    // Player or host joins the game room
    socket.on('join-game-room', ({ gameId, teamId }) => {
      if (gameId) {
        socket.join(`game_${gameId}`);
        console.log(`Socket ${socket.id} joined room: game_${gameId}`);
      }
      if (teamId) {
        socket.join(`team_${teamId}`);
        console.log(`Socket ${socket.id} joined room: team_${teamId}`);
      }
    });

    socket.on('disconnect', () => {
      // Clean disconnect handling
    });
  });
}

module.exports = { setupMarketMayhem };
