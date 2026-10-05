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
  if (btnEndGame) btnEndGame.addEventListener('click', handleEndGame);

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

  // Create New Game confirm button
  const confirmNewGameBtn = document.getElementById('btn-confirm-new-game');
  if (confirmNewGameBtn) {
    confirmNewGameBtn.addEventListener('click', createNewGame);
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
      // Use same room naming as server: game_<id>
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

  // game-ended: server confirmed game is ENDED — show ended controls immediately
  socket.on('game-ended', ({ gameId, leaderboard, message }) => {
    console.log(`[HOST] game-ended received for game ${gameId}`);
    if (hostActiveGame) hostActiveGame.status = 'ENDED';
    // Update badge immediately without waiting for loadHostData round-trip
    const phaseBadge = document.getElementById('host-phase-badge');
    if (phaseBadge) phaseBadge.textContent = 'STATUS: ENDED (REVEAL)';
    showEndedControls(true);
    if (leaderboard && leaderboard.length > 0) {
      renderHostTeams(leaderboard);
    }
    // Show a non-blocking notification
    const banner = document.getElementById('host-event-banner');
    if (banner) {
      banner.textContent = `✅ GAME ENDED: ${message || 'Final results are now live for all players.'}` ;
      banner.style.display = 'block';
      setTimeout(() => { banner.style.display = 'none'; }, 8000);
    }
    loadHostData();
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
    } else {
      // No active game found (all games ENDED or none exist yet)
      hostActiveGame = null;
      const title = document.getElementById('host-game-title');
      const phaseBadge = document.getElementById('host-phase-badge');
      if (title) title.textContent = 'No Active Game';
      if (phaseBadge) phaseBadge.textContent = 'STATUS: ENDED';
      showEndedControls(true); // show CREATE NEW GAME panel
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

  // Show/hide phase controls vs ENDED panel
  const isEnded = (game.status === 'ENDED');
  showEndedControls(isEnded ? game : null);

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

  // Sync allow_solo checkbox
  const cfgAllowSolo = document.getElementById('cfg-allow-solo');
  if (cfgAllowSolo) cfgAllowSolo.checked = (game.allow_solo !== false);


  const pricesRound = document.getElementById('host-prices-round');
  if (pricesRound) pricesRound.textContent = game.current_round;
}

// Show phase controls OR ended panel based on game state
// Pass a truthy value (game object or true) to show ENDED panel; falsy to show normal controls
function showEndedControls(showEnded) {
  const phaseControls = document.getElementById('host-phase-controls');
  const endedControls = document.getElementById('host-ended-controls');
  const actionBar = document.querySelector('.host-actions-bar');

  if (showEnded) {
    // Game is ENDED — show the "CREATE NEW GAME" panel, hide normal controls
    if (phaseControls) phaseControls.style.display = 'none';
    if (endedControls) endedControls.style.display = 'block';
    if (actionBar) actionBar.style.opacity = '0.4';

    // Auto-populate the new game name based on history count
    autoPopulateNewGameName();
  } else {
    // Game is active/lobby — show normal phase controls
    if (phaseControls) phaseControls.style.display = '';
    if (endedControls) endedControls.style.display = 'none';
    if (actionBar) actionBar.style.opacity = '';
  }
}

// Suggest next game name (Season N+1)
async function autoPopulateNewGameName() {
  const nameInput = document.getElementById('new-game-name');
  if (!nameInput || nameInput.value.trim()) return; // Don't override manual input

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/games/history`, { credentials: 'include' });
    const data = await res.json();
    if (data.success) {
      const count = data.games.length;
      nameInput.value = `Market Mayhem Season ${count + 1}`;
    }
  } catch (e) { /* silent fallback */ }
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
    }
    // END_GAME is handled by handleEndGame() directly — not via changePhase()

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

// Dedicated END GAME handler — sends END_GAME directly to backend
async function handleEndGame() {
  const confirmed = window.confirm(
    '⚠️ END GAME\n\nThis will immediately end the game for ALL players and display the final results.\n\nAre you sure?'
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/phase-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include',
      body: JSON.stringify({ newPhase: 'END_GAME' })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message);
      return;
    }
    // UI update will be handled by game-ended socket event
  } catch (e) {
    alert('Failed to end game. Please try again.');
  }
}

// ─── New Game Creation ───

window.openNewGameModal = function() {
  const modal = document.getElementById('new-game-modal');
  if (modal) modal.classList.remove('hidden');
  // Hide history panel if open
  const histPanel = document.getElementById('host-history-panel');
  if (histPanel) histPanel.classList.add('hidden');
  // Auto-fill name
  autoPopulateNewGameName();
};

window.closeNewGameModal = function() {
  const modal = document.getElementById('new-game-modal');
  if (modal) modal.classList.add('hidden');
};

async function createNewGame() {
  const gameName = (document.getElementById('new-game-name')?.value || '').trim();
  const startingCash = parseFloat(document.getElementById('new-game-cash')?.value) || 100000;
  const maxTeamSize = parseInt(document.getElementById('new-game-team-size')?.value) || 4;
  const roundTimerSeconds = parseInt(document.getElementById('new-game-timer')?.value) || 120;
  const penaltyPercentage = parseFloat(document.getElementById('new-game-penalty')?.value) || 10;
  const sebiCheckRound = parseInt(document.getElementById('new-game-sebi')?.value) || 4;

  if (!gameName) {
    alert('Please enter a game name.');
    return;
  }

  const confirmBtn = document.getElementById('btn-confirm-new-game');
  if (confirmBtn) {
    confirmBtn.textContent = 'CREATING...';
    confirmBtn.disabled = true;
  }

  try {
    // Use dedicated /host/new-game endpoint which validates the previous game is ENDED
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/new-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include',
      body: JSON.stringify({ gameName, startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound })
    });

    const data = await res.json();
    if (!data.success) {
      alert(`Failed to create game: ${data.message}`);
      return;
    }

    const newGame = data.game;
    hostActiveGame = newGame;

    // Close modal
    window.closeNewGameModal();

    // Switch socket to new game room
    if (socket && socket.connected) {
      socket.emit('join-game-room', { gameId: newGame.id });
    }

    // Clear live trades list (fresh game)
    liveTradesList.length = 0;

    // Reload full host data
    await loadHostData();

    alert(`✅ New game created: ${newGame.name} (ID #${newGame.id})\nStatus: LOBBY — players can now join!`);

  } catch (e) {
    console.error('Create new game error:', e);
    alert('Failed to create new game. Please try again.');
  } finally {
    if (confirmBtn) {
      confirmBtn.textContent = '✨ CREATE GAME';
      confirmBtn.disabled = false;
    }
  }
}

window.loadGameHistory = async function() {
  const panel = document.getElementById('host-history-panel');
  const list = document.getElementById('host-history-list');
  if (!panel || !list) return;

  panel.classList.toggle('hidden');

  if (!panel.classList.contains('hidden')) {
    try {
      const res = await fetch(`${API_BASE}/api/market-mayhem/games/history`, { credentials: 'include' });
      const data = await res.json();

      if (data.success && data.games.length > 0) {
        list.innerHTML = data.games.map(g => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0; border-bottom:1px solid rgba(0,229,255,0.1);">
            <div>
              <span style="font-family:'JetBrains Mono',monospace; color:var(--cyan); font-size:0.8rem;">#${g.id}</span>
              <strong style="margin-left:0.75rem;">${g.name}</strong>
            </div>
            <div style="display:flex; gap:0.75rem; align-items:center;">
              <span class="phase-badge" style="font-size:0.75rem;">${g.status}</span>
              <span style="font-size:0.75rem; color:#8aa2b8;">R${g.current_round} · ${g.current_phase}</span>
              ${g.ended_at ? `<span style="font-size:0.7rem; color:#8aa2b8;">Ended: ${new Date(g.ended_at).toLocaleString()}</span>` : ''}
            </div>
          </div>
        `).join('');
      } else {
        list.innerHTML = '<p class="empty-state">No previous games found.</p>';
      }
    } catch (e) {
      list.innerHTML = '<p class="empty-state">Failed to load game history.</p>';
    }
  }
};

async function pauseTimer() {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/pause-timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include'
    });
    const data = await res.json();
    alert(data.message || 'Timer paused.');
  } catch (e) {
    alert('Failed to pause timer.');
  }
}
async function resumeTimer() {
  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/resume-timer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include'
    });
    const data = await res.json();
    alert(data.message || 'Timer resumed.');
  } catch (e) {
    alert('Failed to resume timer.');
  }
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
  const allowSoloEl = document.getElementById('cfg-allow-solo');
  const allowSolo = allowSoloEl ? allowSoloEl.checked : true;

  try {
    const res = await fetch(`${API_BASE}/api/market-mayhem/host/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-key': 'EIC_HOST_2026' },
      credentials: 'include',
      body: JSON.stringify({ startingCash, maxTeamSize, roundTimerSeconds, penaltyPercentage, sebiCheckRound, allowSolo })
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

