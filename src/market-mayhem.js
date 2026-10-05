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
let teamChartInstance = null;

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
        renderStockPricesChart();
      }
    });
  });

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
      socket.emit('join-game-room', { gameId: activeGame.id, teamId: currentTeam ? currentTeam.id : null });
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
    // Fetch authoritative state from backend then transition UI
    await loadInitialState();
  });

  socket.on('phase-changed', async ({ status, currentPhase, currentRound }) => {
    console.log('[MM] phase-changed received:', { status, currentPhase, currentRound });
    if (status === 'ENDED') {
      // Game ended — show results immediately
      await showResultsSection();
      return;
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
    // Show market event banner
    const eventBanner = document.getElementById('mm-event-banner');
    const eventContent = document.getElementById('mm-event-content');
    if (eventBanner && eventContent) {
      eventContent.innerHTML = `<div class="event-item"><p><strong>⚡ MARKET EVENT:</strong> ${message}</p></div>`;
      eventBanner.classList.remove('hidden');
    }
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
      socket.emit('join-game-room', { gameId: activeGame.id, teamId: currentTeam ? currentTeam.id : null });
    }

    // Determine screen to show
    if (activeGame.status === 'ENDED') {
      await showResultsSection();
      return;
    }

    if (!currentTeam) {
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

  const res = await fetch(`${API_BASE}/api/market-mayhem/debrief`, { credentials: 'include' });
  const data = await res.json();
  if (data.success) {
    renderFinalPodium(data.leaderboard);
    renderDebriefTable(data.tips);
    renderTeamValueChart(data.leaderboard, data.priceHistory);
  }
}

function updateDashboardUI(data) {
  // HUD
  const roundBadge = document.getElementById('hud-round-badge');
  const phaseBadge = document.getElementById('hud-phase-badge');
  if (roundBadge) roundBadge.textContent = `ROUND ${activeGame.currentRound} / 5`;
  if (phaseBadge) phaseBadge.textContent = `PHASE: ${activeGame.currentPhase}`;

  updateTimerDisplay(activeGame.timerRemaining || 120);

  // Financial Summary
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

  // Stock Cards Arena
  renderStockCards(data.stocks || []);

  // Tip Shop
  renderTipShop(data.availableTips || []);
  renderPurchasedTips();

  // Holdings
  renderHoldings(data.holdings || []);

  // Leaderboard
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
  const elTotal = document.getElementById('fin-total');
  const elPnl = document.getElementById('fin-pnl');

  if (elCash) elCash.textContent = `₹${cash.toLocaleString('en-IN')}`;
  if (elPort) elPort.textContent = `₹${holdingsValue.toLocaleString('en-IN')}`;
  if (elTotal) elTotal.textContent = `₹${total.toLocaleString('en-IN')}`;
  if (elPnl) {
    const pnlSign = pnl >= 0 ? '+' : '';
    elPnl.textContent = `${pnlSign}₹${pnl.toLocaleString('en-IN')} (${pnlSign}${pnlPct}%)`;
    elPnl.className = pnl >= 0 ? 'fin-value pos' : 'fin-value neg';
  }
}

function updateTimerDisplay(remainingSeconds) {
  const timerText = document.getElementById('hud-timer-text');
  if (!timerText) return;
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  timerText.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Render Stock Cards in Trading Arena
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

    return `
      <div class="stock-arena-card">
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
          <span>OWNED SHARES:</span> <strong>${ownedQty}</strong>
        </div>

        <div class="card-trade-actions">
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

  if (title) title.textContent = `EXECUTE ${defaultType} — ${stock.ticker}`;
  if (nameEl) nameEl.textContent = stock.name;
  if (priceEl) priceEl.textContent = `₹${parseFloat(stock.current_price).toLocaleString('en-IN')}`;
  if (cashEl) cashEl.textContent = `₹${(currentTeam ? currentTeam.cashBalance : 0).toLocaleString('en-IN')}`;

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

  updateTradeEstTotal();
  document.getElementById('trade-modal').classList.remove('hidden');
};

function updateTradeEstTotal() {
  if (!selectedTradeStock) return;
  const qtyInput = document.getElementById('trade-quantity-input');
  const estEl = document.getElementById('trade-est-total');
  const qty = parseInt(qtyInput ? qtyInput.value : 1) || 1;
  const total = qty * parseFloat(selectedTradeStock.current_price);
  if (estEl) estEl.textContent = `₹${total.toLocaleString('en-IN')}`;
}

async function handleExecuteTrade() {
  if (!selectedTradeStock) return;

  const btnBuy = document.getElementById('trade-btn-buy');
  const tradeType = btnBuy.classList.contains('active') ? 'BUY' : 'SELL';
  const qtyInput = document.getElementById('trade-quantity-input');
  const quantity = parseInt(qtyInput ? qtyInput.value : 0);

  if (isNaN(quantity) || quantity <= 0) {
    alert('Please enter a valid quantity greater than 0.');
    return;
  }

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
      alert(data.message);
      return;
    }

    document.getElementById('trade-modal').classList.add('hidden');
    refreshPlayerState();

  } catch (e) {
    alert('Trade execution failed. Please try again.');
  }
}

// Tip Shop Renderers
function renderTipShop(tips) {
  const container = document.getElementById('available-tips-grid');
  const pill = document.getElementById('tip-counter-pill');
  if (!container) return;

  const boughtCount = purchasedTips.filter(t => t.round_number === activeGame.currentRound).length;
  if (pill) pill.textContent = `TIPS BOUGHT THIS ROUND: ${boughtCount} / 2`;

  const isTipPhase = activeGame && (activeGame.currentPhase === 'TIP_SHOP' || activeGame.currentPhase === 'TRADING');

  container.innerHTML = tips.map(tip => {
    const isBought = purchasedTips.some(pt => pt.tip_id === tip.id);

    return `
      <div class="tip-card ${tip.is_super_tip ? 'super-tip' : ''}">
        ${tip.is_super_tip ? '<span class="super-badge">⚡ SUPER TIP</span>' : ''}
        <div class="tip-source">Source: <strong>${tip.source_label}</strong></div>
        <div class="tip-stock-tag">Linked Stock: ${tip.stock_name} (${tip.stock_ticker})</div>
        <p class="tip-preview">"${tip.text}"</p>
        <div class="tip-price">Cost: ₹${parseFloat(tip.price).toLocaleString('en-IN')}</div>
        
        <button class="btn ${tip.is_super_tip ? 'btn-primary' : 'btn-secondary'} buy-tip-btn"
                ${(isBought || !isTipPhase || boughtCount >= 2) ? 'disabled' : ''}
                onclick="window.buyTip(${tip.id})">
          ${isBought ? '✅ PURCHASED' : 'BUY PRIVATE TIP'}
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
      alert(data.message);
      return;
    }
    refreshPlayerState();
  } catch (e) {
    alert('Failed to purchase tip.');
  }
};

