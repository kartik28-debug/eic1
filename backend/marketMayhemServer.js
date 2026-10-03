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

  // Get or initialize active game
  async function getActiveGame() {
    const res = await pool.query("SELECT * FROM games WHERE status != 'ENDED' ORDER BY id DESC LIMIT 1;");
    if (res.rows.length > 0) {
      return res.rows[0];
    }
    // Fallback: get the latest game
    const latest = await pool.query("SELECT * FROM games ORDER BY id DESC LIMIT 1;");
    return latest.rows[0] || null;
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
      leaderboard: leaderboard
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
    }
  }

  function resumeRoundTimer(gameId) {
    if (activeTimers[gameId]) {
      activeTimers[gameId].isPaused = false;
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
  app.get('/api/market-mayhem/my-team', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const game = await getActiveGame();
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
  app.get('/api/market-mayhem/state', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No active game' });

      // Find user team
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

        // Holdings
        const hRes = await pool.query(`
          SELECT h.stock_id, h.quantity, s.name, s.ticker
          FROM holdings h
          JOIN stocks s ON s.id = h.stock_id
          WHERE h.team_id = $1 AND h.quantity > 0;
        `, [team.id]);
        holdings = hRes.rows;

        // Purchased Tips for team — HIDDEN FIELDS STRICTLY EXCLUDED!
        const tipsRes = await pool.query(`
          SELECT tt.id as purchase_id, tt.round_number, t.id as tip_id, t.stock_id, t.text, t.source_label, t.price, t.is_super_tip, s.name as stock_name, s.ticker as stock_ticker
          FROM team_tips tt
          JOIN tips t ON t.id = tt.tip_id
          JOIN stocks s ON s.id = t.stock_id
          WHERE tt.team_id = $1
          ORDER BY tt.purchased_at DESC;
        `, [team.id]);
        purchasedTips = tipsRes.rows;

        // Recent trades
        const tradesRes = await pool.query(`
          SELECT tr.id, tr.stock_id, s.ticker, s.name, tr.type, tr.quantity, tr.price, tr.total_value, tr.round_number, tr.created_at
          FROM trades tr
          JOIN stocks s ON s.id = tr.stock_id
          WHERE tr.team_id = $1
          ORDER BY tr.created_at DESC LIMIT 20;
        `, [team.id]);
        trades = tradesRes.rows;

        // Penalties
        const penRes = await pool.query(`
          SELECT id, round_number, reason, amount, created_at
          FROM penalties WHERE team_id = $1 ORDER BY created_at DESC;
        `, [team.id]);
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
      const availableTipsRes = await pool.query(`
        SELECT t.id, t.round_number, t.stock_id, s.name as stock_name, s.ticker as stock_ticker, t.text, t.source_label, t.price, t.is_super_tip
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

      if (game.status !== 'ACTIVE') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Game is not active.' });
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
        // Check current holding
        const holdingRes = await client.query(`
          SELECT quantity FROM holdings WHERE team_id = $1 AND stock_id = $2 FOR UPDATE;
        `, [teamId, stockId]);

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

        // Deduct holding
        await client.query(`
          UPDATE holdings SET quantity = quantity - $1 WHERE team_id = $2 AND stock_id = $3;
        `, [qty, teamId, stockId]);
      }

      // Insert trade record
      await client.query(`
        INSERT INTO trades (game_id, team_id, stock_id, type, quantity, price, total_value, round_number)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `, [game.id, teamId, stockId, tradeType, qty, price, totalCost, game.current_round]);

      await client.query('COMMIT');

      // Emit socket notification
      io.to(`team_${teamId}`).emit('trade-executed', {
        teamId,
        stockTicker: stock.ticker,
        type: tradeType,
        quantity: qty,
        price,
        totalValue: totalCost,
        newCashBalance: cashBalance
      });

      io.to(`game_${game.id}`).emit('leaderboard-updated', {
        leaderboard: await getLeaderboard(game.id)
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

      if (game.current_phase !== 'TIP_SHOP' && game.current_phase !== 'TRADING') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Tips can only be purchased during TIP_SHOP or TRADING phase.' });
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
  app.get('/api/market-mayhem/debrief', async (req, res) => {
    try {
      const game = await getActiveGame();
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

      // Penalties history
      const penaltiesRes = await pool.query(`
        SELECT p.id, p.team_id, tm.team_name, p.round_number, p.reason, p.amount
        FROM penalties p
        JOIN teams tm ON tm.id = p.team_id
        WHERE p.game_id = $1 ORDER BY p.round_number ASC;
      `, [game.id]);

      // Stock price history round by round
      const pricesRes = await pool.query(`
        SELECT sp.stock_id, s.ticker, s.name, sp.round_number, sp.price
        FROM stock_prices sp
        JOIN stocks s ON s.id = sp.stock_id
        WHERE sp.game_id = $1 AND sp.round_number >= 0
        ORDER BY sp.stock_id, sp.round_number ASC;
      `, [game.id]);

      return res.json({
        success: true,
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
      const { startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound } = req.body;
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

      await pool.query(`
        UPDATE games
        SET starting_cash = COALESCE($1, starting_cash),
            max_team_size = COALESCE($2, max_team_size),
            round_timer_seconds = COALESCE($3, round_timer_seconds),
            penalty_percentage = COALESCE($4, penalty_percentage),
            sebi_check_round = COALESCE($5, sebi_check_round)
        WHERE id = $6;
      `, [startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound, game.id]);

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
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

      let roundToSet = newRound || game.current_round;
      let phaseToSet = newPhase || game.current_phase;
      let statusToSet = game.status;

      if (phaseToSet === 'START_GAME') {
        statusToSet = 'ACTIVE';
        phaseToSet = 'BLOCK_DEAL';
        roundToSet = 1;
      } else if (phaseToSet === 'NEXT_ROUND') {
        if (roundToSet >= 5) {
          statusToSet = 'ENDED';
          phaseToSet = 'REVEAL';
        } else {
          roundToSet += 1;
          phaseToSet = 'BLOCK_DEAL';
        }
      }

      await pool.query(`
        UPDATE games
        SET status = $1, current_phase = $2, current_round = $3,
            started_at = CASE WHEN $1 = 'ACTIVE' AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
            ended_at = CASE WHEN $1 = 'ENDED' THEN CURRENT_TIMESTAMP ELSE ended_at END
        WHERE id = $4;
      `, [statusToSet, phaseToSet, roundToSet, game.id]);

      // If phase changes to REVEAL, execute price engine
      if (phaseToSet === 'REVEAL') {
        await executePriceEngine(game.id, roundToSet);
      }

      // If phase is TRADING, start timer
      if (phaseToSet === 'TRADING') {
        startRoundTimer(game.id, game.round_timer_seconds);
      }

      await broadcastGameState(game.id);

      io.to(`game_${game.id}`).emit('phase-changed', {
        gameId: game.id,
        status: statusToSet,
        currentPhase: phaseToSet,
        currentRound: roundToSet
      });

      return res.json({
        success: true,
        message: `Phase updated to ${phaseToSet} (Round ${roundToSet})`,
        status: statusToSet,
        phase: phaseToSet,
        round: roundToSet
      });

    } catch (err) {
      console.error('Phase change error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
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

      // Insert new price for this round
      await pool.query(`
        INSERT INTO stock_prices (game_id, stock_id, round_number, price)
        VALUES ($1, $2, $3, $4);
      `, [gameId, stockId, roundNumber, newPrice]);
    }

    // Record team value history at end of round
    const leaderboard = await getLeaderboard(gameId);
    for (const team of leaderboard) {
      await pool.query(`
        INSERT INTO team_value_history (game_id, team_id, round_number, cash_value, holdings_value, total_value)
        VALUES ($1, $2, $3, $4, $5, $6);
      `, [gameId, team.teamId, roundNumber, team.cashBalance, team.holdingsValue, team.totalValue]);
    }
  }

  // POST /api/market-mayhem/host/market-event (Market Crash or Bull Run)
  app.post('/api/market-mayhem/host/market-event', requireHost, async (req, res) => {
    try {
      const { eventType } = req.body; // 'CRASH' or 'BULL_RUN'
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

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

  // POST /api/market-mayhem/host/sebi-check — SEBI Regulatory Check for Insider Trading
  app.post('/api/market-mayhem/host/sebi-check', requireHost, async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

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

        // Check if team traded that stock
        const tradeCheck = await pool.query(`
          SELECT id FROM trades WHERE team_id = $1 AND stock_id = $2;
        `, [teamId, stockId]);

        if (tradeCheck.rows.length > 0) {
          // Check if penalty already applied
          const existingPen = await pool.query('SELECT id FROM penalties WHERE team_id = $1 AND round_number = $2;', [teamId, game.current_round]);
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
      if (!game) return res.status(404).json({ success: false, message: 'No game found' });

      // Find super tip for current round
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
    socket.on('join-game-room', ({ gameId, teamId }) => {
      if (gameId) {
        socket.join(`game_${gameId}`);
      }
      if (teamId) {
        socket.join(`team_${teamId}`);
      }
    });

    socket.on('disconnect', () => {
      // Clean disconnect handling
    });
  });
}

module.exports = { setupMarketMayhem };
