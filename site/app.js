const worldCount = document.querySelector('#world-count');
const residentCount = document.querySelector('#resident-count');
const chainId = document.querySelector('#chain-id');
const statsState = document.querySelector('#stats-state');

function displayCount(value) {
  return new Intl.NumberFormat().format(Number.isFinite(value) && value >= 0 ? value : 0);
}

async function loadStats() {
  try {
    const response = await fetch('/public/stats', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Stats request failed (${response.status})`);
    const stats = await response.json();
    worldCount.textContent = displayCount(stats.openWorlds);
    residentCount.textContent = displayCount(stats.residents);
    chainId.textContent = displayCount(stats.chainId);
    statsState.textContent = '· Updated just now';
  } catch {
    statsState.textContent = '· Snapshot unavailable';
  }
}

loadStats();
