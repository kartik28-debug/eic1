/**
 * Market Mayhem — Player Client Application
 * Handles authentication checks, Socket.io real-time connection,
 * Team creation & lobby, Trading arena, Tip shop, Chart.js stock/portfolio graphs,
 * Reveal popups, SEBI penalty alerts, and Final tip debrief.
 */

import { io } from 'socket.io-client';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

const API_BASE = 'http://localhost:5000';

// Global Client State
let socket = null;
let activeGame = null;
let currentTeam = null;
let activeHoldings = [];
let availableTips = [];
let purchasedTips = [];
let currentStocks = [];
let currentLeaderboard = [];
let selectedTradeStock = null;
let stockChartInstance = null;
let multiStockChartInstance = null;
let teamChartInstance = null;
let pendingJoinRequest = null; // tracks player's pending team join request

// Terminal Cockpit & Interactive State
let focusedStockId = null;
let deskOrderType = 'BUY';
let chartDisplayMode = 'focus'; // 'focus' | 'all'
let previousStockPrices = {};
let lastKnownPhase = null;
let lastKnownRound = null;
let isTransitioning = false;

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadInitialState();
  initSocketConnection();
});

// Setup DOM Event Listeners
function setupEventListeners() {
  // Navigation / Auth
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  const factNavBtn = document.getElementById('fact-sheet-nav-btn');
  if (factNavBtn) {
    factNavBtn.addEventListener('click', openFactSheet);
  }
  const factBtnLobby = document.getElementById('btn-view-factsheet');
  if (factBtnLobby) {
    factBtnLobby.addEventListener('click', openFactSheet);
  }
  const closeFactBtn = document.getElementById('close-factsheet');
  if (closeFactBtn) {
    closeFactBtn.addEventListener('click', () => {
      document.getElementById('factsheet-modal').classList.add('hidden');
    });
  }

  // Lobby choices
  const btnShowCreate = document.getElementById('btn-show-create-team');
  const btnShowJoin = document.getElementById('btn-show-join-team');
  const cancelCreate = document.getElementById('cancel-create-team');
  const cancelJoin = document.getElementById('cancel-join-team');

  if (btnShowCreate) {
    btnShowCreate.addEventListener('click', () => {
      document.getElementById('mm-lobby-choices').classList.add('hidden');
      document.getElementById('mm-create-team-box').classList.remove('hidden');
    });
  }
  if (btnShowJoin) {
    btnShowJoin.addEventListener('click', () => {
      document.getElementById('mm-lobby-choices').classList.add('hidden');
      document.getElementById('mm-join-team-box').classList.remove('hidden');
    });
  }
  if (cancelCreate) {
    cancelCreate.addEventListener('click', resetLobbyForms);
  }
  if (cancelJoin) {
    cancelJoin.addEventListener('click', resetLobbyForms);
  }

  // Team Form Actions
  const submitCreate = document.getElementById('submit-create-team');
  if (submitCreate) {
    submitCreate.addEventListener('click', handleCreateTeam);
  }
  const submitJoin = document.getElementById('submit-join-team');
  if (submitJoin) {
    submitJoin.addEventListener('click', handleJoinTeam);
  }

  // Copy Team Code
  const copyBtn = document.getElementById('btn-copy-code');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const codeEl = document.getElementById('lobby-team-code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent);
        copyBtn.textContent = '✅ COPIED!';
        setTimeout(() => copyBtn.textContent = '📋 COPY', 2000);
      }
    });
  }

  // Dashboard Tabs
  const tabBtns = document.querySelectorAll('.mm-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const target = document.getElementById(btn.dataset.tab);
      if (target) target.classList.add('active');

      if (btn.dataset.tab === 'tab-chart') {
        renderMultiStockComparisonChart();
      } else if (btn.dataset.tab === 'tab-trading') {
        renderStockPricesChart(chartDisplayMode);
      }
    });
  });

  // Direct Terminal Order Desk Controls
  const deskBuy = document.getElementById('desk-btn-buy');
  const deskSell = document.getElementById('desk-btn-sell');
  const deskQty = document.getElementById('desk-quantity-input');
  const deskSubmit = document.getElementById('desk-btn-submit');

  if (deskBuy && deskSell) {
    deskBuy.addEventListener('click', () => {
      deskOrderType = 'BUY';
      deskBuy.classList.add('active');
      deskSell.classList.remove('active');
      if (deskSubmit) {
        deskSubmit.className = 'term-action-btn btn-buy-action';
        const stock = currentStocks.find(s => s.id === focusedStockId);
        deskSubmit.querySelector('span').textContent = `EXECUTE BUY ${stock ? stock.ticker : ''}`;
      }
      updateDeskEstTotal();
    });
    deskSell.addEventListener('click', () => {
      deskOrderType = 'SELL';
      deskSell.classList.add('active');
      deskBuy.classList.remove('active');
      if (deskSubmit) {
        deskSubmit.className = 'term-action-btn btn-sell-action';
        const stock = currentStocks.find(s => s.id === focusedStockId);
        deskSubmit.querySelector('span').textContent = `EXECUTE SELL ${stock ? stock.ticker : ''}`;
      }
      updateDeskEstTotal();
    });
  }

  if (deskQty) {
    deskQty.addEventListener('input', updateDeskEstTotal);
  }

  // Quick preset chips
  const chip10 = document.getElementById('chip-10');
  const chip25 = document.getElementById('chip-25');
  const chip50 = document.getElementById('chip-50');
  const chip100 = document.getElementById('chip-100');
  const chipMax = document.getElementById('chip-max');

  if (chip10) chip10.addEventListener('click', () => setDeskQty(10));
  if (chip25) chip25.addEventListener('click', () => setDeskQty(25));
  if (chip50) chip50.addEventListener('click', () => setDeskQty(50));
  if (chip100) chip100.addEventListener('click', () => setDeskQty(100));
  if (chipMax) chipMax.addEventListener('click', () => setDeskQty('MAX'));

  if (deskSubmit) {
    deskSubmit.addEventListener('click', handleDeskExecuteTrade);
  }

  // Chart Toggle Controls
  const chartBtnFocus = document.getElementById('chart-btn-focus');
  const chartBtnAll = document.getElementById('chart-btn-all');

  if (chartBtnFocus && chartBtnAll) {
    chartBtnFocus.addEventListener('click', () => {
      chartDisplayMode = 'focus';
      chartBtnFocus.classList.add('active');
      chartBtnAll.classList.remove('active');
      renderStockPricesChart('focus');
    });
    chartBtnAll.addEventListener('click', () => {
      chartDisplayMode = 'all';
      chartBtnAll.classList.add('active');
      chartBtnFocus.classList.remove('active');
      renderStockPricesChart('all');
    });
  }

  // Trade Modal
  const btnBuy = document.getElementById('trade-btn-buy');
  const btnSell = document.getElementById('trade-btn-sell');
  const qtyInput = document.getElementById('trade-quantity-input');
  const submitTrade = document.getElementById('btn-submit-trade');
  const cancelTrade = document.getElementById('btn-cancel-trade');

  if (btnBuy && btnSell) {
    btnBuy.addEventListener('click', () => {
      btnBuy.classList.add('active');
      btnSell.classList.remove('active');
      updateTradeEstTotal();
    });
    btnSell.addEventListener('click', () => {
      btnSell.classList.add('active');
      btnBuy.classList.remove('active');
      updateTradeEstTotal();
    });
  }

  if (qtyInput) {
    qtyInput.addEventListener('input', updateTradeEstTotal);
  }

  if (submitTrade) {
    submitTrade.addEventListener('click', handleExecuteTrade);
  }
  if (cancelTrade) {
    cancelTrade.addEventListener('click', () => {
      document.getElementById('trade-modal').classList.add('hidden');
    });
  }

  // Modals Close
  const closeReveal = document.getElementById('btn-close-reveal');
  if (closeReveal) {
    closeReveal.addEventListener('click', () => {
      document.getElementById('reveal-modal').classList.add('hidden');
    });
  }

  const closeSebi = document.getElementById('btn-close-sebi');
  if (closeSebi) {
    closeSebi.addEventListener('click', () => {
      document.getElementById('sebi-modal').classList.add('hidden');
    });
  }
}

function resetLobbyForms() {
  document.getElementById('mm-lobby-choices').classList.remove('hidden');
  document.getElementById('mm-create-team-box').classList.add('hidden');
  document.getElementById('mm-join-team-box').classList.add('hidden');
}