function renderPurchasedTips() {
  const container = document.getElementById('purchased-tips-list');
  if (!container) return;

  if (purchasedTips.length === 0) {
    container.innerHTML = '<p class="empty-state">No private tips purchased yet.</p>';
    return;
  }

  // Strictly omitting hidden parameters: is_true, effect_size, is_flagged
  container.innerHTML = purchasedTips.map(pt => `
    <div class="private-tip-card ${pt.is_super_tip ? 'super' : ''}">
      <div class="pt-header">
        <span>Round ${pt.round_number} — ${pt.source_label}</span>
        <span class="pt-stock">${pt.stock_name || 'Market'}</span>
      </div>
      <p class="pt-text">"${pt.text}"</p>
    </div>
  `).join('');
}

// Holdings & Leaderboard Renderers
function renderHoldings(holdings) {
  const container = document.getElementById('holdings-list');
  if (!container) return;

  if (holdings.length === 0) {
    container.innerHTML = '<p class="empty-state">No stock holdings owned.</p>';
    return;
  }

  container.innerHTML = holdings.map(h => {
    const stock = currentStocks.find(s => s.id === h.stock_id);
    const p = stock ? parseFloat(stock.current_price) : 0;
    const totalVal = h.quantity * p;

    return `
      <div class="holding-item">
        <div class="h-left">
          <strong>${h.ticker}</strong>
          <span>${h.quantity} shares</span>
        </div>
        <div class="h-right">
          <span class="h-val">₹${totalVal.toLocaleString('en-IN')}</span>
          <span class="h-price">@ ₹${p.toLocaleString('en-IN')}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderLeaderboard(leaderboard) {
  const tbody = document.getElementById('leaderboard-tbody');
  if (!tbody) return;

  tbody.innerHTML = leaderboard.map(t => {
    const isMyTeam = currentTeam && currentTeam.id === t.teamId;

    return `
      <tr class="${isMyTeam ? 'my-team-row' : ''}">
        <td><strong>#${t.rank}</strong></td>
        <td>${t.teamName} ${isMyTeam ? '(YOU)' : ''}</td>
        <td class="gold">₹${Math.round(t.totalValue).toLocaleString('en-IN')}</td>
      </tr>
    `;
  }).join('');
}

function renderTradeStream(trades) {
  const container = document.getElementById('trades-stream');
  if (!container) return;

  if (trades.length === 0) {
    container.innerHTML = '<p class="empty-state">No trades executed yet.</p>';
    return;
  }

  container.innerHTML = trades.map(tr => `
    <div class="trade-stream-item ${tr.type.toLowerCase()}">
      <span class="t-type">${tr.type}</span>
      <span class="t-details">${tr.quantity} x ${tr.ticker}</span>
      <span class="t-val">₹${parseFloat(tr.total_value).toLocaleString('en-IN')}</span>
    </div>
  `).join('');
}

// ─── CHARTS ───
function renderStockPricesChart() {
  const ctx = document.getElementById('stockPricesChart');
  if (!ctx) return;

  fetch(`${API_BASE}/api/market-mayhem/fact-sheet`, { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (!data.success) return;

      const stocks = data.stocks;
      const rounds = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
      const colors = ['#00e5ff', '#e0c253', '#ff3b30', '#27c93f', '#af52de'];

      const datasets = stocks.map((s, idx) => {
        const dataPoints = rounds.map(r => {
          const entry = s.history.find(h => h.round === r);
          return entry ? entry.price : null;
        });

        return {
          label: `${s.name} (${s.ticker})`,
          data: dataPoints,
          borderColor: colors[idx % colors.length],
          backgroundColor: colors[idx % colors.length] + '22',
          tension: 0.25,
          borderWidth: 2
        };
      });

      if (stockChartInstance) stockChartInstance.destroy();

      stockChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: rounds.map(r => r <= 0 ? `M${r}` : `R${r}`), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8aa2b8', font: { family: 'JetBrains Mono' } } } },
          scales: {
            x: { ticks: { color: '#8aa2b8' }, grid: { color: 'rgba(0, 229, 255, 0.08)' } },
            y: { ticks: { color: '#8aa2b8' }, grid: { color: 'rgba(0, 229, 255, 0.08)' } }
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

// ─── FINAL DEBRIEF RENDERER ───
function renderFinalPodium(leaderboard) {
  const container = document.getElementById('final-podium-grid');
  if (!container) return;

  const top3 = leaderboard.slice(0, 3);
  container.innerHTML = top3.map((t, idx) => `
    <div class="podium-card rank-${idx + 1}">
      <div class="trophy">${idx === 0 ? '🥇 WINNER' : idx === 1 ? '🥈 2ND PLACE' : '🥉 3RD PLACE'}</div>
      <h3 class="podium-team">${t.teamName}</h3>
      <div class="podium-val">₹${Math.round(t.totalValue).toLocaleString('en-IN')}</div>
    </div>
  `).join('');
}

function renderDebriefTable(tips) {
  const tbody = document.getElementById('debrief-tbody');
  if (!tbody) return;

  tbody.innerHTML = tips.map(t => `
    <tr>
      <td>R${t.round_number}</td>
      <td><strong>${t.source_label}</strong></td>
      <td>${t.stock_ticker}</td>
      <td>"${t.text}"</td>
      <td><span class="truth-badge ${t.is_true ? 'true' : 'false'}">${t.is_true ? 'TRUE' : 'FALSE'}</span></td>
      <td class="${parseFloat(t.effect_size) >= 0 ? 'pos' : 'neg'}">${t.effect_size > 0 ? '+' : ''}${t.effect_size}%</td>
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

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/teams/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ teamCode, displayName })
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
    alert('Failed to join team.');
  }
}

function renderLobbyWaitingRoom() {
  if (!currentTeam) return;

  document.getElementById('mm-lobby-choices').classList.add('hidden');
  document.getElementById('mm-create-team-box').classList.add('hidden');
  document.getElementById('mm-join-team-box').classList.add('hidden');
  document.getElementById('mm-waiting-room').classList.remove('hidden');

  const nameEl = document.getElementById('lobby-team-name');
  const codeEl = document.getElementById('lobby-team-code');
  if (nameEl) nameEl.textContent = currentTeam.name;
  if (codeEl) codeEl.textContent = currentTeam.code;

  renderLobbyMembers(currentTeam.members || []);
}

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
