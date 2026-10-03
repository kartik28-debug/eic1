/**
 * Market Mayhem — Host Control Dashboard Script
 * Handles host authentication, phase machine transitions, timer controls,
 * game parameter configuration, SEBI checks, super tip assignments, and live monitoring.
 */

import { io } from 'socket.io-client';

const API_BASE = 'http://localhost:5000';
let socket = null;
let hostActiveGame = null;

document.addEventListener('DOMContentLoaded', () => {
  setupHostEventListeners();
  checkHostSession();
});

function setupHostEventListeners() {
  const loginBtn = document.getElementById('btn-host-login');
  if (loginBtn) {
    loginBtn.addEventListener('click', handleHostLogin);
  }

  // Phase Controls
  const btnStart = document.getElementById('host-btn-start');
  const btnNextPhase = document.getElementById('host-btn-next-phase');
  const btnPauseTimer = document.getElementById('host-btn-pause-timer');
  const btnResumeTimer = document.getElementById('host-btn-resume-timer');
  const btnEndGame = document.getElementById('host-btn-end-game');

  if (btnStart) btnStart.addEventListener('click', () => changePhase('START_GAME'));
  if (btnNextPhase) btnNextPhase.addEventListener('click', () => changePhase('NEXT_PHASE'));
  if (btnPauseTimer) btnPauseTimer.addEventListener('click', pauseTimer);
  if (btnResumeTimer) btnResumeTimer.addEventListener('click', resumeTimer);
  if (btnEndGame) btnEndGame.addEventListener('click', () => changePhase('END_GAME'));

  // Special Actions
  const btnSuperTip = document.getElementById('host-btn-super-tip');
  const btnSebiCheck = document.getElementById('host-btn-sebi-check');
  const btnBullRun = document.getElementById('host-btn-bull-run');
  const btnCrash = document.getElementById('host-btn-market-crash');

  if (btnSuperTip) btnSuperTip.addEventListener('click', assignSuperTip);
  if (btnSebiCheck) btnSebiCheck.addEventListener('click', runSebiCheck);
  if (btnBullRun) btnBullRun.addEventListener('click', () => triggerMarketEvent('BULL_RUN'));
  if (btnCrash) btnCrash.addEventListener('click', () => triggerMarketEvent('CRASH'));

  // Save Config
  const saveCfgBtn = document.getElementById('btn-save-config');
  if (saveCfgBtn) {
    saveCfgBtn.addEventListener('click', saveConfiguration);
  }
}

async function handleHostLogin() {
  const keyInput = document.getElementById('host-key-input');
  const hostKey = keyInput ? keyInput.value.trim() : '';

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ hostKey })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.message);
      return;
    }

    showHostDashboard();
  } catch (e) {
    alert('Host login failed.');
  }
}

async function checkHostSession() {
  // Attempt to fetch game state to check if host is authorized
  const res = await fetch(`${API_BASE}/api/market-mayhem/active-game`, { credentials: 'include' });
  if (res.ok) {
    showHostDashboard();
  }
}

let isSocketInitialized = false;
const liveTradesList = [];

function showHostDashboard() {
  document.getElementById('host-auth-section').classList.add('hidden');
  document.getElementById('host-dashboard-section').classList.remove('hidden');

  if (!isSocketInitialized) {
    initHostSocket();
    isSocketInitialized = true;
  }
  loadHostData();
}

function initHostSocket() {
  if (socket) return;
  socket = io(API_BASE, { withCredentials: true });

  socket.on('connect', () => {
    if (hostActiveGame) {
      socket.emit('join-game-room', { gameId: hostActiveGame.id });
    }
  });

  socket.on('lobby-updated', loadHostData);
  socket.on('game-state-updated', loadHostData);
  socket.on('leaderboard-updated', loadHostData);

  socket.on('timer-tick', ({ remainingSeconds }) => {
    updateHostTimerDisplay(remainingSeconds);
  });

  socket.on('trade-executed', (trade) => {
    liveTradesList.unshift(trade);
    if (liveTradesList.length > 30) liveTradesList.pop();
    renderHostTrades(liveTradesList);
  });
}