// ─── Socket.io Integration ───
function initSocketConnection() {
  socket = io(API_BASE, { withCredentials: true });

  const statusText = document.getElementById('status-text');
  const statusPill = document.getElementById('connection-status');

  socket.on('connect', () => {
    if (statusText) statusText.textContent = '● LIVE';
    if (statusPill) statusPill.classList.add('live');
    // Rejoin game and team rooms on reconnect
    if (activeGame) {
      const studentId = window._eicStudent ? window._eicStudent.id : null;
      socket.emit('join-game-room', { gameId: activeGame.id, teamId: currentTeam ? currentTeam.id : null, studentId });
    } else if (window._eicStudent) {
      // Join personal room even without a game (for join request notifications)
      socket.emit('join-player-room', { studentId: window._eicStudent.id });
    }
  });

  socket.on('disconnect', () => {
    if (statusText) statusText.textContent = '○ RECONNECTING...';
    if (statusPill) statusPill.classList.remove('live');
  });

  socket.on('lobby-updated', async () => {
    await refreshTeamState();
  });

  socket.on('team-updated', ({ members }) => {
    if (currentTeam) {
      currentTeam.members = members;
      renderLobbyMembers(members);
    }
  });

  // game-started: host pressed START GAME — move from lobby into game
  socket.on('game-started', async ({ gameId, status, round, phase }) => {
    console.log('[MM] game-started received:', { gameId, status, round, phase });
    triggerRoundTransition(round || 1, phase || 'TIP_SHOP');
    await loadInitialState();
  });

  socket.on('phase-changed', async ({ status, currentPhase, currentRound }) => {
    console.log('[MM] phase-changed received:', { status, currentPhase, currentRound });
    if (status === 'ENDED') {
      // Game ended — show results immediately
      await showResultsSection();
      return;
    }
    if (currentRound && currentPhase && (currentRound !== lastKnownRound || currentPhase !== lastKnownPhase)) {
      triggerRoundTransition(currentRound, currentPhase);
      lastKnownRound = currentRound;
      lastKnownPhase = currentPhase;
    }
    await loadInitialState();
  });

  // game-ended: host ended the game — transition ALL players to results screen immediately
  socket.on('game-ended', async ({ gameId, leaderboard, message }) => {
    console.log('[MM] game-ended received for game', gameId);
    // Update local game state
    if (activeGame) activeGame.status = 'ENDED';

    // Show a brief banner before transitioning
    const eventBanner = document.getElementById('mm-event-banner');
    const eventContent = document.getElementById('mm-event-content');
    if (eventBanner && eventContent) {
      eventContent.innerHTML = `<div class="event-item"><p><strong>🏁 GAME OVER:</strong> ${message || 'The game has ended. Displaying final results...'}</p></div>`;
      eventBanner.classList.remove('hidden');
    }

    // If we already have the leaderboard, render it immediately
    if (leaderboard && leaderboard.length > 0) {
      currentLeaderboard = leaderboard;
      renderLeaderboard(leaderboard);
    }

    // Transition to results screen after a brief 1.5s pause
    setTimeout(async () => {
      await showResultsSection();
    }, 1500);
  });

  socket.on('game-paused', () => {
    // Visual indicator that timer is paused
    const timerText = document.getElementById('hud-timer-text');
    if (timerText) timerText.style.color = '#ffbd2e';
  });

  socket.on('game-resumed', () => {
    const timerText = document.getElementById('hud-timer-text');
    if (timerText) timerText.style.color = '#ff4d4d';
  });

  socket.on('timer-tick', ({ remainingSeconds }) => {
    updateTimerDisplay(remainingSeconds);
  });

  socket.on('timer-ended', () => {
    updateTimerDisplay(0);
  });

  socket.on('trade-executed', ({ newCashBalance }) => {
    if (currentTeam && newCashBalance !== undefined) {
      currentTeam.cashBalance = newCashBalance;
    }
    refreshPlayerState();
  });

  socket.on('tip-purchased', ({ tip, newCashBalance }) => {
    if (currentTeam) {
      currentTeam.cashBalance = newCashBalance;
      purchasedTips.unshift(tip);
      renderPurchasedTips();
      updateFinancialBar();
    }
  });

  socket.on('super-tip-assigned', ({ tip }) => {
    const banner = document.getElementById('mm-super-tip-banner');
    const body = document.getElementById('super-tip-body');
    if (banner && body) {
      body.innerHTML = `<strong>${tip.source_label}</strong> [Stock: ${tip.stock_name}]: "${tip.text}"`;
      banner.classList.remove('hidden');
    }
    purchasedTips.unshift(tip);
    renderPurchasedTips();
  });

  socket.on('leaderboard-updated', ({ leaderboard }) => {
    currentLeaderboard = leaderboard;
    renderLeaderboard(leaderboard);
  });

  socket.on('sebi-penalty-applied', ({ penaltyAmount, reason }) => {
    showSebiModal(penaltyAmount, reason);
    refreshPlayerState();
  });

  socket.on('market-event-triggered', ({ message }) => {
    // Show market event notification banner
    const eventBanner = document.getElementById('mm-event-banner');
    const eventContent = document.getElementById('mm-event-content');
    if (eventBanner && eventContent) {
      const isCrash = (message || '').toLowerCase().includes('crash');
      const isBull = (message || '').toLowerCase().includes('bull');
      const eventClass = isCrash ? 'crash-event' : (isBull ? 'bull-event' : 'generic-event');
      const tagText = isCrash ? '⚠ MARKET CRASH DETECTED' : (isBull ? '📈 BULL RUN DETECTED' : '⚡ MARKET EVENT DETECTED');

      eventBanner.className = `mm-event-banner ${eventClass}`;
      eventContent.innerHTML = `
        <div class="event-headline-tag">${tagText}</div>
        <div class="event-body-text">${message}</div>
      `;
      eventBanner.classList.remove('hidden');

      setTimeout(() => {
        if (eventBanner) eventBanner.classList.add('hidden');
      }, 9000);
    }
  });

  // ─── Team Join Request: Host approved ───
  socket.on('team-join-approved', async ({ teamId, teamName, teamCode, displayName }) => {
    console.log('[MM] team-join-approved:', { teamId, teamName, teamCode });
    // Clear pending request state
    pendingJoinRequest = null;
    showJoinRequestStatus('approved', teamName);

    // Load updated state now that we're a team member
    await loadInitialState();
  });

  // ─── Team Join Request: Host rejected ───
  socket.on('team-join-rejected', ({ teamId, teamName }) => {
    console.log('[MM] team-join-rejected for team:', teamName);
    pendingJoinRequest = null;
    showJoinRequestStatus('rejected', teamName);
  });

} // end initSocketConnection

// Load Initial Data & Route View
async function loadInitialState() {

  try {
    // Show student name
    if (window._eicStudent) {
      const nameEl = document.getElementById('nav-student-name');
      if (nameEl) nameEl.textContent = window._eicStudent.name;
    }

    // Check my team
    const teamRes = await fetch(`${API_BASE}/api/market-mayhem/my-team`, { credentials: 'include' });
    const teamData = await teamRes.json();

    if (teamData.inTeam) {
      currentTeam = teamData.team;
    }

    // Check active game state
    const stateRes = await fetch(`${API_BASE}/api/market-mayhem/state`, { credentials: 'include' });
    const stateData = await stateRes.json();

    if (!stateData.success) {
      // Show lobby
      showLobbySection();
      return;
    }

    activeGame = stateData.game;
    currentStocks = stateData.stocks || [];
    availableTips = stateData.availableTips || [];
    purchasedTips = stateData.purchasedTips || [];
    activeHoldings = stateData.holdings || [];
    currentLeaderboard = stateData.leaderboard || [];

    if (socket && socket.connected) {
      const studentId = window._eicStudent ? window._eicStudent.id : null;
      socket.emit('join-game-room', { gameId: activeGame.id, teamId: currentTeam ? currentTeam.id : null, studentId });
    }

    // Determine screen to show
    if (activeGame.status === 'ENDED') {
      await showResultsSection();
      return;
    }

    if (!currentTeam) {
      // Check for a pending join request before showing lobby
      const reqRes = await fetch(`${API_BASE}/api/market-mayhem/teams/my-request`, { credentials: 'include' });
      const reqData = await reqRes.json();
      if (reqData.hasRequest && reqData.request) {
        pendingJoinRequest = reqData.request;
        showLobbySection();
        showJoinRequestStatus(reqData.request.status.toLowerCase(), reqData.request.teamName);
        return;
      }
      showLobbySection();
      return;
    }

    if (activeGame.status === 'LOBBY') {
      showLobbySection();
      renderLobbyWaitingRoom();
    } else {
      showDashboardSection(stateData);
    }

  } catch (e) {
    console.error('Error loading initial state:', e);
    showLobbySection();
  }
}

// Refresh State Data
async function refreshPlayerState() {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/state`, { credentials: 'include' });
    const data = await res.json();
    if (data.success) {
      activeGame = data.game;
      currentStocks = data.stocks || [];
      availableTips = data.availableTips || [];
      purchasedTips = data.purchasedTips || [];
      activeHoldings = data.holdings || [];
      currentLeaderboard = data.leaderboard || [];

      if (currentTeam && data.team) {
        currentTeam.cashBalance = data.team.cashBalance;
      }

      updateDashboardUI(data);
    }
  } catch (e) {
    console.error('Refresh state error:', e);
  }
}

async function refreshTeamState() {
  const res = await fetch(`${API_BASE}/api/market-mayhem/my-team`, { credentials: 'include' });
  const data = await res.json();
  if (data.inTeam) {
    currentTeam = data.team;
    renderLobbyMembers(currentTeam.members);
  }
}

// ─── UI VIEW CONTROLLERS ───

function showLobbySection() {
  document.getElementById('mm-lobby-section').classList.remove('hidden');
  document.getElementById('mm-dashboard-section').classList.add('hidden');
  document.getElementById('mm-results-section').classList.add('hidden');
}

function showDashboardSection(data) {
  document.getElementById('mm-lobby-section').classList.add('hidden');
  document.getElementById('mm-dashboard-section').classList.remove('hidden');
  document.getElementById('mm-results-section').classList.add('hidden');

  updateDashboardUI(data);
}

async function showResultsSection() {
  document.getElementById('mm-lobby-section').classList.add('hidden');
  document.getElementById('mm-dashboard-section').classList.add('hidden');
  document.getElementById('mm-results-section').classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/debrief`, { credentials: 'include' });
    const data = await res.json();
    if (data.success) {
      const leaderboard = data.leaderboard || [];
      renderFinalPodium(leaderboard, data.priceHistory || []);
      renderFinalStandings(leaderboard);
      renderDebriefTable(data.tips || []);
      renderTeamValueChart(leaderboard, data.priceHistory || []);
    }
  } catch (e) {
    console.error('Error loading final debrief:', e);
  }
}

