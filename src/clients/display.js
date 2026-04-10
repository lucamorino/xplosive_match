import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';

const clamp01 = (value) => Math.max(0, Math.min(100, value));

async function main($container) {
  const config = loadConfig();
  const client = new Client(config);

  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  await client.start();

  const global = await client.stateManager.attach('global');
  const controlCollection = await client.stateManager.getCollection('control');
  const controlStates = new Map();
  const userCollection = await client.stateManager.getCollection('user');
  const userStates = new Map();

  function drawPad() {
    const canvas = document.getElementById('controller-pad');
    if (!canvas) return;

    const displayWidth = Math.max(1, Math.floor(canvas.clientWidth));
    const displayHeight = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#060608';
    ctx.fillRect(0, 0, width, height);

    const controls = Array.from(controlStates.values()).sort((a, b) => {
      return (a.get('id') ?? 0) - (b.get('id') ?? 0);
    });

    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(0, 0, width, height);

    controls.forEach((state) => {
      const id = state.get('id') ?? '?';
      const xValue = clamp01(state.get('X') ?? state.get('x') ?? 0);
      const yValue = clamp01(state.get('Y') ?? state.get('y') ?? 0);
      const isActive = (state.get('active') ?? 0) > 0;
      const point = {
        x: (xValue / 100) * width,
        y: (yValue / 100) * height,
      };
      const radius = isActive ? 10 : 7;
      const haloOpacity = isActive ? 0.9 : 0.6;

      const haloGradient = ctx.createRadialGradient(
        point.x,
        point.y,
        0,
        point.x,
        point.y,
        radius * 3,
      );
      haloGradient.addColorStop(0, `rgba(180, 220, 255, ${0.35 * haloOpacity})`);
      haloGradient.addColorStop(1, 'rgba(180, 220, 255, 0)');
      ctx.fillStyle = haloGradient;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = isActive ? '#ffffff' : 'rgba(255, 255, 255, 0.55)';
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#e9f1ff';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${id}`, point.x + radius + 4, point.y - radius);
    });
  }

  function renderApp() {
    const sortedUsers = Array.from(userStates.values()).sort((a, b) => (a.get('id') ?? 0) - (b.get('id') ?? 0));
    const user1 = sortedUsers[0];
    const user2 = sortedUsers[1];
    const formatScore = (userState) => {
      const raw = userState?.get?.('score');
      const val = Number(raw);
      return Number.isFinite(val) ? val.toFixed(2) : '0.00';
    };

    render(html`
      <div id="app-root" class="cloud-app controller-cloud-app">
        <div class="cloud-layer cloud-layer-a"></div>
        <div class="cloud-layer cloud-layer-b"></div>
        <div class="cloud-layer cloud-layer-c"></div>
        <canvas id="controller-pad"></canvas>
        <div class="display-scoreboard" aria-live="polite">
          <div class="score-entry">
            <span class="score-label">Player 1</span>
            <span class="score-value">${formatScore(user1)}</span>
          </div>
          <div class="score-entry">
            <span class="score-label">Player 2</span>
            <span class="score-value">${formatScore(user2)}</span>
          </div>
        </div>
      </div>
    `, $container);

    drawPad();
  }

  controlCollection.onAttach((state) => {
    controlStates.set(state.id, state);
    renderApp();
  }, true);

  controlCollection.onDetach((state) => {
    controlStates.delete(state.id);
    renderApp();
  });

  controlCollection.onChange(() => {
    renderApp();
  });

  global.onUpdate(() => {
    renderApp();
  });

  userCollection.onAttach((state) => {
    userStates.set(state.id, state);
    renderApp();
  }, true);

  userCollection.onDetach((state) => {
    userStates.delete(state.id);
    renderApp();
  });

  userCollection.onChange(() => {
    renderApp();
  });

  window.addEventListener('resize', () => {
    drawPad();
  });

  renderApp();
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '100%',
});