async function loadHostData() {
  try {
    const gameRes = await fetch(`${API_BASE}/api/market-mayhem/active-game`, { credentials: 'include' });
    const gameData = await gameRes.json();

    if (gameData.success) {
      hostActiveGame = gameData.game;
      updateHostHeader(hostActiveGame);

      if (socket && socket.connected) {
        socket.emit('join-game-room', { gameId: hostActiveGame.id });
      }
    }

    // Load debrief master data for host monitoring
    const debriefRes = await fetch(`${API_BASE}/api/market-mayhem/debrief`, { credentials: 'include' });
    const debriefData = await debriefRes.json();

    if (debriefData.success) {
      renderHostTeams(debriefData.leaderboard || []);
      renderHostPrices(debriefData.priceHistory || []);
      renderHostMasterTips(debriefData.tips || []);
    }

  } catch (e) {
    console.error('Error loading host data:', e);
  }
}

function updateHostHeader(game) {
  const title = document.getElementById('host-game-title');
  const roundBadge = document.getElementById('host-round-badge');
  const phaseBadge = document.getElementById('host-phase-badge');

  if (title) title.textContent = game.name;
  if (roundBadge) roundBadge.textContent = `ROUND ${game.current_round} / 5`;
  if (phaseBadge) phaseBadge.textContent = `STATUS: ${game.status} (${game.current_phase})`;

  // Update Config Inputs
  const cfgCash = document.getElementById('cfg-starting-cash');
  const cfgTeamSize = document.getElementById('cfg-team-size');
  const cfgTimer = document.getElementById('cfg-timer-seconds');
  const cfgPenalty = document.getElementById('cfg-penalty-pct');
  const cfgSebi = document.getElementById('cfg-sebi-round');

  if (cfgCash) cfgCash.value = parseFloat(game.starting_cash);
  if (cfgTeamSize) cfgTeamSize.value = game.max_team_size;
  if (cfgTimer) cfgTimer.value = game.round_timer_seconds;
  if (cfgPenalty) cfgPenalty.value = parseFloat(game.penalty_percentage);
  if (cfgSebi) cfgSebi.value = game.sebi_check_round;

  const pricesRound = document.getElementById('host-prices-round');
  if (pricesRound) pricesRound.textContent = game.current_round;
}

function updateHostTimerDisplay(remainingSeconds) {
  const timerBadge = document.getElementById('host-timer-badge');
  if (!timerBadge) return;
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  timerBadge.textContent = `⏱ ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Host Phase State Machine Controller
async function changePhase(newPhase) {
  try {
    let payload = {};
    if (newPhase === 'START_GAME') {
      payload = { newPhase: 'START_GAME', newRound: 1 };
    } else if (newPhase === 'NEXT_PHASE') {
      const currentP = hostActiveGame ? hostActiveGame.current_phase : 'LOBBY';
      const currentR = hostActiveGame ? hostActiveGame.current_round : 1;

      if (currentP === 'LOBBY') payload = { newPhase: 'BLOCK_DEAL', newRound: 1 };
      else if (currentP === 'BLOCK_DEAL') payload = { newPhase: 'TRADING', newRound: currentR };
      else if (currentP === 'TRADING') payload = { newPhase: 'TIP_SHOP', newRound: currentR };
      else if (currentP === 'TIP_SHOP') payload = { newPhase: 'REVEAL', newRound: currentR };
      else if (currentP === 'REVEAL') payload = { newPhase: 'NEXT_ROUND', newRound: currentR };
    } else if (newPhase === 'END_GAME') {
      payload = { newPhase: 'REVEAL', newRound: 5 };
    }

    const res = await fetch(`${API_BASE}/api/market-mayhem/host/phase-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.message);
      return;
    }

    loadHostData();
  } catch (e) {
    alert('Failed to execute phase change.');
  }
}

async function pauseTimer() {
  alert('Timer paused');
}
async function resumeTimer() {
  alert('Timer resumed');
}

// Special Host Event Triggers
async function assignSuperTip() {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/super-tip/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include'
    });
    const data = await res.json();
    alert(data.message);
  } catch (e) {
    alert('Failed to assign super tip.');
  }
}

async function runSebiCheck() {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/sebi-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include'
    });
    const data = await res.json();
    alert(data.message);
  } catch (e) {
    alert('SEBI Check execution failed.');
  }
}

async function triggerMarketEvent(eventType) {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/market-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include',
      body: JSON.stringify({ eventType })
    });
    const data = await res.json();
    alert(data.message);
    loadHostData();
  } catch (e) {
    alert('Market event trigger failed.');
  }
}