function updateDashboardUI(data) {
  // HUD Badges
  const roundBadge = document.getElementById('hud-round-badge');
  const phaseBadge = document.getElementById('hud-phase-badge');
  if (roundBadge) roundBadge.textContent = `ROUND 0${activeGame.currentRound} / 05`;
  if (phaseBadge) phaseBadge.textContent = `PHASE: ${activeGame.currentPhase}`;

  updateTimerDisplay(activeGame.timerRemaining || 120);

  // Auto-switch tabs to align with phase
  if (activeGame) {
    if (activeGame.currentPhase === 'TIP_SHOP') {
      const tipsTabBtn = document.querySelector('[data-tab="tab-tips"]');
      const activeBtn = document.querySelector('.mm-tab-btn.active');
      if (activeBtn && activeBtn.dataset.tab !== 'tab-tips' && tipsTabBtn) {
        tipsTabBtn.click();
      }
    } else if (activeGame.currentPhase === 'TRADING') {
      const tradingTabBtn = document.querySelector('[data-tab="tab-trading"]');
      const activeBtn = document.querySelector('.mm-tab-btn.active');
      if (activeBtn && activeBtn.dataset.tab !== 'tab-trading' && tradingTabBtn) {
        tradingTabBtn.click();
      }
    }
  }

  // Financial Telemetry Summary
  updateFinancialBar();

  // News/Block Deal Event Banner
  const eventBanner = document.getElementById('mm-event-banner');
  const eventContent = document.getElementById('mm-event-content');
  if (data.events && data.events.length > 0) {
    const currentRoundEvents = data.events.filter(e => e.round_number === activeGame.currentRound);
    if (currentRoundEvents.length > 0 && eventContent && eventBanner) {
      eventContent.innerHTML = currentRoundEvents.map(e => `
        <div class="event-item">
          ${e.block_deal_text ? `<p class="block-deal">⚡ <strong>BLOCK DEAL (${e.ticker}):</strong> ${e.block_deal_text}</p>` : ''}
          ${e.news_text ? `<p class="news">📰 <strong>NEWS (${e.ticker}):</strong> ${e.news_text}</p>` : ''}
        </div>
      `).join('');
      eventBanner.classList.remove('hidden');
    } else if (eventBanner) {
      eventBanner.classList.add('hidden');
    }
  }

  // Market Reveal Modal Trigger
  if (activeGame && activeGame.currentPhase === 'REVEAL') {
    renderRevealModal(data.stocks || []);
  }

  // Visual Centerpiece: Market Trading Terminal Cockpit
  renderMarketCenterpiece(data.stocks || []);

  // Stock Cards Arena Overview
  renderStockCards(data.stocks || []);

  // Tip Shop: Intelligence Market
  renderTipShop(data.availableTips || []);
  renderPurchasedTips();

  // Holdings: Institutional Trading Table
  renderHoldings(data.holdings || []);

  // Leaderboard: Esports Tournament Board
  renderLeaderboard(data.leaderboard || []);

  // Trades History
  renderTradeStream(data.trades || []);
}

function updateFinancialBar() {
  if (!currentTeam) return;

  const cash = currentTeam.cashBalance || 0;
  let holdingsValue = 0;
  activeHoldings.forEach(h => {
    const stock = currentStocks.find(s => s.id === h.stock_id);
    const p = stock ? parseFloat(stock.current_price) : 0;
    holdingsValue += h.quantity * p;
  });

  const total = cash + holdingsValue;
  const startingCash = (activeGame && activeGame.startingCash) ? activeGame.startingCash : 100000;
  const pnl = total - startingCash;
  const pnlPct = ((pnl / startingCash) * 100).toFixed(2);

  const elCash = document.getElementById('fin-cash');
  const elPort = document.getElementById('fin-portfolio');
  const elPnl = document.getElementById('fin-pnl');
  const elRank = document.getElementById('fin-rank');

  if (elCash) elCash.textContent = `₹${Math.round(cash).toLocaleString('en-IN')}`;
  if (elPort) elPort.textContent = `₹${Math.round(holdingsValue).toLocaleString('en-IN')}`;
  if (elPnl) {
    const pnlSign = pnl >= 0 ? '+' : '';
    elPnl.textContent = `${pnlSign}₹${Math.round(pnl).toLocaleString('en-IN')} (${pnlSign}${pnlPct}%)`;
    elPnl.className = pnl >= 0 ? 'fin-value pos mono-num' : 'fin-value neg mono-num';
  }

  if (elRank) {
    const myTeamData = currentLeaderboard.find(t => t.teamId === currentTeam.id || t.teamCode === currentTeam.code);
    if (myTeamData && myTeamData.rank) {
      elRank.textContent = `#${myTeamData.rank.toString().padStart(2, '0')}`;
      if (myTeamData.rank === 1) elRank.className = 'fin-value gold mono-num';
      else if (myTeamData.rank === 2) elRank.className = 'fin-value cyan mono-num';
      else elRank.className = 'fin-value mono-num';
    } else {
      elRank.textContent = '#--';
    }
  }
}

function updateTimerDisplay(remainingSeconds) {
  const timerText = document.getElementById('hud-timer-text');
  if (!timerText) return;
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  timerText.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  
  // Terminal urgency indicators
  if (remainingSeconds <= 30) {
    timerText.style.color = 'var(--bear-red)';
    timerText.style.textShadow = '0 0 10px rgba(255, 51, 102, 0.6)';
  } else if (remainingSeconds <= 60) {
    timerText.style.color = 'var(--warn-amber)';
    timerText.style.textShadow = 'none';
  } else {
    timerText.style.color = 'var(--term-cyan)';
    timerText.style.textShadow = 'none';
  }
}

// ─── VISUAL CENTERPIECE: MARKET TRADING TERMINAL ───
function renderMarketCenterpiece(stocks) {
  if (!stocks || stocks.length === 0) return;

  // Ensure a valid focused stock
  if (!focusedStockId || !stocks.some(s => s.id === focusedStockId)) {
    focusedStockId = stocks[0].id;
  }

  const focusedStock = stocks.find(s => s.id === focusedStockId) || stocks[0];

  // 1. Render Ticker Tape Selector Bar
  const tickerTape = document.getElementById('market-ticker-tape');
  if (tickerTape) {
    tickerTape.innerHTML = stocks.map(stock => {
      const price = parseFloat(stock.current_price);
      const initial = parseFloat(stock.initial_price || price);
      const changePct = (((price - initial) / initial) * 100).toFixed(2);
      const isPos = price >= initial;
      const changeSign = isPos ? '+' : '';
      const isSelected = stock.id === focusedStock.id;

      return `
        <button class="ticker-tape-item ${isSelected ? 'active' : ''}" onclick="window.selectFocusedStock(${stock.id})">
          <span class="tape-ticker">${stock.ticker}</span>
          <span class="tape-price">₹${price.toLocaleString('en-IN')}</span>
          <span class="tape-pct ${isPos ? 'pos' : 'neg'}">${changeSign}${changePct}%</span>
        </button>
      `;
    }).join('');
  }

  // 2. Render Stock Cockpit
  const price = parseFloat(focusedStock.current_price);
  const initial = parseFloat(focusedStock.initial_price || price);
  const changePct = (((price - initial) / initial) * 100).toFixed(2);
  const isPos = price >= initial;
  const changeSign = isPos ? '+' : '';

  const holding = activeHoldings.find(h => h.stock_id === focusedStock.id);
  const ownedQty = holding ? holding.quantity : 0;
  const holdingVal = ownedQty * price;

  const elTicker = document.getElementById('cockpit-ticker');
  const elSector = document.getElementById('cockpit-sector');
  const elVol = document.getElementById('cockpit-vol');
  const elName = document.getElementById('cockpit-name');
  const elDesc = document.getElementById('cockpit-desc');
  const elPrice = document.getElementById('cockpit-price');
  const elChange = document.getElementById('cockpit-change');
  const elOwned = document.getElementById('cockpit-owned');
  const elBase = document.getElementById('cockpit-base');
  const elHoldingVal = document.getElementById('cockpit-holding-val');

  if (elTicker) elTicker.textContent = focusedStock.ticker;
  if (elSector) elSector.textContent = focusedStock.sector || 'MARKET EQUITY';
  if (elVol) {
    elVol.textContent = `${focusedStock.volatility} VOL`;
    elVol.className = `volatility-tag ${focusedStock.volatility.toLowerCase()}`;
  }
  if (elName) elName.textContent = focusedStock.name;
  if (elDesc) elDesc.textContent = focusedStock.description;
  
  if (elPrice) {
    // Subtle live flash animation on price movement
    const prevPrice = previousStockPrices[focusedStock.id];
    if (prevPrice !== undefined && prevPrice !== price) {
      const flashClass = price > prevPrice ? 'price-flash-up' : 'price-flash-down';
      elPrice.classList.add(flashClass);
      setTimeout(() => elPrice.classList.remove(flashClass), 800);
    }
    previousStockPrices[focusedStock.id] = price;
    elPrice.textContent = `₹${price.toLocaleString('en-IN')}`;
  }

  if (elChange) {
    elChange.textContent = `${changeSign}${changePct}%`;
    elChange.className = `cockpit-change-pill ${isPos ? 'pos' : 'neg'} mono-num`;
  }

  if (elOwned) elOwned.textContent = `${ownedQty} SHARES`;
  if (elBase) elBase.textContent = `₹${initial.toLocaleString('en-IN')}`;
  if (elHoldingVal) elHoldingVal.textContent = `₹${Math.round(holdingVal).toLocaleString('en-IN')}`;

  // 3. Update Direct Order Desk
  const deskSubmit = document.getElementById('desk-btn-submit');
  const deskLabel = document.getElementById('desk-submit-label');
  const isTradingPhase = activeGame && activeGame.currentPhase === 'TRADING';

  if (deskSubmit && deskLabel) {
    deskLabel.textContent = `EXECUTE ${deskOrderType} ${focusedStock.ticker}`;
    deskSubmit.disabled = !isTradingPhase || (deskOrderType === 'SELL' && ownedQty <= 0);
  }

  updateDeskEstTotal();

  // 4. Render Large Price Chart in Centerpiece
  renderStockPricesChart(chartDisplayMode);
}

