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

  // Auto-seed Round 3 events for existing games that have the 5 stocks if missing
  async function ensureRound3Data(pool) {
    try {
      const gamesRes = await pool.query(`
        SELECT DISTINCT g.id FROM games g
        JOIN stocks s ON s.game_id = g.id
        WHERE s.ticker IN ('RELY', 'ADHI', 'TATV', 'INFY-R', 'SMBR');
      `);

      for (const row of gamesRes.rows) {
        const gameId = row.id;
        const checkEv = await pool.query('SELECT COUNT(*) FROM round_events WHERE game_id = $1 AND round_number = 3;', [gameId]);
        if (parseInt(checkEv.rows[0].count) === 0) {
          const stocksRes = await pool.query('SELECT id, ticker FROM stocks WHERE game_id = $1;', [gameId]);
          const stockMap = {};
          stocksRes.rows.forEach(s => stockMap[s.ticker] = s.id);

          const r3Events = [
            { round: 3, ticker: 'RELY', block_deal_text: null, news_text: 'Festive-season retail sales stay strong across its stores.', true_price_change: 1.14, noise: 0.90 },
            { round: 3, ticker: 'RELY', block_deal_text: null, news_text: 'Crude oil prices rise again, and the telecom tariff review is still pending.', true_price_change: 0.00, noise: 0.00 },
            { round: 3, ticker: 'ADHI', block_deal_text: null, news_text: 'Approvals clear for a few delayed port and airport projects.', true_price_change: -3.09, noise: -1.40 },
            { round: 3, ticker: 'ADHI', block_deal_text: null, news_text: 'High interest rates keep its debt costs heavy.', true_price_change: 0.00, noise: 0.00 },
            { round: 3, ticker: 'TATV', block_deal_text: null, news_text: 'Festive vehicle bookings hit a seasonal peak.', true_price_change: 4.01, noise: 1.10 },
            { round: 3, ticker: 'TATV', block_deal_text: null, news_text: 'Metal input costs keep easing, though supply of popular models is tight.', true_price_change: 0.00, noise: 0.00 },
            { round: 3, ticker: 'INFY-R', block_deal_text: null, news_text: 'Several large client deals announced.', true_price_change: 1.09, noise: -0.60 },
            { round: 3, ticker: 'INFY-R', block_deal_text: null, news_text: 'Global IT spending remains cautious.', true_price_change: 0.00, noise: 0.00 },
            { round: 3, ticker: 'SMBR', block_deal_text: 'Block deal: Sell 0.7% stake in Sambar from Una.', news_text: 'Eating-out spending keeps rising in smaller cities.', true_price_change: 0.99, noise: 1.80 },
            { round: 3, ticker: 'SMBR', block_deal_text: null, news_text: 'Shares have run up sharply, and food input costs edge up.', true_price_change: 0.00, noise: 0.00 }
          ];

          for (const ev of r3Events) {
            if (stockMap[ev.ticker]) {
              await pool.query(
                'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
                [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
              );
            }
          }
          console.log(`✅ Seeded Round 3 events for Game ID ${gameId}`);
        }
      }
    } catch (e) {
      console.error('Error ensuring Round 3 data:', e);
    }
  }
  setTimeout(() => ensureRound3Data(pool), 1500);

  // Auto-seed Round 4 events and host-only SMBR insider tip for existing games
  async function ensureRound4Data(pool) {
    try {
      const gamesRes = await pool.query(`
        SELECT DISTINCT g.id FROM games g
        JOIN stocks s ON s.game_id = g.id
        WHERE s.ticker IN ('RELY', 'ADHI', 'TATV', 'INFY-R', 'SMBR');
      `);

      for (const row of gamesRes.rows) {
        const gameId = row.id;
        const checkEv = await pool.query('SELECT COUNT(*) FROM round_events WHERE game_id = $1 AND round_number = 4;', [gameId]);
        if (parseInt(checkEv.rows[0].count) === 0) {
          const stocksRes = await pool.query('SELECT id, ticker FROM stocks WHERE game_id = $1;', [gameId]);
          const stockMap = {};
          stocksRes.rows.forEach(s => stockMap[s.ticker] = s.id);

          const r4Events = [
            // RELY: +1.96% (÷4: +1.26%, noise: +0.70%) → ₹2,836.85 → ₹2,892.45
            { round: 4, ticker: 'RELY', block_deal_text: null, news_text: "Festive sales keep Relyant's retail stores busy.", true_price_change: 1.26, noise: 0.70 },
            { round: 4, ticker: 'RELY', block_deal_text: null, news_text: "Telecom tariff review ends with a modest hike, smaller than the market hoped.", true_price_change: 0.00, noise: 0.00 },
            // ADHI: -4.05% (÷4: -2.85%, noise: -1.20%) → ₹1,866.75 → ₹1,791.15
            { round: 4, ticker: 'ADHI', block_deal_text: null, news_text: "The central bank hints at a rate pause, offering some relief to debt-heavy infrastructure firms.", true_price_change: -2.85, noise: -1.20 },
            { round: 4, ticker: 'ADHI', block_deal_text: null, news_text: "Project approvals stay slow, and Adhira's high debt remains a worry.", true_price_change: 0.00, noise: 0.00 },
            // TATV: +2.85% (÷4: +3.65%, noise: -0.80%) → ₹1,191.18 → ₹1,225.13
            { round: 4, ticker: 'TATV', block_deal_text: null, news_text: "Tatva announces a new model launch for next quarter.", true_price_change: 3.65, noise: -0.80 },
            { round: 4, ticker: 'TATV', block_deal_text: null, news_text: "Festive bookings stay strong as metal prices keep easing.", true_price_change: 0.00, noise: 0.00 },
            // INFY-R: +2.46% (÷4: +1.16%, noise: +1.30%) → ₹1,641.80 → ₹1,682.19
            { round: 4, ticker: 'INFY-R', block_deal_text: null, news_text: "Deal pipeline looks steadier, with a few mid-sized client wins.", true_price_change: 1.16, noise: 1.30 },
            { round: 4, ticker: 'INFY-R', block_deal_text: null, news_text: "Clients are still cautious on tech budgets, so growth looks slow.", true_price_change: 0.00, noise: 0.00 },
            // SMBR: -10.00% (÷4: +3.04%, insider: -15%, noise: +1.96% -> move: -10.00%) → ₹477.32 → ₹429.59
            { round: 4, ticker: 'SMBR', block_deal_text: null, news_text: "Festive footfall is strong, and sales beat expectations at its outlets.", true_price_change: -11.96, noise: 1.96 },
            { round: 4, ticker: 'SMBR', block_deal_text: null, news_text: "The company announces new outlets in smaller cities.", true_price_change: 0.00, noise: 0.00 }
          ];

          for (const ev of r4Events) {
            if (stockMap[ev.ticker]) {
              await pool.query(
                'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
                [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
              );
            }
          }
          console.log(`✅ Seeded Round 4 events for Game ID ${gameId}`);
        }

        // Check Round 4 SMBR super tip (Host-only, true tip, effect: -15.00)
        const checkTip = await pool.query('SELECT COUNT(*) FROM tips WHERE game_id = $1 AND round_number = 4;', [gameId]);
        if (parseInt(checkTip.rows[0].count) === 0) {
          const stocksRes = await pool.query('SELECT id, ticker FROM stocks WHERE game_id = $1;', [gameId]);
          const stockMap = {};
          stocksRes.rows.forEach(s => stockMap[s.ticker] = s.id);

          if (stockMap['SMBR']) {
            await pool.query(
              'INSERT INTO tips (game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);',
              [
                gameId,
                4,
                stockMap['SMBR'],
                "SMBR's auditors have raised concerns about its accounts, and the promoter group is quietly selling shares. Expect a sharp fall.",
                'Auditor',
                0,
                true,
                true,
                -15.00,
                false
              ]
            );
            console.log(`✅ Seeded Round 4 SMBR super tip for Game ID ${gameId}`);
          }
        }
      }
    } catch (e) {
      console.error('Error ensuring Round 4 data:', e);
    }
  }
  setTimeout(() => ensureRound4Data(pool), 2000);

  // Auto-seed Round 5 events and host-only insider tips for existing games
  async function ensureRound5Data(pool) {
    try {
      const gamesRes = await pool.query(`
        SELECT DISTINCT g.id FROM games g
        JOIN stocks s ON s.game_id = g.id
        WHERE s.ticker IN ('RELY', 'ADHI', 'TATV', 'INFY-R', 'SMBR');
      `);

      for (const row of gamesRes.rows) {
        const gameId = row.id;
        const checkEv = await pool.query('SELECT COUNT(*) FROM round_events WHERE game_id = $1 AND round_number = 5;', [gameId]);
        if (parseInt(checkEv.rows[0].count) === 0) {
          const stocksRes = await pool.query('SELECT id, ticker FROM stocks WHERE game_id = $1;', [gameId]);
          const stockMap = {};
          stocksRes.rows.forEach(s => stockMap[s.ticker] = s.id);

          const r5Events = [
            // RELY: -4.74% (÷4: +1.76%, insider: -7%, noise: +0.50% -> net: -4.74%) → ₹2,892.45 → ₹2,755.35
            { round: 5, ticker: 'RELY', block_deal_text: null, news_text: "Relyant's retail stores report record festive sales, with strong demand for electronics and groceries.", true_price_change: -5.24, noise: 0.50 },
            { round: 5, ticker: 'RELY', block_deal_text: null, news_text: "The government opens bidding for large infrastructure and telecom projects, and Relyant is expected to take part.", true_price_change: 0.00, noise: 0.00 },
            // ADHI: -6.52% (÷4: -4.02%, insider: -3%, noise: +0.50% -> net: -6.52%) → ₹1,791.15 → ₹1,674.37
            { round: 5, ticker: 'ADHI', block_deal_text: 'Block deal: Sell 1.0% stake in Adhira Ports & Infra.', news_text: "Some foreign funds trim their holdings in infrastructure stocks, including Adhira, citing high interest rates.", true_price_change: -7.02, noise: 0.50 },
            { round: 5, ticker: 'ADHI', block_deal_text: null, news_text: "Several port and airport approvals remain stuck, and Adhira's high debt keeps analysts cautious.", true_price_change: 0.00, noise: 0.00 },
            // TATV: +6.98% (÷4: +4.48%, insider: +3%, noise: -0.50% -> net: +6.98%) → ₹1,225.13 → ₹1,310.64
            { round: 5, ticker: 'TATV', block_deal_text: 'Block deal: Buy 0.6% stake in Tatva Motors.', news_text: "Tatva's festive-season sales hit a record, with waiting periods on popular models stretching to several weeks.", true_price_change: 7.48, noise: -0.50 },
            { round: 5, ticker: 'TATV', block_deal_text: null, news_text: "Reports say the government is studying support for electric vehicles, which could help Tatva's upcoming models.", true_price_change: 0.00, noise: 0.00 },
            // INFY-R: +5.07% (÷4: +1.37%, insider: +4%, noise: -0.30% -> net: +5.07%) → ₹1,682.19 → ₹1,767.48
            { round: 5, ticker: 'INFY-R', block_deal_text: null, news_text: "Infyra signs a few mid-sized deals with overseas clients as tech budgets slowly open up.", true_price_change: 5.37, noise: -0.30 },
            { round: 5, ticker: 'INFY-R', block_deal_text: null, news_text: "The weaker rupee gives a small boost to Infyra's earnings, though client caution remains.", true_price_change: 0.00, noise: 0.00 },
            // SMBR: +0.10% (÷4: -0.16%, insider: 0%, noise: +0.26% -> net: +0.10%) → ₹429.59 → ₹430.02
            { round: 5, ticker: 'SMBR', block_deal_text: 'Block deal: Sell 1.5% stake in Sambar from Una.', news_text: "After last month's sharp fall, Sambar from Una says business is normal and outlets remain busy.", true_price_change: -0.16, noise: 0.26 },
            { round: 5, ticker: 'SMBR', block_deal_text: null, news_text: "Some investors ask for clearer accounts, so the stock stays under watch.", true_price_change: 0.00, noise: 0.00 }
          ];

          for (const ev of r5Events) {
            if (stockMap[ev.ticker]) {
              await pool.query(
                'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
                [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
              );
            }
          }
          console.log(`✅ Seeded Round 5 events for Game ID ${gameId}`);
        }

        // Check Round 5 Insider Tips (Host-only, 5 tips)
        const checkTips = await pool.query('SELECT COUNT(*) FROM tips WHERE game_id = $1 AND round_number = 5;', [gameId]);
        if (parseInt(checkTips.rows[0].count) === 0) {
          const stocksRes = await pool.query('SELECT id, ticker FROM stocks WHERE game_id = $1;', [gameId]);
          const stockMap = {};
          stocksRes.rows.forEach(s => stockMap[s.ticker] = s.id);

          const r5Tips = [
            {
              ticker: 'RELY', source: 'Political Contact', price: 0, isSuper: true,
              isTrue: false, effect: -7.00, isFlagged: false,
              text: "Netaji Sahab was seen having chai with Mota Seth in a Delhi dhaba. A mega government contract for Relyant is signed, and the shares will zoom!"
            },
            {
              ticker: 'ADHI', source: 'Research Analyst', price: 0, isSuper: true,
              isTrue: true, effect: -3.00, isFlagged: false,
              text: "Hindenbird Research is about to drop a 400-page report on Adhira. Their analyst has already sold his own flat to short the stock."
            },
            {
              ticker: 'TATV', source: 'Government Source', price: 0, isSuper: true,
              isTrue: true, effect: 3.00, isFlagged: false,
              text: "A minister's cousin says the electric-vehicle subsidy is coming, and he has already ordered 3 Tatva cars to be safe."
            },
            {
              ticker: 'INFY-R', source: 'Corporate Insider', price: 0, isSuper: true,
              isTrue: true, effect: 4.00, isFlagged: false,
              text: "Infyra's biggest US client is quietly renewing its mega contract. The CEO was caught celebrating with extra filter coffee."
            },
            {
              ticker: 'SMBR', source: 'Food Critic', price: 0, isSuper: true,
              isTrue: false, effect: 0.00, isFlagged: false,
              text: "A famous food influencer tasted the sambar and made a face on camera. The shares will crash by Monday!"
            }
          ];

          for (const t of r5Tips) {
            if (stockMap[t.ticker]) {
              await pool.query(
                'INSERT INTO tips (game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);',
                [gameId, 5, stockMap[t.ticker], t.text, t.source, t.price, t.isSuper, t.isTrue, t.effect, t.isFlagged]
              );
            }
          }
          console.log(`✅ Seeded Round 5 insider tips for Game ID ${gameId}`);
        }
      }
    } catch (e) {
      console.error('Error ensuring Round 5 data:', e);
    }
  }
  setTimeout(() => ensureRound5Data(pool), 2500);

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

  // Get prices for a specific round (accurately carries forward previous round closing price)
  async function getStockPrices(gameId, roundNumber) {
    const query = `
      SELECT DISTINCT ON (s.id) 
        s.id, s.name, s.ticker, s.sector, s.description, s.volatility,
        COALESCE(p_latest.price, p0.price, 100.00) as current_price,
        COALESCE(p_prev.price, p0.price, 100.00) as initial_price
      FROM stocks s
      LEFT JOIN LATERAL (
        SELECT price FROM stock_prices
        WHERE stock_id = s.id AND game_id = s.game_id AND round_number <= $2
        ORDER BY round_number DESC LIMIT 1
      ) p_latest ON true
      LEFT JOIN LATERAL (
        SELECT price FROM stock_prices
        WHERE stock_id = s.id AND game_id = s.game_id AND round_number < $2
        ORDER BY round_number DESC LIMIT 1
      ) p_prev ON true
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
  // ── ROUND 1 CONFIGURATION ──────────────────────────────────────────────────
  // All price engine values (true_price_change, noise) are HOST/ENGINE ONLY.
  // They are stored in round_events but NEVER sent to the player-facing API.
  // noise is set to 0.00 for Round 1 so the engine produces exact final prices.
  // ─────────────────────────────────────────────────────────────────────────────
  async function seedNewGame(client, gameId) {
    // ── Round 1 stocks ──
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
      const r = await client.query(
        'INSERT INTO stocks (game_id, name, ticker, sector, description, volatility) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id;',
        [gameId, s.name, s.ticker, s.sector, s.description, s.volatility]
      );
      const stockId = r.rows[0].id;
      stockMap[s.ticker] = stockId;
      // Round 0 = reference/starting price shown to students
      await client.query('INSERT INTO stock_prices (game_id, stock_id, round_number, price) VALUES ($1,$2,0,$3);', [gameId, stockId, s.initialPrice]);
      // Historical prices (rounds -5 to -1) — used for chart display only
      for (let idx = 0; idx < s.historical.length; idx++) {
        await client.query('INSERT INTO stock_prices (game_id, stock_id, round_number, price) VALUES ($1,$2,$3,$4);', [gameId, stockId, -5 + idx, s.historical[idx]]);
      }
    }

    // ── Round 1 news events ──
    // Each stock has 2 news items (block_deal_text = null for all Round 1 stocks).
    // true_price_change is the EXACT final movement % for Round 1 (HOST/ENGINE ONLY).
    // noise is 0.00 so executePriceEngine produces deterministic, exact final prices.
    // Combined for each stock:
    //   RELY: -2.75%  → ₹2,880.00 → ₹2,800.80
    //   ADHI: -11.00% → ₹2,350.00 → ₹2,091.50
    //   TATV: +11.00% → ₹960.00   → ₹1,065.60
    //   INFY-R: +3.00%→ ₹1,540.00 → ₹1,586.20
    //   SMBR: +13.50% → ₹410.00   → ₹465.35
    //
    // SECURITY: true_price_change and noise are NEVER included in player API responses.
    // The round_events query in the player state endpoint selects only:
    //   round_number, stock_id, ticker, stock_name, block_deal_text, news_text
    //
    // For Round 1, the price engine uses stock-level aggregated true_price_change.
    // We store 2 events per stock — both with noise=0 and true_price_change split
    // so their SUM equals the required final movement.
    // Engine processes one row per stock_id per round; if two rows exist for the
    // same stock in the same round, only the first is used. Therefore we consolidate
    // to ONE row per stock carrying the full final movement percentage.
    // The second news item is stored with true_price_change=0 and noise=0 (display only).
    const roundEventsData = [
      // RELY — Relyant Industries  (Final: -2.75%, noise=0)
      {
        round: 1, ticker: 'RELY', block_deal_text: null,
        news_text: "Relyant's retail arm reports its busiest month of store footfall this year, with festive-season stocking starting early.",
        true_price_change: -2.75, noise: 0.00
      },
      {
        round: 1, ticker: 'RELY', block_deal_text: null,
        news_text: "Relyant's telecom unit says tariff talks with regulators have not started, so no pricing change is expected soon.",
        true_price_change: 0.00, noise: 0.00  // Display-only; final move already encoded above
      },
      // ADHI — Adhira Ports & Infra  (Final: -11.00%, noise=0)
      {
        round: 1, ticker: 'ADHI', block_deal_text: null,
        news_text: "Adhira's new port expansion is stuck waiting for approvals, and its financing costs keep rising as interest rates stay high.",
        true_price_change: -11.00, noise: 0.00
      },
      {
        round: 1, ticker: 'ADHI', block_deal_text: null,
        news_text: 'Adhira signs a long-term cargo handling contract with a shipping line, adding steady port revenue over the coming years.',
        true_price_change: 0.00, noise: 0.00  // Display-only
      },
      // TATV — Tatva Motors  (Final: +11.00%, noise=0)
      {
        round: 1, ticker: 'TATV', block_deal_text: null,
        news_text: "Tatva's vehicle bookings are up sharply ahead of the festive season, and dealers report waiting lists on its top models.",
        true_price_change: 11.00, noise: 0.00
      },
      {
        round: 1, ticker: 'TATV', block_deal_text: null,
        news_text: "Falling steel and aluminium prices are expected to improve Tatva's profit margins.",
        true_price_change: 0.00, noise: 0.00  // Display-only
      },
      // INFY-R — Infyra Technologies  (Final: +3.00%, noise=0)
      {
        round: 1, ticker: 'INFY-R', block_deal_text: null,
        news_text: 'Infyra wins a cloud migration contract from a large European retailer.',
        true_price_change: 3.00, noise: 0.00
      },
      {
        round: 1, ticker: 'INFY-R', block_deal_text: null,
        news_text: 'Infyra says some clients are delaying new technology spending until next year.',
        true_price_change: 0.00, noise: 0.00  // Display-only
      },
      // SMBR — Sambar from Una  (Final: +13.50%, noise=0)
      {
        round: 1, ticker: 'SMBR', block_deal_text: null,
        news_text: 'Sambar from Una opens three new outlets in smaller cities, and early crowds are strong.',
        true_price_change: 13.50, noise: 0.00
      },
      {
        round: 1, ticker: 'SMBR', block_deal_text: null,
        news_text: 'A food-industry survey says people are eating out more often in smaller cities, a market Sambar already serves.',
        true_price_change: 0.00, noise: 0.00  // Display-only
      }
    ];
    for (const ev of roundEventsData) {
      await client.query(
        'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
        [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
      );
    }

    // ── Round 1 insider tips ──
    // SECURITY: is_true, effect_size, is_flagged are HOST/ENGINE ONLY.
    // The player tip-shop API exposes ONLY: id, round_number, stock_id (NOT), source_label, price, is_super_tip.
    // stock_id is intentionally NOT sent to players before purchase.
    // After purchase, text is revealed but stock mapping, direction, and effect are NOT.
    const tipsData = [
      {
        round: 1, ticker: 'SMBR',
        source: 'Board Member', price: 3000, isSuper: false,
        isTrue: true, effect: 11.0, isFlagged: false,
        text: 'Something big is coming for Sambar. Sources say a major supplier tie-up is about to be announced.'
      },
      {
        round: 1, ticker: 'ADHI',
        source: 'Middle Manager', price: 1500, isSuper: false,
        isTrue: true, effect: -5.0, isFlagged: false,
        text: "Adhira's expansion trouble is worse than the public news suggests. Lenders are getting nervous."
      },
      {
        round: 1, ticker: 'TATV',
        source: 'Clerk', price: 500, isSuper: false,
        isTrue: true, effect: 5.0, isFlagged: false,
        text: "Tatva's order book is stronger than reported, and a large fleet order may be on the way."
      },
      {
        round: 1, ticker: 'INFY-R',
        source: 'Clerk', price: 500, isSuper: false,
        isTrue: true, effect: 1.0, isFlagged: false,
        text: 'Infyra may land a small extra contract this month. Not a huge deal, but positive.'
      }
    ];
    for (const t of tipsData) {
      await client.query(
        'INSERT INTO tips (game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);',
        [gameId, t.round, stockMap[t.ticker], t.text, t.source, t.price, t.isSuper, t.isTrue, t.effect, t.isFlagged]
      );
    }

    // ── ROUND 2 DATA ──────────────────────────────────────────────────────────────
    //
    // Round 2 OPENS at Round 1 closing prices (computed by REVEAL and stored as
    // stock_prices with round_number = 1). The price engine for Round 2 uses
    //   prevPrice = stock_prices WHERE round_number < 2 ORDER BY round_number DESC
    // which picks round 1 prices automatically — no manual override required.
    //
    // Round 2 EXACT final prices (all noise pre-computed; noise stored separately):
    //   RELY   ₹2,800.80 → ₹2,780.14  (-0.7375%, noise=0.00)
    //   ADHI   ₹2,091.50 → ₹1,954.51  (-6.55%,   noise=0.00)
    //   TATV   ₹1,065.60 → ₹1,133.27  (+6.35%,   noise=0.00)
    //   INFY-R ₹1,586.20 → ₹1,633.79  (+3.00%,   noise=0.00)
    //   SMBR   ₹465.35   → ₹464.36    (-0.213%,  noise=0.00)
    //
    // SECURITY: true_price_change, noise are HOST/ENGINE ONLY — never sent to players.
    // Block deal info (visible to students via block_deal_text):
    //   ADHI: SELL 3.2%  |  TATV: BUY 2.4%  |  INFY-R: BUY 0.8%
    //   RELY: none        |  SMBR: none
    // ─────────────────────────────────────────────────────────────────────────────
    const round2EventsData = [
      // RELY — Final: -0.7375%, noise=0.00 → ₹2,800.80 → ₹2,780.14
      {
        round: 2, ticker: 'RELY', block_deal_text: null,
        news_text: "Relyant's retail arm reports a pickup in sales as the festive season gets closer, with stores restocking early.",
        true_price_change: -0.7375, noise: 0.00  // PRIMARY — carries full final move
      },
      {
        round: 2, ticker: 'RELY', block_deal_text: null,
        news_text: "Crude oil prices hold steady, keeping Relyant's energy margins stable, while a telecom tariff review is still pending.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // ADHI — Final: -6.55%, noise=0.00 → ₹2,091.50 → ₹1,954.51
      {
        round: 2, ticker: 'ADHI',
        block_deal_text: 'Block deal: 3.2% stake in Adhira Ports & Infra sold via open market transaction.',
        news_text: "Several Adhira port and airport projects are delayed, and higher interest rates are raising the cost of its debt.",
        true_price_change: -6.55, noise: 0.00  // PRIMARY
      },
      {
        round: 2, ticker: 'ADHI', block_deal_text: null,
        news_text: "Analysts warn that Adhira's heavy debt is limiting its room to start new projects.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // TATV — Final: +6.35%, noise=0.00 → ₹1,065.60 → ₹1,133.27
      {
        round: 2, ticker: 'TATV',
        block_deal_text: 'Block deal: Institutional investor acquires 2.4% stake in Tatva Motors.',
        news_text: "Festive-season bookings at Tatva are strong, with dealers reporting longer waiting times on several models.",
        true_price_change: 6.35, noise: 0.00  // PRIMARY
      },
      {
        round: 2, ticker: 'TATV', block_deal_text: null,
        news_text: "Easing metal prices lower Tatva's input costs, which should help its margins.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // INFY-R — Final: +3.00%, noise=0.00 → ₹1,586.20 → ₹1,633.79
      {
        round: 2, ticker: 'INFY-R',
        block_deal_text: 'Block deal: 0.8% stake in Infyra Technologies acquired by institutional buyer.',
        news_text: "Infyra's latest update shows slower new deal wins, with some clients pausing technology projects.",
        true_price_change: 3.00, noise: 0.00  // PRIMARY
      },
      {
        round: 2, ticker: 'INFY-R', block_deal_text: null,
        news_text: "A weaker rupee gives Infyra's export earnings a small lift.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // SMBR — Final: -0.213%, noise=0.00 → ₹465.35 → ₹464.36
      {
        round: 2, ticker: 'SMBR', block_deal_text: null,
        news_text: "Sambar from Una's festive menu launch draws bigger crowds than expected at its newer outlets.",
        true_price_change: -0.213, noise: 0.00  // PRIMARY
      },
      {
        round: 2, ticker: 'SMBR', block_deal_text: null,
        news_text: 'Food costs stay stable, helping Sambar from Una keep its prices unchanged.',
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      }
    ];
    for (const ev of round2EventsData) {
      await client.query(
        'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
        [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
      );
    }

    // ── Round 2 insider tips ──
    // Both tips are FALSE. Insider effect = 0 for both.
    // SECURITY: is_true, effect_size, is_flagged, stock mapping are HOST/ENGINE ONLY.
    // Player tip-shop sees ONLY: id, round_number, source_label, price, is_super_tip.
    const round2TipsData = [
      {
        round: 2, ticker: 'ADHI',
        source: 'Board Member', price: 3000, isSuper: false,
        isTrue: false, effect: 0.0, isFlagged: false,
        text: 'A large buyer is lining up to take a big stake in Adhira. Expect a jump.'
      },
      {
        round: 2, ticker: 'SMBR',
        source: 'Middle Manager', price: 1500, isSuper: false,
        isTrue: false, effect: 0.0, isFlagged: false,
        text: 'Sambar from Una is about to announce a big new partnership.'
      }
    ];
    for (const t of round2TipsData) {
      await client.query(
        'INSERT INTO tips (game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);',
        [gameId, t.round, stockMap[t.ticker], t.text, t.source, t.price, t.isSuper, t.isTrue, t.effect, t.isFlagged]
      );
    }

    // ── ROUND 3 DATA ──────────────────────────────────────────────────────────────
    //
    // Round 3 OPENS at Round 2 closing prices (computed by REVEAL and stored as
    // stock_prices with round_number = 2):
    //   RELY   ₹2,780.14
    //   ADHI   ₹1,954.51
    //   TATV   ₹1,133.27
    //   INFY-R ₹1,633.79
    //   SMBR   ₹464.36
    //
    // Round 3 EXACT final prices & engine movements (from engine-result screenshot):
    //   RELY   ₹2,780.14 → ₹2,836.85  (+2.04%: true_price_change = +1.14%, noise = +0.90%)
    //   ADHI   ₹1,954.51 → ₹1,866.75  (-4.49%: true_price_change = -3.09%, noise = -1.40%)
    //   TATV   ₹1,133.27 → ₹1,191.18  (+5.11%: true_price_change = +4.01%, noise = +1.10%)
    //   INFY-R ₹1,633.79 → ₹1,641.80  (+0.49%: true_price_change = +1.09%, noise = -0.60%)
    //   SMBR   ₹464.36   → ₹477.32    (+2.79%: true_price_change = +0.99%, noise = +1.80%)
    //
    // Insider effect for Round 3 = 0 for all five stocks.
    //
    // SECURITY: true_price_change, noise are HOST/ENGINE ONLY — never sent to players.
    // Block deal info (visible to students via block_deal_text):
    //   SMBR: Sell 0.7% stake (PDF page 9)
    //   RELY, ADHI, TATV, INFY-R: None
    //
    // News for Round 3 (two per stock, exactly as shown in screenshot):
    //   RELY:
    //     News 1: "Festive-season retail sales stay strong across its stores."
    //     News 2: "Crude oil prices rise again, and the telecom tariff review is still pending."
    //   ADHI:
    //     News 1: "Approvals clear for a few delayed port and airport projects."
    //     News 2: "High interest rates keep its debt costs heavy."
    //   TATV:
    //     News 1: "Festive vehicle bookings hit a seasonal peak."
    //     News 2: "Metal input costs keep easing, though supply of popular models is tight."
    //   INFY-R:
    //     News 1: "Several large client deals announced."
    //     News 2: "Global IT spending remains cautious."
    //   SMBR:
    //     News 1: "Eating-out spending keeps rising in smaller cities."
    //     News 2: "Shares have run up sharply, and food input costs edge up."
    // ─────────────────────────────────────────────────────────────────────────────
    const round3EventsData = [
      // RELY — Final: +2.04% (÷4: +1.14%, noise: +0.90%) → ₹2,780.14 → ₹2,836.85
      {
        round: 3, ticker: 'RELY', block_deal_text: null,
        news_text: 'Festive-season retail sales stay strong across its stores.',
        true_price_change: 1.14, noise: 0.90  // PRIMARY
      },
      {
        round: 3, ticker: 'RELY', block_deal_text: null,
        news_text: 'Crude oil prices rise again, and the telecom tariff review is still pending.',
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // ADHI — Final: -4.49% (÷4: -3.09%, noise: -1.40%) → ₹1,954.51 → ₹1,866.75
      {
        round: 3, ticker: 'ADHI', block_deal_text: null,
        news_text: 'Approvals clear for a few delayed port and airport projects.',
        true_price_change: -3.09, noise: -1.40  // PRIMARY
      },
      {
        round: 3, ticker: 'ADHI', block_deal_text: null,
        news_text: 'High interest rates keep its debt costs heavy.',
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // TATV — Final: +5.11% (÷4: +4.01%, noise: +1.10%) → ₹1,133.27 → ₹1,191.18
      {
        round: 3, ticker: 'TATV', block_deal_text: null,
        news_text: 'Festive vehicle bookings hit a seasonal peak.',
        true_price_change: 4.01, noise: 1.10  // PRIMARY
      },
      {
        round: 3, ticker: 'TATV', block_deal_text: null,
        news_text: 'Metal input costs keep easing, though supply of popular models is tight.',
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // INFY-R — Final: +0.49% (÷4: +1.09%, noise: -0.60%) → ₹1,633.79 → ₹1,641.80
      {
        round: 3, ticker: 'INFY-R', block_deal_text: null,
        news_text: 'Several large client deals announced.',
        true_price_change: 1.09, noise: -0.60  // PRIMARY
      },
      {
        round: 3, ticker: 'INFY-R', block_deal_text: null,
        news_text: 'Global IT spending remains cautious.',
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // SMBR — Final: +2.79% (÷4: +0.99%, noise: +1.80%) → ₹464.36 → ₹477.32
      {
        round: 3, ticker: 'SMBR',
        block_deal_text: 'Block deal: Sell 0.7% stake in Sambar from Una.',
        news_text: 'Eating-out spending keeps rising in smaller cities.',
        true_price_change: 0.99, noise: 1.80  // PRIMARY
      },
      {
        round: 3, ticker: 'SMBR', block_deal_text: null,
        news_text: 'Shares have run up sharply, and food input costs edge up.',
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      }
    ];
    for (const ev of round3EventsData) {
      await client.query(
        'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
        [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
      );
    }

    // ── ROUND 4 DATA ──────────────────────────────────────────────────────────────
    //
    // Round 4 OPENS at Round 3 closing prices (computed by REVEAL and stored as
    // stock_prices with round_number = 3):
    //   RELY   ₹2,836.85
    //   ADHI   ₹1,866.75
    //   TATV   ₹1,191.18
    //   INFY-R ₹1,641.80
    //   SMBR   ₹477.32
    //
    // Round 4 EXACT final prices & engine movements (from engine-result screenshot):
    //   RELY   ₹2,836.85 → ₹2,892.45  (+1.96%: ÷4 = +1.26%, noise = +0.70%)
    //   ADHI   ₹1,866.75 → ₹1,791.15  (-4.05%: ÷4 = -2.85%, noise = -1.20%)
    //   TATV   ₹1,191.18 → ₹1,225.13  (+2.85%: ÷4 = +3.65%, noise = -0.80%)
    //   INFY-R ₹1,641.80 → ₹1,682.19  (+2.46%: ÷4 = +1.16%, noise = +1.30%)
    //   SMBR   ₹477.32   → ₹429.59    (-10.00%: ÷4 = +3.04%, insider = -15%, noise = +1.96% -> move = -10.00%)
    //
    // Host-only SMBR insider tip:
    //   Tip: "SMBR's auditors have raised concerns about its accounts, and the promoter group is quietly selling shares. Expect a sharp fall."
    //   Source: 'Auditor', is_true = true, effect_size = -15.00, is_super_tip = true, is_flagged = false, price = 0
    //   Assigned via host super-tip assignment mechanism to selected teams only.
    //
    // SECURITY: true_price_change, noise, is_true, effect_size are HOST/ENGINE ONLY.
    // Block deal info: None for all stocks (PDF pages 1, 3, 5, 7, 9)
    // ─────────────────────────────────────────────────────────────────────────────
    const round4EventsData = [
      // RELY — Final: +1.96% (÷4: +1.26%, noise: +0.70%) → ₹2,836.85 → ₹2,892.45
      {
        round: 4, ticker: 'RELY', block_deal_text: null,
        news_text: "Festive sales keep Relyant's retail stores busy.",
        true_price_change: 1.26, noise: 0.70  // PRIMARY
      },
      {
        round: 4, ticker: 'RELY', block_deal_text: null,
        news_text: "Telecom tariff review ends with a modest hike, smaller than the market hoped.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // ADHI — Final: -4.05% (÷4: -2.85%, noise: -1.20%) → ₹1,866.75 → ₹1,791.15
      {
        round: 4, ticker: 'ADHI', block_deal_text: null,
        news_text: "The central bank hints at a rate pause, offering some relief to debt-heavy infrastructure firms.",
        true_price_change: -2.85, noise: -1.20  // PRIMARY
      },
      {
        round: 4, ticker: 'ADHI', block_deal_text: null,
        news_text: "Project approvals stay slow, and Adhira's high debt remains a worry.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // TATV — Final: +2.85% (÷4: +3.65%, noise: -0.80%) → ₹1,191.18 → ₹1,225.13
      {
        round: 4, ticker: 'TATV', block_deal_text: null,
        news_text: "Tatva announces a new model launch for next quarter.",
        true_price_change: 3.65, noise: -0.80  // PRIMARY
      },
      {
        round: 4, ticker: 'TATV', block_deal_text: null,
        news_text: "Festive bookings stay strong as metal prices keep easing.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // INFY-R — Final: +2.46% (÷4: +1.16%, noise: +1.30%) → ₹1,641.80 → ₹1,682.19
      {
        round: 4, ticker: 'INFY-R', block_deal_text: null,
        news_text: "Deal pipeline looks steadier, with a few mid-sized client wins.",
        true_price_change: 1.16, noise: 1.30  // PRIMARY
      },
      {
        round: 4, ticker: 'INFY-R', block_deal_text: null,
        news_text: "Clients are still cautious on tech budgets, so growth looks slow.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // SMBR — Final: -10.00% (÷4: +3.04%, insider: -15%, noise: +1.96% -> move: -10.00%) → ₹477.32 → ₹429.59
      {
        round: 4, ticker: 'SMBR', block_deal_text: null,
        news_text: "Festive footfall is strong, and sales beat expectations at its outlets.",
        true_price_change: -11.96, noise: 1.96  // PRIMARY (3.04 - 15 = -11.96, + 1.96 noise = -10.00%)
      },
      {
        round: 4, ticker: 'SMBR', block_deal_text: null,
        news_text: "The company announces new outlets in smaller cities.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      }
    ];
    for (const ev of round4EventsData) {
      await client.query(
        'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
        [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
      );
    }

    // ── Round 4 Insider Tip (Host-only SMBR super tip) ──
    const round4TipsData = [
      {
        round: 4, ticker: 'SMBR',
        source: 'Auditor', price: 0, isSuper: true,
        isTrue: true, effect: -15.00, isFlagged: false,
        text: "SMBR's auditors have raised concerns about its accounts, and the promoter group is quietly selling shares. Expect a sharp fall."
      }
    ];
    for (const t of round4TipsData) {
      await client.query(
        'INSERT INTO tips (game_id, round_number, stock_id, text, source_label, price, is_super_tip, is_true, effect_size, is_flagged) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);',
        [gameId, t.round, stockMap[t.ticker], t.text, t.source, t.price, t.isSuper, t.isTrue, t.effect, t.isFlagged]
      );
    }

    // ── ROUND 5 DATA (FINAL ROUND) ────────────────────────────────────────────────
    //
    // Round 5 OPENS at Round 4 closing prices (computed by REVEAL and stored as
    // stock_prices with round_number = 4):
    //   RELY   ₹2,892.45
    //   ADHI   ₹1,791.15
    //   TATV   ₹1,225.13
    //   INFY-R ₹1,682.19
    //   SMBR   ₹429.59
    //
    // Round 5 EXACT final prices & engine movements (from engine-result screenshot):
    //   RELY   ₹2,892.45 → ₹2,755.35  (-4.74%: ÷4 = +1.76%, insider = -7%, noise = +0.50% -> move = -4.74%)
    //   ADHI   ₹1,791.15 → ₹1,674.37  (-6.52%: ÷4 = -4.02%, insider = -3%, noise = +0.50% -> move = -6.52%)
    //   TATV   ₹1,225.13 → ₹1,310.64  (+6.98%: ÷4 = +4.48%, insider = +3%, noise = -0.50% -> move = +6.98%)
    //   INFY-R ₹1,682.19 → ₹1,767.48  (+5.07%: ÷4 = +1.37%, insider = +4%, noise = -0.30% -> move = +5.07%)
    //   SMBR   ₹429.59   → ₹430.02    (+0.10%: ÷4 = -0.16%, insider = 0%, noise = +0.26% -> move = +0.10%)
    //
    // Round 5 Insider Tips (Host-only, 5 tips with different truth/effects):
    //   RELY: "Netaji Sahab was seen having chai...", is_true: false (trap), effect: -7.00
    //   ADHI: "Hindenbird Research is about to drop...", is_true: true, effect: -3.00
    //   TATV: "A minister's cousin says the electric-vehicle subsidy...", is_true: true, effect: 3.00
    //   INFY-R: "Infyra's biggest US client is quietly renewing...", is_true: true, effect: 4.00
    //   SMBR: "A famous food influencer tasted the sambar...", is_true: false, effect: 0.00
    //
    // SECURITY: true_price_change, noise, is_true, effect_size are HOST/ENGINE ONLY.
    // Block deal info:
    //   ADHI: Sell 1.0% stake
    //   TATV: Buy 0.6% stake
    //   SMBR: Sell 1.5% stake
    //   RELY, INFY-R: None
    // ─────────────────────────────────────────────────────────────────────────────
    const round5EventsData = [
      // RELY — Final: -4.74% (÷4: +1.76%, insider: -7%, noise: +0.50% -> net: -4.74%) → ₹2,892.45 → ₹2,755.35
      {
        round: 5, ticker: 'RELY', block_deal_text: null,
        news_text: "Relyant's retail stores report record festive sales, with strong demand for electronics and groceries.",
        true_price_change: -5.24, noise: 0.50  // PRIMARY
      },
      {
        round: 5, ticker: 'RELY', block_deal_text: null,
        news_text: "The government opens bidding for large infrastructure and telecom projects, and Relyant is expected to take part.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // ADHI — Final: -6.52% (÷4: -4.02%, insider: -3%, noise: +0.50% -> net: -6.52%) → ₹1,791.15 → ₹1,674.37
      {
        round: 5, ticker: 'ADHI',
        block_deal_text: 'Block deal: Sell 1.0% stake in Adhira Ports & Infra.',
        news_text: "Some foreign funds trim their holdings in infrastructure stocks, including Adhira, citing high interest rates.",
        true_price_change: -7.02, noise: 0.50  // PRIMARY
      },
      {
        round: 5, ticker: 'ADHI', block_deal_text: null,
        news_text: "Several port and airport approvals remain stuck, and Adhira's high debt keeps analysts cautious.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // TATV — Final: +6.98% (÷4: +4.48%, insider: +3%, noise: -0.50% -> net: +6.98%) → ₹1,225.13 → ₹1,310.64
      {
        round: 5, ticker: 'TATV',
        block_deal_text: 'Block deal: Buy 0.6% stake in Tatva Motors.',
        news_text: "Tatva's festive-season sales hit a record, with waiting periods on popular models stretching to several weeks.",
        true_price_change: 7.48, noise: -0.50  // PRIMARY
      },
      {
        round: 5, ticker: 'TATV', block_deal_text: null,
        news_text: "Reports say the government is studying support for electric vehicles, which could help Tatva's upcoming models.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // INFY-R — Final: +5.07% (÷4: +1.37%, insider: +4%, noise: -0.30% -> net: +5.07%) → ₹1,682.19 → ₹1,767.48
      {
        round: 5, ticker: 'INFY-R', block_deal_text: null,
        news_text: "Infyra signs a few mid-sized deals with overseas clients as tech budgets slowly open up.",
        true_price_change: 5.37, noise: -0.30  // PRIMARY
      },
      {
        round: 5, ticker: 'INFY-R', block_deal_text: null,
        news_text: "The weaker rupee gives a small boost to Infyra's earnings, though client caution remains.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      },
      // SMBR — Final: +0.10% (÷4: -0.16%, insider: 0%, noise: +0.26% -> net: +0.10%) → ₹429.59 → ₹430.02
      {
        round: 5, ticker: 'SMBR',
        block_deal_text: 'Block deal: Sell 1.5% stake in Sambar from Una.',
        news_text: "After last month's sharp fall, Sambar from Una says business is normal and outlets remain busy.",
        true_price_change: -0.16, noise: 0.26  // PRIMARY
      },
      {
        round: 5, ticker: 'SMBR', block_deal_text: null,
        news_text: "Some investors ask for clearer accounts, so the stock stays under watch.",
        true_price_change: 0.00, noise: 0.00  // DISPLAY-ONLY
      }
    ];
    for (const ev of round5EventsData) {
      await client.query(
        'INSERT INTO round_events (game_id, round_number, stock_id, block_deal_text, news_text, true_price_change, noise) VALUES ($1,$2,$3,$4,$5,$6,$7);',
        [gameId, ev.round, stockMap[ev.ticker], ev.block_deal_text, ev.news_text, ev.true_price_change, ev.noise]
      );
    }

    // ── Round 5 Insider Tips (Host-only, 5 tips) ──
    const round5TipsData = [
      {
        round: 5, ticker: 'RELY', source: 'Political Contact', price: 0, isSuper: true,
        isTrue: false, effect: -7.00, isFlagged: false,
        text: "Netaji Sahab was seen having chai with Mota Seth in a Delhi dhaba. A mega government contract for Relyant is signed, and the shares will zoom!"
      },
      {
        round: 5, ticker: 'ADHI', source: 'Research Analyst', price: 0, isSuper: true,
        isTrue: true, effect: -3.00, isFlagged: false,
        text: "Hindenbird Research is about to drop a 400-page report on Adhira. Their analyst has already sold his own flat to short the stock."
      },
      {
        round: 5, ticker: 'TATV', source: 'Government Source', price: 0, isSuper: true,
        isTrue: true, effect: 3.00, isFlagged: false,
        text: "A minister's cousin says the electric-vehicle subsidy is coming, and he has already ordered 3 Tatva cars to be safe."
      },
      {
        round: 5, ticker: 'INFY-R', source: 'Corporate Insider', price: 0, isSuper: true,
        isTrue: true, effect: 4.00, isFlagged: false,
        text: "Infyra's biggest US client is quietly renewing its mega contract. The CEO was caught celebrating with extra filter coffee."
      },
      {
        round: 5, ticker: 'SMBR', source: 'Food Critic', price: 0, isSuper: true,
        isTrue: false, effect: 0.00, isFlagged: false,
        text: "A famous food influencer tasted the sambar and made a face on camera. The shares will crash by Monday!"
      }
    ];
    for (const t of round5TipsData) {
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
      let game = await getActiveGame();
      if (!game) game = await getLatestEndedGame();
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

  // 5a. POST /api/market-mayhem/teams/join-request — Player submits a join request (host must approve)
  app.post('/api/market-mayhem/teams/join-request', async (req, res) => {
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
        return res.status(400).json({ success: false, message: 'Game has already started. Team join requests are disabled.' });
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

      // Upsert: if player already has a pending request for this game, update it (same game, different team code attempt)
      // UNIQUE(game_id, student_id) — one active request per game per student
      const existingReq = await pool.query(
        'SELECT id, status, team_id FROM team_join_requests WHERE game_id = $1 AND student_id = $2;',
        [game.id, req.session.userId]
      );

      if (existingReq.rows.length > 0) {
        const prev = existingReq.rows[0];
        if (prev.status === 'PENDING') {
          // Update existing pending request to new team
          await pool.query(
            'UPDATE team_join_requests SET team_id = $1, display_name = $2, created_at = CURRENT_TIMESTAMP WHERE id = $3;',
            [team.id, playerDispName, prev.id]
          );
        } else if (prev.status === 'APPROVED') {
          return res.status(400).json({ success: false, message: 'Your join request was already approved. You are in a team.' });
        } else {
          // REJECTED — allow retrying with a new request
          await pool.query(
            'UPDATE team_join_requests SET team_id = $1, display_name = $2, status = $3, created_at = CURRENT_TIMESTAMP, reviewed_at = NULL WHERE id = $4;',
            [team.id, playerDispName, 'PENDING', prev.id]
          );
        }
      } else {
        // Insert new request
        await pool.query(
          'INSERT INTO team_join_requests (game_id, team_id, student_id, display_name, status) VALUES ($1, $2, $3, $4, $5);',
          [game.id, team.id, req.session.userId, playerDispName, 'PENDING']
        );
      }

      // Get updated request
      const reqRow = await pool.query(
        'SELECT id FROM team_join_requests WHERE game_id = $1 AND student_id = $2;',
        [game.id, req.session.userId]
      );
      const requestId = reqRow.rows[0].id;

      // Notify host via Socket.IO (broadcast to game room so host sees it live)
      io.to(`game_${game.id}`).emit('team-join-request', {
        requestId,
        gameId: game.id,
        teamId: team.id,
        teamName: team.team_name,
        studentId: req.session.userId,
        displayName: playerDispName,
        createdAt: new Date().toISOString()
      });

      console.log(`📨 Join request: "${playerDispName}" → Team "${team.team_name}" (Game ${game.id})`);

      return res.json({
        success: true,
        requestPending: true,
        message: 'Join request submitted. Waiting for host approval.',
        requestId,
        teamName: team.team_name
      });

    } catch (err) {
      console.error('Join request error:', err);
      res.status(500).json({ success: false, message: 'Failed to submit join request.' });
    }
  });

  // 5b. GET /api/market-mayhem/teams/my-request — Player polls their request status
  app.get('/api/market-mayhem/teams/my-request', async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      let game = await getActiveGame();
      if (!game) game = await getLatestEndedGame();
      if (!game) return res.json({ success: true, hasRequest: false });

      const reqRes = await pool.query(`
        SELECT tjr.id, tjr.status, tjr.display_name, tjr.created_at, tjr.reviewed_at,
               t.team_name, t.team_code, t.id as team_id
        FROM team_join_requests tjr
        JOIN teams t ON t.id = tjr.team_id
        WHERE tjr.game_id = $1 AND tjr.student_id = $2
        ORDER BY tjr.created_at DESC LIMIT 1;
      `, [game.id, req.session.userId]);

      if (reqRes.rows.length === 0) {
        return res.json({ success: true, hasRequest: false });
      }

      const r = reqRes.rows[0];
      return res.json({
        success: true,
        hasRequest: true,
        request: {
          id: r.id,
          status: r.status,
          displayName: r.display_name,
          teamName: r.team_name,
          teamCode: r.team_code,
          teamId: r.team_id,
          createdAt: r.created_at,
          reviewedAt: r.reviewed_at
        }
      });

    } catch (err) {
      console.error('Get my request error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // 5c. GET /api/market-mayhem/host/join-requests — Host views all pending requests
  app.get('/api/market-mayhem/host/join-requests', requireHost, async (req, res) => {
    try {
      const game = await getActiveGame();
      if (!game) return res.json({ success: true, requests: [] });

      const result = await pool.query(`
        SELECT tjr.id, tjr.status, tjr.display_name, tjr.created_at,
               t.id as team_id, t.team_name, t.team_code,
               s.id as student_id, s.name as student_real_name
        FROM team_join_requests tjr
        JOIN teams t ON t.id = tjr.team_id
        JOIN students s ON s.id = tjr.student_id
        WHERE tjr.game_id = $1 AND tjr.status = 'PENDING'
        ORDER BY tjr.created_at ASC;
      `, [game.id]);

      return res.json({ success: true, requests: result.rows, gameId: game.id });

    } catch (err) {
      console.error('Get join requests error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // 5d. POST /api/market-mayhem/host/join-requests/:requestId/approve — Host approves a request
  app.post('/api/market-mayhem/host/join-requests/:requestId/approve', requireHost, async (req, res) => {
    const client = await pool.connect();
    try {
      const requestId = parseInt(req.params.requestId);
      if (isNaN(requestId)) return res.status(400).json({ success: false, message: 'Invalid request ID.' });

      await client.query('BEGIN');

      // Fetch the request with lock
      const reqRes = await client.query(
        'SELECT * FROM team_join_requests WHERE id = $1 FOR UPDATE;',
        [requestId]
      );
      if (reqRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Join request not found.' });
      }

      const joinReq = reqRes.rows[0];

      if (joinReq.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Request is already ${joinReq.status}. Cannot approve.` });
      }

      // Verify game is still in LOBBY
      const gameRes = await client.query('SELECT * FROM games WHERE id = $1;', [joinReq.game_id]);
      const game = gameRes.rows[0];
      if (!game || game.status !== 'LOBBY') {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Game has already started. Cannot approve new members.' });
      }

      // Check student not already in a team (race condition guard)
      const existingMember = await client.query(`
        SELECT tm.id FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
        WHERE tm.student_id = $1 AND t.game_id = $2;
      `, [joinReq.student_id, joinReq.game_id]);

      if (existingMember.rows.length > 0) {
        await client.query('UPDATE team_join_requests SET status = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2;', ['APPROVED', requestId]);
        await client.query('COMMIT');
        return res.json({ success: true, message: 'Player is already a team member (approved).' });
      }

      // Check team capacity
      const countRes = await client.query('SELECT COUNT(*) FROM team_members WHERE team_id = $1;', [joinReq.team_id]);
      const currentCount = parseInt(countRes.rows[0].count);
      const maxSize = game.max_team_size;

      if (currentCount >= maxSize) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `Team is full (${maxSize} members). Cannot approve.` });
      }

      // Add to team_members
      await client.query(
        'INSERT INTO team_members (team_id, student_id, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;',
        [joinReq.team_id, joinReq.student_id, joinReq.display_name]
      );

      // Mark request as APPROVED
      await client.query(
        'UPDATE team_join_requests SET status = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2;',
        ['APPROVED', requestId]
      );

      await client.query('COMMIT');

      // Get team info for notification
      const teamRes = await pool.query('SELECT team_name, team_code FROM teams WHERE id = $1;', [joinReq.team_id]);
      const teamName = teamRes.rows[0]?.team_name || 'Team';
      const teamCode = teamRes.rows[0]?.team_code || '';

      // Get member list for team update
      const membersRes = await pool.query('SELECT student_id, display_name, joined_at FROM team_members WHERE team_id = $1;', [joinReq.team_id]);

      // Notify the player socket (they listen to player_<studentId> room)
      io.to(`player_${joinReq.student_id}`).emit('team-join-approved', {
        requestId,
        teamId: joinReq.team_id,
        teamName,
        teamCode,
        displayName: joinReq.display_name
      });

      // Notify lobby
      io.to(`game_${joinReq.game_id}`).emit('lobby-updated', { gameId: joinReq.game_id });
      io.to(`team_${joinReq.team_id}`).emit('team-updated', { teamId: joinReq.team_id, members: membersRes.rows });

      console.log(`✅ Approved join request ${requestId}: "${joinReq.display_name}" → Team "${teamName}"`);

      return res.json({ success: true, message: `Approved: ${joinReq.display_name} joined ${teamName}.`, teamId: joinReq.team_id, teamName });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Approve request error:', err);
      res.status(500).json({ success: false, message: 'Failed to approve request.' });
    } finally {
      client.release();
    }
  });

  // 5e. POST /api/market-mayhem/host/join-requests/:requestId/reject — Host rejects a request
  app.post('/api/market-mayhem/host/join-requests/:requestId/reject', requireHost, async (req, res) => {
    try {
      const requestId = parseInt(req.params.requestId);
      if (isNaN(requestId)) return res.status(400).json({ success: false, message: 'Invalid request ID.' });

      const reqRes = await pool.query('SELECT * FROM team_join_requests WHERE id = $1;', [requestId]);
      if (reqRes.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Join request not found.' });
      }

      const joinReq = reqRes.rows[0];

      if (joinReq.status !== 'PENDING') {
        return res.status(400).json({ success: false, message: `Request is already ${joinReq.status}. Cannot reject.` });
      }

      await pool.query(
        'UPDATE team_join_requests SET status = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2;',
        ['REJECTED', requestId]
      );

      // Get team name for notification
      const teamRes = await pool.query('SELECT team_name FROM teams WHERE id = $1;', [joinReq.team_id]);
      const teamName = teamRes.rows[0]?.team_name || 'Team';

      // Notify the player socket
      io.to(`player_${joinReq.student_id}`).emit('team-join-rejected', {
        requestId,
        teamId: joinReq.team_id,
        teamName,
        displayName: joinReq.display_name
      });

      console.log(`❌ Rejected join request ${requestId}: "${joinReq.display_name}" for Team "${teamName}"`);

      return res.json({ success: true, message: `Rejected: ${joinReq.display_name}'s request to join ${teamName}.` });

    } catch (err) {
      console.error('Reject request error:', err);
      res.status(500).json({ success: false, message: 'Failed to reject request.' });
    }
  });

  // 5. POST /api/market-mayhem/teams/join (kept for backward compat — same logic but direct join, no host approval)
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
      // SECURITY: NEVER expose stock_id, stock_name, stock_ticker, text, is_true, effect_size, is_flagged to players.
      // Per Round 1 spec: students may ONLY see source_label, price, is_super_tip BEFORE purchase.
      // tip text is revealed AFTER purchase (handled by /api/market-mayhem/tips/buy response).
      // stock mapping is NEVER revealed through the API.
      const availableTipsRes = await pool.query(`
        SELECT t.id, t.round_number, t.source_label, t.price, t.is_super_tip
        FROM tips t
        WHERE t.game_id = $1 AND t.round_number = $2 AND (t.is_super_tip = FALSE OR t.is_super_tip IS NULL);
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

      // Security: super tips are host-assigned only and cannot be purchased in the Tip Shop
      if (tip.is_super_tip) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          message: 'Classified super tips cannot be purchased in the Tip Shop.'
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
    if (req.session.isHost || req.headers['x-host-key'] === (process.env.HOST_KEY || 'Kartik#28')) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Host authorization required.' });
  }

  // POST /api/market-mayhem/host/login
  app.post('/api/market-mayhem/host/login', (req, res) => {
    const { hostKey } = req.body;
    const validKey = process.env.HOST_KEY || 'Kartik#28';
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
        // Rounds 1, 2, 3, 4, & 5 (FINAL) implementation: 5 rounds total.
        // ALWAYS use game.current_round from the DB — never trust client-supplied newRound
        // for the end-game decision, to prevent stale client state from triggering early end.
        const dbCurrentRound = game.current_round;
        if (dbCurrentRound >= 5) {
          // Round 5 is done — end the game
          statusToSet = 'ENDED';
          phaseToSet = 'REVEAL';
          roundToSet = dbCurrentRound;
          isEndingGame = true;
        } else {
          // Advance to next round (Round 1 → 2, Round 2 → 3, Round 3 → 4, Round 4 → 5)
          roundToSet = dbCurrentRound + 1;
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
  // For Round 1: each stock has 2 round_event rows (one with the actual % change,
  // one display-only with 0.00). The DISTINCT ON query picks the primary event row
  // (the one with the largest absolute price change) per stock, ensuring the
  // predetermined Round 1 final prices are applied exactly.
  async function executePriceEngine(gameId, roundNumber) {
    // Use DISTINCT ON to pick one row per stock, preferring the row with the
    // largest absolute true_price_change (i.e., the primary price-moving event).
    const eventsRes = await pool.query(`
      SELECT DISTINCT ON (stock_id) stock_id, true_price_change, noise
      FROM round_events
      WHERE game_id = $1 AND round_number = $2
      ORDER BY stock_id, ABS(true_price_change) DESC, id ASC;
    `, [gameId, roundNumber]);
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

      // Find all teams in game
      const teamsRes = await pool.query('SELECT id, team_name FROM teams WHERE game_id = $1;', [game.id]);
      if (teamsRes.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'No teams registered in game.' });
      }

      // Pick team (if teamId specified in body, use it, otherwise pick random team)
      const teams = teamsRes.rows;
      const targetTeamId = req.body && req.body.teamId ? parseInt(req.body.teamId) : null;
      let selectedTeam = targetTeamId ? teams.find(t => t.id === targetTeamId) : null;
      if (!selectedTeam) {
        selectedTeam = teams[Math.floor(Math.random() * teams.length)];
      }

      // Find super tip for current round:
      // If tipId or ticker specified in req.body, use that;
      // otherwise, pick a super tip that the selected team has not yet received (or random among all)
      let tipRes;
      if (req.body && req.body.tipId) {
        tipRes = await pool.query(
          'SELECT * FROM tips WHERE game_id = $1 AND round_number = $2 AND id = $3 AND is_super_tip = TRUE;',
          [game.id, game.current_round, parseInt(req.body.tipId)]
        );
      } else if (req.body && req.body.ticker) {
        tipRes = await pool.query(`
          SELECT t.* FROM tips t
          JOIN stocks s ON s.id = t.stock_id
          WHERE t.game_id = $1 AND t.round_number = $2 AND s.ticker = $3 AND t.is_super_tip = TRUE LIMIT 1;
        `, [game.id, game.current_round, req.body.ticker]);
      } else {
        tipRes = await pool.query(`
          SELECT t.* FROM tips t
          WHERE t.game_id = $1 AND t.round_number = $2 AND t.is_super_tip = TRUE
            AND t.id NOT IN (SELECT tip_id FROM team_tips WHERE team_id = $3)
          ORDER BY RANDOM() LIMIT 1;
        `, [game.id, game.current_round, selectedTeam.id]);

        if (tipRes.rows.length === 0) {
          tipRes = await pool.query(
            'SELECT * FROM tips WHERE game_id = $1 AND round_number = $2 AND is_super_tip = TRUE ORDER BY RANDOM() LIMIT 1;',
            [game.id, game.current_round]
          );
        }
      }

      if (tipRes.rows.length === 0) {
        return res.status(404).json({ success: false, message: `No super tip found for Round ${game.current_round}` });
      }
      const superTip = tipRes.rows[0];

      // Assign super tip (insert into team_tips)
      await pool.query(`
        INSERT INTO team_tips (team_id, tip_id, round_number)
        VALUES ($1, $2, $3)
        ON CONFLICT (team_id, tip_id) DO NOTHING;
      `, [selectedTeam.id, superTip.id, game.current_round]);

      // Stock details
      const stockRes = await pool.query('SELECT name, ticker FROM stocks WHERE id = $1;', [superTip.stock_id]);
      const stockName = stockRes.rows.length > 0 ? stockRes.rows[0].name : '';
      const stockTicker = stockRes.rows.length > 0 ? stockRes.rows[0].ticker : '';

      // Notify ONLY the selected team socket
      io.to(`team_${selectedTeam.id}`).emit('super-tip-assigned', {
        teamId: selectedTeam.id,
        tip: {
          purchase_id: Date.now(),
          round_number: game.current_round,
          tip_id: superTip.id,
          stock_id: superTip.stock_id,
          stock_name: stockName,
          stock_ticker: stockTicker,
          text: superTip.text,
          source_label: superTip.source_label,
          price: 0,
          is_super_tip: true
        }
      });

      return res.json({
        success: true,
        message: `Super Tip assigned to ${selectedTeam.team_name}.`,
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
    socket.on('join-game-room', ({ gameId, teamId, studentId }) => {
      if (gameId) {
        socket.join(`game_${gameId}`);
        console.log(`Socket ${socket.id} joined room: game_${gameId}`);
      }
      if (teamId) {
        socket.join(`team_${teamId}`);
        console.log(`Socket ${socket.id} joined room: team_${teamId}`);
      }
      // Join personal room so host can send direct notifications to this player
      if (studentId) {
        socket.join(`player_${studentId}`);
        console.log(`Socket ${socket.id} joined room: player_${studentId}`);
      }
    });

    // Explicit player room join (called separately for join-request notification flow)
    socket.on('join-player-room', ({ studentId }) => {
      if (studentId) {
        socket.join(`player_${studentId}`);
        console.log(`Socket ${socket.id} joined room: player_${studentId}`);
      }
    });

    socket.on('disconnect', () => {
      // Clean disconnect handling
    });
  });
}

module.exports = { setupMarketMayhem };