async function saveConfiguration() {
  const startingCash = parseFloat(document.getElementById('cfg-starting-cash').value);
  const maxTeamSize = parseInt(document.getElementById('cfg-team-size').value);
  const roundTimerSeconds = parseInt(document.getElementById('cfg-timer-seconds').value);
  const penaltyPercentage = parseFloat(document.getElementById('cfg-penalty-pct').value);
  const sebiCheckRound = parseInt(document.getElementById('cfg-sebi-round').value);

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include',
      body: JSON.stringify({ startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound })
    });
    const data = await res.json();
    alert(data.message);
    loadHostData();
  } catch (e) {
    alert('Failed to save configuration.');
  }
}

// Renderers for Host Monitoring
function renderHostTeams(teams) {
  const tbody = document.getElementById('host-teams-tbody');
  if (!tbody) return;

  if (teams.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">No teams registered yet.</td></tr>';
    return;
  }

  tbody.innerHTML = teams.map(t => `
    <tr>
      <td><strong>#${t.rank}</strong></td>
      <td><strong>${t.teamName}</strong></td>
      <td><code>${t.teamCode}</code></td>
      <td>${(t.members || []).length}</td>
      <td>₹${Math.round(t.cashBalance).toLocaleString('en-IN')}</td>
      <td>₹${Math.round(t.holdingsValue).toLocaleString('en-IN')}</td>
      <td class="gold"><strong>₹${Math.round(t.totalValue).toLocaleString('en-IN')}</strong></td>
    </tr>
  `).join('');
}

function renderHostPrices(priceHistory) {
  const container = document.getElementById('host-prices-list');
  if (!container) return;

  const currentRound = hostActiveGame ? hostActiveGame.current_round : 1;
  const currentRoundPrices = priceHistory.filter(p => p.round_number === currentRound);

  container.innerHTML = currentRoundPrices.map(p => `
    <div class="host-price-item">
      <div>
        <strong>${p.name}</strong> (${p.ticker})
      </div>
      <div class="cyan">₹${parseFloat(p.price).toLocaleString('en-IN')}</div>
    </div>
  `).join('');
}

function renderHostMasterTips(tips) {
  const container = document.getElementById('host-tips-list');
  if (!container) return;

  container.innerHTML = tips.map(t => `
    <div class="host-tip-card ${t.is_super_tip ? 'super' : ''}">
      <div class="ht-header">
        <span>R${t.round_number} — ${t.source_label} (${t.stock_ticker})</span>
        <span class="ht-price">Cost: ₹${parseFloat(t.price).toLocaleString('en-IN')}</span>
      </div>
      <p class="ht-text">"${t.text}"</p>
      <div class="ht-hidden-params">
        <span class="param">Truth: <strong class="${t.is_true ? 'pos' : 'neg'}">${t.is_true ? 'TRUE' : 'FALSE'}</strong></span>
        <span class="param">Effect: <strong>${t.effect_size > 0 ? '+' : ''}${t.effect_size}%</strong></span>
        <span class="param">SEBI Flagged: <strong class="${t.is_flagged ? 'neg' : ''}">${t.is_flagged ? 'YES ⚠️' : 'NO'}</strong></span>
      </div>
    </div>
  `).join('');
}

function renderHostTrades(trades) {
  const tbody = document.getElementById('host-trades-tbody');
  if (!tbody) return;

  if (trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">Awaiting player orders...</td></tr>';
    return;
  }

  tbody.innerHTML = trades.map(t => {
    const timeStr = t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : new Date().toLocaleTimeString();
    const isBuy = t.type === 'BUY';
    return `
      <tr>
        <td><code>${timeStr}</code></td>
        <td><strong>${t.teamName || 'Team'}</strong></td>
        <td><span class="trade-type ${isBuy ? 'buy' : 'sell'}">${t.type}</span></td>
        <td><strong>${t.stockTicker || t.stockName || ''}</strong></td>
        <td>${t.quantity}</td>
        <td>₹${parseFloat(t.price || 0).toLocaleString('en-IN')}</td>
        <td class="cyan">₹${parseFloat(t.totalAmount || 0).toLocaleString('en-IN')}</td>
      </tr>
    `;
  }).join('');
}