// Global scope selector for focused stock
window.selectFocusedStock = (stockId) => {
  focusedStockId = stockId;
  renderMarketCenterpiece(currentStocks);
  renderStockCards(currentStocks);
};

// Quick preset chips setter
window.setDeskQty = (val) => {
  const deskQty = document.getElementById('desk-quantity-input');
  if (!deskQty || !focusedStockId) return;

  const stock = currentStocks.find(s => s.id === focusedStockId);
  const price = stock ? parseFloat(stock.current_price) : 1;
  const cash = currentTeam ? currentTeam.cashBalance : 0;
  const holding = activeHoldings.find(h => h.stock_id === focusedStockId);
  const ownedQty = holding ? holding.quantity : 0;

  if (val === 'MAX') {
    if (deskOrderType === 'BUY') {
      const maxAffordable = Math.floor(cash / price);
      deskQty.value = Math.max(1, maxAffordable);
    } else {
      deskQty.value = Math.max(1, ownedQty);
    }
  } else {
    deskQty.value = val;
  }

  updateDeskEstTotal();
};

function updateDeskEstTotal() {
  const stock = currentStocks.find(s => s.id === focusedStockId);
  if (!stock) return;

  const qtyInput = document.getElementById('desk-quantity-input');
  const estEl = document.getElementById('desk-est-total');
  const qty = parseInt(qtyInput ? qtyInput.value : 1) || 1;
  const total = qty * parseFloat(stock.current_price);
  if (estEl) estEl.textContent = `₹${Math.round(total).toLocaleString('en-IN')}`;
}

// Direct Order Desk Trade Execution
async function handleDeskExecuteTrade() {
  const stock = currentStocks.find(s => s.id === focusedStockId);
  if (!stock) return;

  const isTradingPhase = activeGame && activeGame.currentPhase === 'TRADING';
  const logEl = document.getElementById('trade-terminal-log');

  if (!isTradingPhase) {
    if (logEl) {
      logEl.className = 'terminal-exec-log error';
      logEl.innerHTML = `<span>&gt; ORDER REJECTED // MARKET CLOSED (PHASE: ${activeGame ? activeGame.currentPhase : 'LOBBY'})</span>`;
    }
    return;
  }

  const qtyInput = document.getElementById('desk-quantity-input');
  const quantity = parseInt(qtyInput ? qtyInput.value : 0);

  if (isNaN(quantity) || quantity <= 0) {
    if (logEl) {
      logEl.className = 'terminal-exec-log error';
      logEl.innerHTML = `<span>&gt; ORDER REJECTED // INVALID QUANTITY SPECIFIED</span>`;
    }
    return;
  }

  const price = parseFloat(stock.current_price);
  const total = quantity * price;
  const cash = currentTeam ? currentTeam.cashBalance : 0;
  const holding = activeHoldings.find(h => h.stock_id === stock.id);
  const ownedQty = holding ? holding.quantity : 0;

  if (deskOrderType === 'BUY' && cash < total) {
    if (logEl) {
      logEl.className = 'terminal-exec-log error';
      logEl.innerHTML = `<span>&gt; ORDER REJECTED // INSUFFICIENT CASH (NEED ₹${Math.round(total).toLocaleString('en-IN')}, AVAIL: ₹${Math.round(cash).toLocaleString('en-IN')})</span>`;
    }
    return;
  }

  if (deskOrderType === 'SELL' && ownedQty < quantity) {
    if (logEl) {
      logEl.className = 'terminal-exec-log error';
      logEl.innerHTML = `<span>&gt; ORDER REJECTED // INSUFFICIENT SHARES (OWNED: ${ownedQty}, SELL: ${quantity})</span>`;
    }
    return;
  }

  // Fast professional submission state: > ORDER SUBMITTED
  if (logEl) {
    logEl.className = 'terminal-exec-log transmitting';
    logEl.innerHTML = `<span>&gt; ORDER SUBMITTED</span>`;
  }

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        stockId: stock.id,
        type: deskOrderType,
        quantity: quantity
      })
    });

    const data = await res.json();
    if (!data.success) {
      if (logEl) {
        logEl.className = 'terminal-exec-log error';
        logEl.innerHTML = `<span>&gt; ORDER REJECTED // ${(data.message || 'TRANSACTION FAILED').toUpperCase()}</span>`;
      }
      return;
    }

    if (logEl) {
      logEl.className = 'terminal-exec-log success';
      logEl.innerHTML = `
        <div class="exec-step-line">&gt; ORDER SUBMITTED</div>
        <div class="exec-step-line">&gt; ${deskOrderType} ${quantity} ${stock.ticker}</div>
        <div class="exec-step-line">&gt; ₹${Math.round(total).toLocaleString('en-IN')}</div>
        <div class="exec-step-line exec-done">&gt; EXECUTED</div>
      `;
    }

    // Refresh state immediately
    await refreshPlayerState();

  } catch (e) {
    if (logEl) {
      logEl.className = 'terminal-exec-log error';
      logEl.innerHTML = `<span>&gt; ORDER REJECTED // NETWORK TRANSMISSION FAILED</span>`;
    }
  }
}

