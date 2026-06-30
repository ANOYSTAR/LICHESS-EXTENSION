// popup.js - Extension Popup Controller

const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const colorText    = document.getElementById('colorText');
const engineStatus = document.getElementById('engineStatus');
const playingAs    = document.getElementById('playingAs');
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const depthSlider  = document.getElementById('depthSlider');
const depthDisplay = document.getElementById('depthDisplay');
const delaySlider  = document.getElementById('delaySlider');
const delayDisplay = document.getElementById('delayDisplay');
const mainView     = document.getElementById('main-view');
const notLichess   = document.getElementById('not-lichess-view');
const movesCount   = document.getElementById('movesCount');

// ─── Check if we're on lichess ───────────────────────────────
async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('lichess.org')) {
    mainView.style.display = 'none';
    notLichess.style.display = 'block';
    return false;
  }
  mainView.style.display = 'block';
  notLichess.style.display = 'none';
  return true;
}

// ─── Get status from content script ──────────────────────────
async function getStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
    if (response) updateUI(response);
  } catch (e) {
    statusText.textContent = 'Open a game on Lichess';
    engineStatus.textContent = '—';
  }
}

// ─── Update popup UI ─────────────────────────────────────────
function updateUI(data) {
  if (data.active) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Active';
    startBtn.disabled = true;
    startBtn.style.opacity = '0.5';
    stopBtn.disabled = false;
    stopBtn.style.opacity = '1';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = data.engineReady ? 'Ready' : 'Idle';
    startBtn.disabled = false;
    startBtn.style.opacity = '1';
    stopBtn.disabled = true;
    stopBtn.style.opacity = '0.5';
  }

  if (data.engineReady) {
    engineStatus.textContent = 'Ready ✓';
    engineStatus.style.color = '#3fb950';
  } else {
    engineStatus.textContent = 'Not loaded';
    engineStatus.style.color = '#d29922';
  }

  if (data.color) {
    const cap = data.color.charAt(0).toUpperCase() + data.color.slice(1);
    playingAs.textContent = cap;
    colorText.textContent = cap;
    playingAs.style.color = data.color === 'white' ? '#f0d9b5' : '#b58863';
    colorText.style.color = data.color === 'white' ? '#f0d9b5' : '#b58863';
  }

  if (movesCount && typeof data.moves === 'number') {
    movesCount.textContent = data.moves;
  }
}

// ─── Start Bot ────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  statusText.textContent = 'Starting...';
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'START_BOT',
      depth: parseInt(depthSlider.value),
    });
    if (resp?.success) {
      statusDot.className = 'status-dot active';
      statusText.textContent = 'Active';
      startBtn.disabled = true;
      startBtn.style.opacity = '0.5';
      stopBtn.disabled = false;
      stopBtn.style.opacity = '1';
    } else {
      statusText.textContent = 'Failed to start';
      statusDot.className = 'status-dot error';
    }
  } catch (e) {
    statusText.textContent = 'Error — refresh page';
    statusDot.className = 'status-dot error';
  }
});

// ─── Stop Bot ─────────────────────────────────────────────────
stopBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'STOP_BOT' });
    statusDot.className = 'status-dot';
    statusText.textContent = 'Stopped';
    startBtn.disabled = false;
    startBtn.style.opacity = '1';
    stopBtn.disabled = true;
    stopBtn.style.opacity = '0.5';
  } catch (e) {}
});

// ─── Depth Slider ─────────────────────────────────────────────
depthSlider.addEventListener('input', async (e) => {
  const val = e.target.value;
  depthDisplay.textContent = val;
  chrome.storage.local.set({ depth: parseInt(val) });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'SET_DEPTH', depth: parseInt(val) }); }
  catch (e) {}
});

// ─── Delay Slider ─────────────────────────────────────────────
delaySlider.addEventListener('input', async (e) => {
  const val = e.target.value;
  delayDisplay.textContent = `${val}ms`;
  chrome.storage.local.set({ delay: parseInt(val) });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: 'SET_DELAY', delay: parseInt(val) }); }
  catch (e) {}
});

// ─── Load saved settings ──────────────────────────────────────
chrome.storage.local.get(['depth', 'delay'], (data) => {
  if (data.depth) {
    depthSlider.value = data.depth;
    depthDisplay.textContent = data.depth;
  }
  if (data.delay) {
    delaySlider.value = data.delay;
    delayDisplay.textContent = `${data.delay}ms`;
  }
});

// ─── Initialize ───────────────────────────────────────────────
(async () => {
  const isLichess = await checkTab();
  if (isLichess) {
    await getStatus();
    setInterval(getStatus, 1500);
  }
})();