// ─── 5-STOCK ARENA CARDS OVERVIEW ───
function renderStockCards(stocks) {
  const container = document.getElementById('stocks-arena-grid');
  if (!container) return;

  const isTradingPhase = activeGame && activeGame.currentPhase === 'TRADING';

  container.innerHTML = stocks.map(stock => {
    const price = parseFloat(stock.current_price);
    const initial = parseFloat(stock.initial_price || price);
    const changePct = (((price - initial) / initial) * 100).toFixed(2);
    const isPos = price >= initial;
    const changeSign = isPos ? '+' : '';

    const holding = activeHoldings.find(h => h.stock_id === stock.id);
    const ownedQty = holding ? holding.quantity : 0;
    const isSelected = stock.id === focusedStockId;

    return `
      <div class="stock-arena-card ${isSelected ? 'selected-stock' : ''}" onclick="window.selectFocusedStock(${stock.id})">
        <div class="card-header-row">
          <div>
            <span class="stock-ticker">${stock.ticker}</span>
            <span class="stock-sector">${stock.sector}</span>
          </div>
          <span class="volatility-tag ${stock.volatility.toLowerCase()}">${stock.volatility} VOL</span>
        </div>
        <h4 class="stock-name">${stock.name}</h4>
        <p class="stock-desc">${stock.description}</p>
        
        <div class="price-row">
          <span class="price-val">₹${price.toLocaleString('en-IN')}</span>
          <span class="price-pill ${isPos ? 'pos' : 'neg'}">${changeSign}${changePct}%</span>
        </div>

        <div class="holding-info-pill">
          <span>PORTFOLIO SHARES:</span> <strong>${ownedQty}</strong>
        </div>

        <div class="card-trade-actions" onclick="event.stopPropagation();">
          <button class="btn btn-primary trade-btn" ${!isTradingPhase ? 'disabled' : ''} onclick="window.openTradeModal(${stock.id}, 'BUY')">
            BUY ${stock.ticker}
          </button>
          <button class="btn btn-secondary trade-btn" ${(!isTradingPhase || ownedQty <= 0) ? 'disabled' : ''} onclick="window.openTradeModal(${stock.id}, 'SELL')">
            SELL
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Global scope binder for trade modal trigger
window.openTradeModal = (stockId, defaultType) => {
  const stock = currentStocks.find(s => s.id === stockId);
  if (!stock) return;

  selectedTradeStock = stock;

  const title = document.getElementById('trade-modal-title');
  const nameEl = document.getElementById('trade-stock-name');
  const priceEl = document.getElementById('trade-stock-price');
  const cashEl = document.getElementById('trade-avail-cash');
  const ownedEl = document.getElementById('trade-owned-qty');

  if (title) title.textContent = `TRANSMIT ${defaultType} ORDER — ${stock.ticker}`;
  if (nameEl) nameEl.textContent = stock.name;
  if (priceEl) priceEl.textContent = `₹${parseFloat(stock.current_price).toLocaleString('en-IN')}`;
  if (cashEl) cashEl.textContent = `₹${Math.round(currentTeam ? currentTeam.cashBalance : 0).toLocaleString('en-IN')}`;

  const holding = activeHoldings.find(h => h.stock_id === stock.id);
  if (ownedEl) ownedEl.textContent = holding ? holding.quantity : 0;

  const btnBuy = document.getElementById('trade-btn-buy');
  const btnSell = document.getElementById('trade-btn-sell');
  if (defaultType === 'BUY') {
    btnBuy.classList.add('active');
    btnSell.classList.remove('active');
  } else {
    btnSell.classList.add('active');
    btnBuy.classList.remove('active');
  }

  const feedbackEl = document.getElementById('trade-modal-feedback');
  if (feedbackEl) {
    feedbackEl.textContent = '';
    feedbackEl.className = 'trade-modal-feedback hidden';
  }

  updateTradeEstTotal();
  document.getElementById('trade-modal').classList.remove('hidden');
};

function updateTradeEstTotal() {
  if (!selectedTradeStock) return;
  const qtyInput = document.getElementById('trade-quantity-input');
  const estEl = document.getElementById('trade-est-total');
  const qty = parseInt(qtyInput ? qtyInput.value : 1) || 1;
  const total = qty * parseFloat(selectedTradeStock.current_price);
  if (estEl) estEl.textContent = `₹${Math.round(total).toLocaleString('en-IN')}`;
}

async function handleExecuteTrade() {
  if (!selectedTradeStock) return;

  const feedbackEl = document.getElementById('trade-modal-feedback');
  const showFeedback = (msg, isError = true) => {
    if (feedbackEl) {
      feedbackEl.textContent = msg;
      feedbackEl.className = `trade-modal-feedback ${isError ? 'error' : 'success'}`;
      feedbackEl.classList.remove('hidden');
    }
  };

  const btnBuy = document.getElementById('trade-btn-buy');
  const tradeType = btnBuy.classList.contains('active') ? 'BUY' : 'SELL';
  const qtyInput = document.getElementById('trade-quantity-input');
  const quantity = parseInt(qtyInput ? qtyInput.value : 0);

  if (isNaN(quantity) || quantity <= 0) {
    showFeedback('> ORDER REJECTED // INVALID QUANTITY (MINIMUM: 1 SHARE)', true);
    return;
  }

  const price = parseFloat(selectedTradeStock.current_price);
  const total = quantity * price;
  const cash = currentTeam ? currentTeam.cashBalance : 0;
  const holding = activeHoldings.find(h => h.stock_id === selectedTradeStock.id);
  const ownedQty = holding ? holding.quantity : 0;

  if (tradeType === 'BUY' && cash < total) {
    showFeedback(`> ORDER REJECTED // INSUFFICIENT CASH (NEED ₹${Math.round(total).toLocaleString('en-IN')})`, true);
    return;
  }

  if (tradeType === 'SELL' && ownedQty < quantity) {
    showFeedback(`> ORDER REJECTED // INSUFFICIENT SHARES (OWNED: ${ownedQty}, SELL: ${quantity})`, true);
    return;
  }

  showFeedback(`> TRANSMITTING ${tradeType} ORDER...`, false);

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        stockId: selectedTradeStock.id,
        type: tradeType,
        quantity: quantity
      })
    });

    const data = await res.json();
    if (!data.success) {
      showFeedback(`> ORDER REJECTED // ${(data.message || 'TRANSACTION FAILED').toUpperCase()}`, true);
      return;
    }

    showFeedback(`> EXECUTED // ${tradeType} ${quantity} ${selectedTradeStock.ticker}`, false);
    setTimeout(() => {
      document.getElementById('trade-modal').classList.add('hidden');
    }, 600);
    refreshPlayerState();

  } catch (e) {
    showFeedback('> ORDER REJECTED // NETWORK ERROR', true);
  }
}

// ─── TIP SHOP: INTELLIGENCE MARKET ───
function renderTipShop(tips) {
  const container = document.getElementById('available-tips-grid');
  const pill = document.getElementById('tip-counter-pill');
  if (!container) return;

  const currentRound = activeGame ? activeGame.currentRound : 1;
  const boughtCount = purchasedTips.filter(t => t.round_number === currentRound).length;
  if (pill) pill.textContent = `INTEL DOSSIERS ACQUIRED: ${boughtCount} / 2`;

  const isTipPhase = activeGame && activeGame.currentPhase === 'TIP_SHOP';

  if (!tips || tips.length === 0) {
    container.innerHTML = '<p class="empty-state">No classified intelligence dossiers available for this round.</p>';
    return;
  }

  container.innerHTML = tips.map(tip => {
    const isBought = purchasedTips.some(pt => pt.tip_id === tip.id);

    return `
      <div class="tip-card ${tip.is_super_tip ? 'super-tip' : ''}">
        <div class="tip-card-head">
          <span class="tip-card-tag">INTELLIGENCE MARKET // ROUND 0${currentRound}</span>
          ${tip.is_super_tip ? '<span class="super-badge">⚡ RESTRICTED ACCESS // SUPER INTEL</span>' : ''}
        </div>
        
        <div class="classified-status-box">
          <span class="lock-icon">${isBought ? '🔓' : '🔒'}</span>
          <span class="classified-label">${isBought ? 'REVEALED INTELLIGENCE' : 'CLASSIFIED // PURCHASE TO REVEAL'}</span>
        </div>

        <div class="tip-dossier-meta">
          <div class="dossier-meta-row">
            <span class="meta-label">SOURCE</span>
            <span class="meta-val">${tip.source_label || 'Market Analyst'}</span>
          </div>
          <div class="dossier-meta-row">
            <span class="meta-label">STOCK</span>
            <span class="meta-val font-bold" style="color:var(--term-cyan);">${tip.stock_name} (${tip.stock_ticker})</span>
          </div>
          <div class="dossier-meta-row">
            <span class="meta-label">COST</span>
            <span class="meta-val mono-num font-bold gold">₹${parseFloat(tip.price).toLocaleString('en-IN')}</span>
          </div>
        </div>

        <button class="btn ${tip.is_super_tip ? 'btn-primary' : 'btn-secondary'} buy-tip-btn"
                ${(isBought || !isTipPhase || boughtCount >= 2) ? 'disabled' : ''}
                onclick="window.buyTip(${tip.id})">
          ${isBought ? '✅ DOSSIER DECRYPTED' : (isTipPhase ? 'ACQUIRE INTEL' : '🔒 MARKET CLOSED')}
        </button>
      </div>
    `;
  }).join('');
}

window.buyTip = async (tipId) => {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/tips/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tipId })
    });
    const data = await res.json();
    if (!data.success) {
      const banner = document.getElementById('mm-event-banner');
      const content = document.getElementById('mm-event-content');
      if (banner && content) {
        content.innerHTML = `<div class="event-item"><p style="color:var(--bear-red);"><strong>🔒 CLEARANCE DENIED:</strong> ${data.message}</p></div>`;
        banner.classList.remove('hidden');
      }
      return;
    }
    refreshPlayerState();
  } catch (e) {
    console.error('Failed to acquire intel:', e);
  }
};

function renderPurchasedTips() {
  const container = document.getElementById('purchased-tips-list');
  if (!container) return;

  if (purchasedTips.length === 0) {
    container.innerHTML = '<p class="empty-state">No decrypted intelligence on record for this round.</p>';
    return;
  }

  // Strictly omitting hidden parameters: is_true, effect_size, is_flagged
  container.innerHTML = purchasedTips.map(pt => `
    <div class="private-tip-card ${pt.is_super_tip ? 'super' : ''}">
      <div class="pt-header">
        <span class="pt-round-tag">REVEALED INTELLIGENCE // ROUND 0${pt.round_number}</span>
        <span class="pt-stock font-bold mono-num" style="color:var(--term-cyan);">${pt.stock_name || 'MARKET'}</span>
      </div>
      <div class="pt-source-line">DECRYPTED INTEL SOURCE: <strong>${pt.source_label}</strong></div>
      <p class="pt-text">"${pt.text}"</p>
    </div>
  `).join('');
}

// ─── HOLDINGS: INSTITUTIONAL TRADING TABLE ───
function renderHoldings(holdings) {
  const container = document.getElementById('holdings-list');
  if (!container) return;

  if (holdings.length === 0) {
    container.innerHTML = '<p class="empty-state">No active positions. Execute orders on the trading desk to build portfolio holdings.</p>';
    return;
  }

  container.innerHTML = `
    <table class="holdings-table">
      <thead>
        <tr>
          <th>STOCK</th>
          <th>QTY</th>
          <th>AVG PRICE</th>
          <th>CURRENT</th>
          <th>P&L</th>
        </tr>
      </thead>
      <tbody>
        ${holdings.map(h => {
          const stock = currentStocks.find(s => s.id === h.stock_id);
          const currentPrice = stock ? parseFloat(stock.current_price) : 0;
          const initialPrice = stock ? parseFloat(stock.initial_price || currentPrice) : currentPrice;
          
          // Calculate average buy execution price from trades
          const buyTrades = activeTrades.filter(t => (t.stock_id === h.stock_id || t.ticker === h.ticker) && t.type === 'BUY');
          let avgPrice = initialPrice;
          if (buyTrades.length > 0) {
            const totalBuyCost = buyTrades.reduce((sum, tr) => sum + parseFloat(tr.total_value), 0);
            const totalBuyQty = buyTrades.reduce((sum, tr) => sum + tr.quantity, 0);
            if (totalBuyQty > 0) avgPrice = totalBuyCost / totalBuyQty;
          }

          const totalVal = h.quantity * currentPrice;
          const costVal = h.quantity * avgPrice;
          const pnl = totalVal - costVal;
          const pnlSign = pnl >= 0 ? '+' : '-';
          const absPnl = Math.abs(Math.round(pnl));
          const pnlPct = costVal > 0 ? (((pnl) / costVal) * 100).toFixed(1) : '0.0';

          return `
            <tr>
              <td><strong class="stock-ticker-label mono-num">${h.ticker}</strong></td>
              <td class="mono-num">${h.quantity}</td>
              <td class="mono-num">₹${Math.round(avgPrice).toLocaleString('en-IN')}</td>
              <td class="mono-num">₹${Math.round(currentPrice).toLocaleString('en-IN')}</td>
              <td class="mono-num font-bold ${pnl >= 0 ? 'pos' : 'neg'}">
                ${pnlSign}₹${absPnl.toLocaleString('en-IN')}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ─── LEADERBOARD: ESPORTS TOURNAMENT BOARD ───
function renderLeaderboard(leaderboard) {
  const tbody = document.getElementById('leaderboard-tbody');
  if (!tbody) return;

  const startingCash = (activeGame && activeGame.startingCash) ? activeGame.startingCash : 100000;

  tbody.innerHTML = leaderboard.map((t, idx) => {
    const isMyTeam = currentTeam && (currentTeam.id === t.teamId || currentTeam.code === t.teamCode);
    const returnPct = ((t.totalValue - startingCash) / startingCash) * 100;
    const isPos = returnPct >= 0;
    const sign = isPos ? '+' : '';

    let rankBadge = `#${t.rank.toString().padStart(2, '0')}`;
    let rankClass = '';
    if (t.rank === 1) { rankBadge = `🥇 #01`; rankClass = 'rank-gold'; }
    else if (t.rank === 2) { rankBadge = `🥈 #02`; rankClass = 'rank-silver'; }
    else if (t.rank === 3) { rankBadge = `🥉 #03`; rankClass = 'rank-bronze'; }

    return `
      <tr class="${isMyTeam ? 'my-team-row' : ''}">
        <td><span class="mono-num rank-badge ${rankClass}">${rankBadge}</span></td>
        <td>
          <span class="team-name-text">${t.teamName}</span>
          ${isMyTeam ? '<span class="you-tag">[YOU]</span>' : ''}
        </td>
        <td class="mono-num text-right">
          <div class="lead-val gold">₹${Math.round(t.totalValue).toLocaleString('en-IN')}</div>
          <div class="lead-return mono-num ${isPos ? 'pos' : 'neg'}">${sign}${returnPct.toFixed(1)}%</div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderTradeStream(trades) {
  const container = document.getElementById('trades-stream');
  if (!container) return;

  if (trades.length === 0) {
    container.innerHTML = '<p class="empty-state">Awaiting execution orders...</p>';
    return;
  }

  container.innerHTML = trades.map(tr => `
    <div class="trade-stream-item ${tr.type.toLowerCase()}">
      <span class="t-type">${tr.type}</span>
      <span class="t-details">${tr.quantity} × ${tr.ticker}</span>
      <span class="t-val">₹${Math.round(parseFloat(tr.total_value)).toLocaleString('en-IN')}</span>
    </div>
  `).join('');
}

// ─── ESPORTS ROUND TRANSITION HERALD ───
function triggerRoundTransition(round, phase) {
  if (isTransitioning) return;
  isTransitioning = true;

  const modal = document.getElementById('round-transition-modal');
  const roundEl = document.getElementById('trans-round-title');
  const phaseEl = document.getElementById('trans-phase-title');
  const countEl = document.getElementById('trans-countdown');

  if (!modal || !roundEl || !phaseEl || !countEl) {
    isTransitioning = false;
    return;
  }

  roundEl.textContent = `ROUND 0${round}`;
  phaseEl.textContent = phase.replace('_', ' ');

  modal.classList.remove('hidden');

  let remaining = 3;
  countEl.textContent = `0${remaining}`;

  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      modal.classList.add('hidden');
      isTransitioning = false;
    } else {
      countEl.textContent = `0${remaining}`;
    }
  }, 800);
}

// ─── MARKET REVEAL MODAL (ROUND DRAMA) ───
function renderRevealModal(stocks) {
  const modal = document.getElementById('reveal-modal');
  const grid = document.getElementById('reveal-prices-grid');
  const title = document.getElementById('reveal-title');
  if (!modal || !grid) return;

  const currentRound = activeGame ? activeGame.currentRound : 1;
  if (title) title.textContent = `MARKET REVEAL // ROUND 0${currentRound}`;

  if (!stocks || stocks.length === 0) return;

  // Identify highest absolute mover
  const sorted = [...stocks].map(s => {
    const p = parseFloat(s.current_price);
    const init = parseFloat(s.initial_price || p);
    const diffPct = (((p - init) / init) * 100);
    return { ...s, price: p, initial: init, diffPct, absDiff: Math.abs(diffPct) };
  }).sort((a, b) => b.absDiff - a.absDiff);

  const topMover = sorted[0];
  const isBull = topMover.diffPct >= 0;
  const sign = isBull ? '+' : '';
  const meterWidth = Math.min(100, Math.max(20, Math.round(topMover.absDiff * 3.5)));

  grid.innerHTML = `
    <!-- Top Mover Spotlight -->
    <div class="reveal-spotlight-box ${isBull ? 'bull-spotlight' : 'bear-spotlight'}">
      <span class="spotlight-badge">[ ROUND 0${currentRound} PRIME MOVER ]</span>
      <h1 class="spotlight-ticker">${topMover.ticker}</h1>
      <div class="spotlight-company">${topMover.name}</div>
      <div class="spotlight-val mono-num ${isBull ? 'pos' : 'neg'}">
        ${sign}${topMover.diffPct.toFixed(2)}%
      </div>
      <div class="reveal-meter-track">
        <div class="reveal-meter-bar ${isBull ? 'bull-fill' : 'bear-fill'}" style="width: ${meterWidth}%;"></div>
      </div>
      <div class="spotlight-sentiment ${isBull ? 'pos' : 'neg'}">
        ${isBull ? 'BULLISH SURGE ▲' : 'BEARISH PLUNGE ▼'}
      </div>
    </div>

    <!-- Full Equity Board -->
    <div class="reveal-all-stocks-stream">
      <div style="font-family:var(--font-mono); font-size:0.7rem; color:var(--term-text-muted); margin-bottom:0.4rem;">
        EQUITY MOVEMENT MATRIX
      </div>
      ${sorted.map(s => {
        const isSpos = s.diffPct >= 0;
        const sSign = isSpos ? '+' : '';
        return `
          <div class="reveal-stock-row" style="border-left: 3px solid ${isSpos ? 'var(--bull-green)' : 'var(--bear-red)'};">
            <div>
              <span class="reveal-ticker">${s.ticker}</span>
              <span style="font-size:0.75rem; color:var(--term-text-muted); margin-left:0.5rem;">${s.name}</span>
            </div>
            <div style="display:flex; align-items:center; gap:0.8rem;">
              <span class="mono-num" style="font-weight:700;">₹${s.price.toLocaleString('en-IN')}</span>
              <span class="reveal-diff mono-num ${isSpos ? 'pos' : 'neg'}">${sSign}${s.diffPct.toFixed(2)}%</span>
              <span class="volatility-tag ${isSpos ? 'low' : 'high'}">${isSpos ? 'BULLISH ▲' : 'BEARISH ▼'}</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  modal.classList.remove('hidden');
}

// ─── CENTERPIECE LARGE PRICE CHART ───
function renderStockPricesChart(mode = 'focus') {
  const ctx = document.getElementById('stockPricesChart');
  if (!ctx) return;

  fetch(`${API_BASE}/api/market-mayhem/fact-sheet`, { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (!data.success) return;

      const stocks = data.stocks;
      const rounds = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
      const colors = ['#00f0ff', '#00e676', '#ffd700', '#ff3366', '#a855f7'];

      let datasets = [];

      if (mode === 'focus') {
        const stock = stocks.find(s => s.id === focusedStockId) || stocks[0];
        const dataPoints = rounds.map(r => {
          const entry = stock.history.find(h => h.round === r);
          return entry ? entry.price : null;
        });

        // Compute primary trend for coloring
        const currentP = stock.history[stock.history.length - 1]?.price || 0;
        const initialP = stock.history[0]?.price || currentP;
        const lineColor = currentP >= initialP ? '#00e676' : '#ff3366';

        datasets = [{
          label: `${stock.name} (${stock.ticker})`,
          data: dataPoints,
          borderColor: lineColor,
          backgroundColor: lineColor === '#00e676' ? 'rgba(0, 230, 118, 0.12)' : 'rgba(255, 51, 102, 0.12)',
          fill: true,
          tension: 0.3,
          borderWidth: 2.5,
          pointBackgroundColor: lineColor,
          pointBorderColor: '#07090e',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 7
        }];
      } else {
        datasets = stocks.map((s, idx) => {
          const dataPoints = rounds.map(r => {
            const entry = s.history.find(h => h.round === r);
            return entry ? entry.price : null;
          });

          return {
            label: `${s.ticker}`,
            data: dataPoints,
            borderColor: colors[idx % colors.length],
            backgroundColor: 'transparent',
            tension: 0.25,
            borderWidth: 2,
            pointRadius: 2.5
          };
        });
      }

      if (stockChartInstance) stockChartInstance.destroy();

      stockChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: rounds.map(r => r <= 0 ? `M${r}` : `R${r}`), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: mode !== 'focus',
              labels: { color: '#8fa0b5', font: { family: 'JetBrains Mono', size: 11 } }
            },
            tooltip: {
              backgroundColor: '#0c121e',
              borderColor: '#1a2334',
              borderWidth: 1,
              titleFont: { family: 'JetBrains Mono', size: 12 },
              bodyFont: { family: 'JetBrains Mono', size: 12 },
              padding: 10,
              callbacks: {
                label: (ctx) => ` ${ctx.dataset.label}: ₹${ctx.parsed.y.toLocaleString('en-IN')}`
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#53647d', font: { family: 'JetBrains Mono', size: 11 } },
              grid: { color: 'rgba(26, 35, 52, 0.6)' }
            },
            y: {
              ticks: {
                color: '#53647d',
                font: { family: 'JetBrains Mono', size: 11 },
                callback: (val) => `₹${val.toLocaleString('en-IN')}`
              },
              grid: { color: 'rgba(26, 35, 52, 0.6)' }
            }
          }
        }
      });
    });
}

function renderMultiStockComparisonChart() {
  const ctx = document.getElementById('multiStockCompChart');
  if (!ctx) return;

  fetch(`${API_BASE}/api/market-mayhem/fact-sheet`, { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (!data.success) return;

      const stocks = data.stocks;
      const rounds = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
      const colors = ['#00f0ff', '#00e676', '#ffd700', '#ff3366', '#a855f7'];

      const datasets = stocks.map((s, idx) => {
        const dataPoints = rounds.map(r => {
          const entry = s.history.find(h => h.round === r);
          return entry ? entry.price : null;
        });

        return {
          label: `${s.name} (${s.ticker})`,
          data: dataPoints,
          borderColor: colors[idx % colors.length],
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 3
        };
      });

      if (multiStockChartInstance) multiStockChartInstance.destroy();

      multiStockChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: rounds.map(r => r <= 0 ? `M${r}` : `R${r}`), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#8fa0b5', font: { family: 'JetBrains Mono' } } }
          },
          scales: {
            x: { ticks: { color: '#53647d' }, grid: { color: 'rgba(26, 35, 52, 0.6)' } },
            y: { ticks: { color: '#53647d' }, grid: { color: 'rgba(26, 35, 52, 0.6)' } }
          }
        }
      });
    });
}

function renderTeamValueChart(leaderboard, priceHistory) {
  const ctx = document.getElementById('teamValueChart');
  if (!ctx) return;

  const rounds = [0, 1, 2, 3, 4, 5];
  const colors = ['#00e5ff', '#e0c253', '#27c93f', '#af52de', '#ff9500'];

  const datasets = leaderboard.slice(0, 5).map((team, idx) => {
    return {
      label: team.teamName,
      data: rounds.map(r => r === 0 ? 100000 : team.totalValue), // Chart trajectory
      borderColor: colors[idx % colors.length],
      tension: 0.3,
      borderWidth: 3
    };
  });

  if (teamChartInstance) teamChartInstance.destroy();

  teamChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: rounds.map(r => `Round ${r}`), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#ffffff' } } },
      scales: {
        x: { ticks: { color: '#8aa2b8' } },
        y: { ticks: { color: '#8aa2b8' } }
      }
    }
  });
}

// ─── FINAL DEBRIEF & TOURNAMENT PODIUM RENDERERS ───
function renderFinalPodium(leaderboard, priceHistory = []) {
  const container = document.getElementById('final-podium-grid');
  const championContainer = document.getElementById('final-champion-hero');
  if (!leaderboard || leaderboard.length === 0) return;

  const champion = leaderboard[0];

  // 1. Render Grand Champion Hero Card
  if (championContainer && champion) {
    const champVal = Math.round(champion.totalValue);
    const champPnl = champVal - 100000;
    const champPnlPct = ((champPnl / 100000) * 100).toFixed(2);
    const champIsPos = champPnl >= 0;
    const champSign = champIsPos ? '+' : '';

    championContainer.innerHTML = `
      <div class="champion-hero-card">
        <div class="champion-trophy">🏆</div>
        <div class="champion-pretitle">MARKET MAYHEM // FINAL RESULTS</div>
        <h1 class="champion-name">${champion.teamName}</h1>
        <div class="champion-valuation mono-num">₹${champVal.toLocaleString('en-IN')}</div>
        <div class="champion-pnl-pill mono-num ${champIsPos ? 'pos' : 'neg'}">
          ${champSign}${champPnlPct}%
        </div>
      </div>
    `;
  }

  // 2. Render Top 3 Podium
  if (container) {
    const top3 = leaderboard.slice(0, 3);
    container.innerHTML = top3.map((t, idx) => {
      const totalVal = Math.round(t.totalValue);
      const pnl = totalVal - 100000;
      const pnlPct = ((pnl / 100000) * 100).toFixed(2);
      const isPos = pnl >= 0;
      const sign = isPos ? '+' : '';

      return `
        <div class="podium-card rank-${idx + 1}">
          <div class="trophy">${idx === 0 ? '🏆 TOURNAMENT CHAMPION' : idx === 1 ? '🥈 2ND PLACE' : '🥉 3RD PLACE'}</div>
          <h3 class="podium-team">${t.teamName}</h3>
          <div class="podium-val mono-num">₹${totalVal.toLocaleString('en-IN')}</div>
          <div class="podium-pnl mono-num ${isPos ? 'pos' : 'neg'}">
            ${sign}${pnlPct}% (₹${Math.abs(pnl).toLocaleString('en-IN')})
          </div>
        </div>
      `;
    }).join('');
  }

  // 3. Calculate Major Winning Stock across simulation
  let majorWinningStock = 'RELIANCE (+18.4%)';
  if (priceHistory && priceHistory.length > 0) {
    const stockMap = {};
    priceHistory.forEach(ph => {
      if (!stockMap[ph.ticker]) stockMap[ph.ticker] = { ticker: ph.ticker, name: ph.name, first: parseFloat(ph.price), latest: parseFloat(ph.price) };
      stockMap[ph.ticker].latest = parseFloat(ph.price);
    });
    let bestGain = -Infinity;
    Object.values(stockMap).forEach(s => {
      const g = (s.latest - s.first) / s.first;
      if (g > bestGain) {
        bestGain = g;
        majorWinningStock = `${s.ticker} (${g >= 0 ? '+' : ''}${(g * 100).toFixed(1)}%)`;
      }
    });
  }

  // 4. Show "YOUR TEAM PERFORMANCE REPORT"
  const myCard = document.getElementById('my-team-result-card');
  if (myCard && currentTeam) {
    const myTeamData = leaderboard.find(t => t.teamId === currentTeam.id || t.teamCode === currentTeam.code);
    if (myTeamData) {
      const myVal = Math.round(myTeamData.totalValue);
      const myPnl = myVal - 100000;
      const myPnlPct = ((myPnl / 100000) * 100).toFixed(2);
      const isPos = myPnl >= 0;
      const sign = isPos ? '+' : '';

      myCard.innerHTML = `
        <div class="my-team-result-inner">
          <div class="report-meta">
            <span class="cyber-tag">[ YOUR PERFORMANCE REPORT ]</span>
            <h2>${myTeamData.teamName}</h2>
          </div>
          <div class="report-metrics-grid">
            <div class="metric-item">
              <span class="label">FINAL RANK</span>
              <span class="val cyan mono-num font-bold">#${myTeamData.rank.toString().padStart(2, '0')}</span>
            </div>
            <div class="metric-item">
              <span class="label">FINAL PORTFOLIO VALUE</span>
              <span class="val gold mono-num font-bold">₹${myVal.toLocaleString('en-IN')}</span>
            </div>
            <div class="metric-item">
              <span class="label">TOTAL PROFIT / LOSS</span>
              <span class="val mono-num font-bold ${isPos ? 'pos' : 'neg'}">${sign}₹${Math.abs(myPnl).toLocaleString('en-IN')} (${sign}${myPnlPct}%)</span>
            </div>
            <div class="metric-item">
              <span class="label">MAJOR WINNING STOCK</span>
              <span class="val mono-num font-bold" style="color:var(--term-cyan);">${majorWinningStock}</span>
            </div>
            <div class="metric-item">
              <span class="label">NUMBER OF TRADES</span>
              <span class="val mono-num font-bold">${activeTrades.length} EXECUTED</span>
            </div>
          </div>
        </div>
      `;
      myCard.classList.remove('hidden');
    } else {
      myCard.classList.add('hidden');
    }
  }
}

function renderFinalStandings(leaderboard) {
  const tbody = document.getElementById('final-standings-tbody');
  if (!tbody) return;

  if (leaderboard.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">No standing data available.</td></tr>';
    return;
  }

  tbody.innerHTML = leaderboard.map(t => {
    const isMyTeam = currentTeam && (t.teamId === currentTeam.id || t.teamCode === currentTeam.code);
    const totalVal = Math.round(t.totalValue);
    const pnl = totalVal - 100000;
    const pnlPct = ((pnl / 100000) * 100).toFixed(2);
    const isPos = pnl >= 0;
    const sign = isPos ? '+' : '';

    return `
      <tr class="${isMyTeam ? 'highlight-row' : ''}">
        <td class="mono-num font-bold">#${t.rank.toString().padStart(2, '0')}</td>
        <td>
          <strong style="${isMyTeam ? 'color:var(--term-cyan);' : ''}">${t.teamName}</strong>
          ${isMyTeam ? '<span class="you-tag">[YOU]</span>' : ''}
        </td>
        <td class="mono-num">₹${Math.round(t.cashBalance).toLocaleString('en-IN')}</td>
        <td class="mono-num">₹${Math.round(t.holdingsValue).toLocaleString('en-IN')}</td>
        <td class="mono-num gold font-bold">₹${totalVal.toLocaleString('en-IN')}</td>
        <td class="mono-num font-bold ${isPos ? 'pos' : 'neg'}">${sign}${pnlPct}%</td>
      </tr>
    `;
  }).join('');
}

function renderDebriefTable(tips) {
  const tbody = document.getElementById('debrief-tbody');
  if (!tbody) return;

  if (tips.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">No intelligence dossiers found.</td></tr>';
    return;
  }

  tbody.innerHTML = tips.map(t => `
    <tr>
      <td class="mono-num">R${t.round_number}</td>
      <td><strong>${t.source_label}</strong></td>
      <td class="mono-num font-bold" style="color:var(--term-cyan);">${t.stock_ticker}</td>
      <td style="color:#d8e2ec;">"${t.text}"</td>
      <td><span class="truth-badge ${t.is_true ? 'true' : 'false'}">${t.is_true ? 'TRUE' : 'FALSE'}</span></td>
      <td class="mono-num font-bold ${parseFloat(t.effect_size) >= 0 ? 'pos' : 'neg'}">${t.effect_size > 0 ? '+' : ''}${t.effect_size}%</td>
      <td><span class="flag-badge ${t.is_flagged ? 'flagged' : 'clear'}">${t.is_flagged ? '⚠️ YES' : 'NO'}</span></td>
    </tr>
  `).join('');
}

// ─── TEAM CREATION & LOBBY HANDLERS ───
async function handleCreateTeam() {
  const teamNameInput = document.getElementById('create-team-name');
  const nameInput = document.getElementById('create-player-name');

  const teamName = teamNameInput ? teamNameInput.value.trim() : '';
  const displayName = nameInput ? nameInput.value.trim() : '';

  if (!teamName) {
    alert('Please enter a team name.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/teams/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ teamName, displayName })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.message);
      return;
    }

    currentTeam = data.team;
    // Join team's socket room for private events
    if (socket && socket.connected && currentTeam) {
      socket.emit('join-game-room', { gameId: currentTeam.gameId, teamId: currentTeam.id });
    }
    renderLobbyWaitingRoom();

  } catch (e) {
    alert('Failed to create team.');
  }
}

async function handleJoinTeam() {
  const codeInput = document.getElementById('join-team-code');
  const nameInput = document.getElementById('join-player-name');

  const teamCode = codeInput ? codeInput.value.trim() : '';
  const displayName = nameInput ? nameInput.value.trim() : '';

  if (!teamCode) {
    alert('Please enter a team code.');
    return;
  }

  const submitBtn = document.getElementById('submit-join-team');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'SUBMITTING REQUEST...'; }

  try {
    // Use the new request-based endpoint (host must approve)
    const res = await fetch(`${API_BASE}/api/market-mayhem/teams/join-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ teamCode, displayName })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.message);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'JOIN TEAM'; }
      return;
    }

    // Request submitted: show pending state
    pendingJoinRequest = { status: 'PENDING', teamName: data.teamName, requestId: data.requestId };

    // Join player room so we get approval/rejection notifications
    if (socket && socket.connected && window._eicStudent) {
      socket.emit('join-player-room', { studentId: window._eicStudent.id });
    }

    // Also join game room for lobby updates
    if (activeGame && socket && socket.connected) {
      socket.emit('join-game-room', { gameId: activeGame.id, studentId: window._eicStudent ? window._eicStudent.id : null });
    }

    showJoinRequestStatus('pending', data.teamName);

  } catch (e) {
    alert('Failed to submit join request.');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'JOIN TEAM'; }
  }
}

function renderLobbyWaitingRoom() {
  if (!currentTeam) return;

  document.getElementById('mm-lobby-choices').classList.add('hidden');
  document.getElementById('mm-create-team-box').classList.add('hidden');
  document.getElementById('mm-join-team-box').classList.add('hidden');
  const waitingRoom = document.getElementById('mm-waiting-room');
  const reqStatus = document.getElementById('mm-join-request-status');
  if (waitingRoom) waitingRoom.classList.remove('hidden');
  if (reqStatus) reqStatus.classList.add('hidden');

  const nameEl = document.getElementById('lobby-team-name');
  const codeEl = document.getElementById('lobby-team-code');
  if (nameEl) nameEl.textContent = currentTeam.name;
  if (codeEl) codeEl.textContent = currentTeam.code;

  renderLobbyMembers(currentTeam.members || []);
}

/**
 * Show join request status card (pending/approved/rejected)
 */
function showJoinRequestStatus(status, teamName) {
  // Hide all lobby forms
  const choices = document.getElementById('mm-lobby-choices');
  const createBox = document.getElementById('mm-create-team-box');
  const joinBox = document.getElementById('mm-join-team-box');
  const waitingRoom = document.getElementById('mm-waiting-room');
  if (choices) choices.classList.add('hidden');
  if (createBox) createBox.classList.add('hidden');
  if (joinBox) joinBox.classList.add('hidden');
  if (waitingRoom) waitingRoom.classList.add('hidden');

  // Show or create request status box
  let statusBox = document.getElementById('mm-join-request-status');
  if (!statusBox) {
    statusBox = document.createElement('div');
    statusBox.id = 'mm-join-request-status';
    statusBox.className = 'mm-form-box';
    const heroCard = document.querySelector('.mm-hero-card');
    if (heroCard) heroCard.appendChild(statusBox);
  }

  if (status === 'pending') {
    statusBox.innerHTML = `
      <div class="join-request-status pending">
        <div class="req-status-icon">⏳</div>
        <h3>REQUEST PENDING</h3>
        <p class="form-sub">Your request to join <strong>${teamName}</strong> has been submitted.<br>Waiting for host approval...</p>
        <div class="req-pulse-row"><span class="pulse-dot"></span><span>Awaiting host decision...</span></div>
        <button class="btn btn-outline" onclick="cancelJoinRequest()" style="margin-top:1rem;">CANCEL REQUEST</button>
      </div>
    `;
  } else if (status === 'approved') {
    statusBox.innerHTML = `
      <div class="join-request-status approved">
        <div class="req-status-icon">✅</div>
        <h3>REQUEST APPROVED</h3>
        <p class="form-sub">You have been approved to join <strong>${teamName}</strong>!<br>Loading your team dashboard...</p>
      </div>
    `;
    setTimeout(() => loadInitialState(), 1500);
  } else if (status === 'rejected') {
    statusBox.innerHTML = `
      <div class="join-request-status rejected">
        <div class="req-status-icon">❌</div>
        <h3>REQUEST REJECTED</h3>
        <p class="form-sub">The host rejected your request to join <strong>${teamName}</strong>.<br>You can try joining another team.</p>
        <button class="btn btn-primary" onclick="retryJoin()" style="margin-top:1rem;">TRY ANOTHER TEAM</button>
      </div>
    `;
  }
  statusBox.classList.remove('hidden');
}

window.cancelJoinRequest = () => {
  pendingJoinRequest = null;
  const statusBox = document.getElementById('mm-join-request-status');
  if (statusBox) statusBox.classList.add('hidden');
  resetLobbyForms();
};

window.retryJoin = () => {
  pendingJoinRequest = null;
  const statusBox = document.getElementById('mm-join-request-status');
  if (statusBox) statusBox.classList.add('hidden');
  document.getElementById('mm-lobby-choices').classList.remove('hidden');
};

function renderLobbyMembers(members) {
  const countEl = document.getElementById('member-count');
  const listEl = document.getElementById('lobby-member-list');

  if (countEl) countEl.textContent = members.length;
  if (listEl) {
    listEl.innerHTML = members.map(m => `
      <li>
        <span class="member-avatar">👤</span>
        <span class="member-name">${m.display_name}</span>
      </li>
    `).join('');
  }
}

// Fact Sheet Modal
function openFactSheet() {
  const modal = document.getElementById('factsheet-modal');
  const container = document.getElementById('factsheet-stocks-container');
  if (!modal || !container) return;

  fetch(`${API_BASE}/api/market-mayhem/fact-sheet`, { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (!data.success) return;

      container.innerHTML = data.stocks.map(s => `
        <div class="factsheet-card">
          <div class="f-header">
            <h3>${s.name} (${s.ticker})</h3>
            <span class="volatility-tag ${s.volatility.toLowerCase()}">${s.volatility} VOLATILITY</span>
          </div>
          <div class="f-sector">Sector: <strong>${s.sector}</strong></div>
          <p class="f-desc">${s.description}</p>
        </div>
      `).join('');

      modal.classList.remove('hidden');
    });
}

function showSebiModal(amount, reason) {
  const modal = document.getElementById('sebi-modal');
  const desc = document.getElementById('sebi-modal-desc');
  const amt = document.getElementById('sebi-penalty-amount');

  if (desc) desc.textContent = reason;
  if (amt) amt.textContent = `-₹${parseFloat(amount).toLocaleString('en-IN')}`;
  if (modal) modal.classList.remove('hidden');
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch (e) { /* ignore */ }
  window.location.replace('login.html');
}
