import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';

import pluginSync from '@soundworks/plugin-sync/client.js'; 
import pluginCheckin from '@soundworks/plugin-checkin/client.js'; 
import ClientPluginLogger from '@soundworks/plugin-logger/client.js';


// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

/**
 * Attempts to request full-screen mode for the document.
 * Logs a warning if the API is not supported or if the request fails.
 */
function tryEnterFullscreen() {
  const element = document.documentElement; // Target the entire page
  let fullscreenPromise;

  if (element.requestFullscreen) {
    fullscreenPromise = element.requestFullscreen();
  } else if (element.mozRequestFullScreen) { // Firefox
    fullscreenPromise = element.mozRequestFullScreen();
  } else if (element.webkitRequestFullscreen) { // Chrome, Safari, Opera
    fullscreenPromise = element.webkitRequestFullscreen();
  } else if (element.msRequestFullscreen) { // IE/Edge
    fullscreenPromise = element.msRequestFullscreen();
  } else {
    console.warn('Fullscreen API is not supported by this browser.');
    // If not supported, return a resolved promise as there's nothing to do.
    return Promise.resolve();
  }

  return fullscreenPromise.catch(err => {
    console.warn(`Could not enter full-screen mode: ${err.message} (${err.name})`);
    // Re-throw the error so the promise chain reflects the failure.
    // This allows platform-init to know if fullscreen failed, if it needs to.
    throw err;
  });
}

function isFullscreenActive() {
  return Boolean(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

function tryExitFullscreen() {
  if (document.exitFullscreen) {
    return document.exitFullscreen();
  }
  if (document.webkitExitFullscreen) {
    return document.webkitExitFullscreen();
  }
  if (document.mozCancelFullScreen) {
    return document.mozCancelFullScreen();
  }
  if (document.msExitFullscreen) {
    return document.msExitFullscreen();
  }
  return Promise.resolve();
}

async function main($container) {
  const config = loadConfig();
  const client = new Client(config);

  // cf. https://soundworks.dev/tools/helpers.html#browserlauncher
  launcher.register(client, {
    initScreensContainer: $container,
    reloadOnVisibilityChange: false,
  });

  client.pluginManager.register('logger', ClientPluginLogger);
  client.pluginManager.register('sync', pluginSync);

  await client.start();

  //tryEnterFullscreen();

  const global = await client.stateManager.attach('global');
  const userCollection = await client.stateManager.getCollection('user');
  const controlCollection = await client.stateManager.getCollection('control');

  const logger = await client.pluginManager.get('logger');
  const writer = await logger.createWriter('controller_User-Param-log', { bufferSize: 20 });
  const logger_active = true; //true; --- IGNORE ---

  const sync = await client.pluginManager.get('sync');
  const syncTime = sync.getSyncTime();
  const AUTOMATION_MIN_INTERVAL_MS = 3000;
  const AUTOMATION_MAX_INTERVAL_MS = 25000;
  let automationTimerId = null;
  

  const userStates = new Map();
  const userUpdateUnsubs = new Map();
  const controlStates = new Map();
  const userParameterKeys = [
    'id',
    //'volume',
    'state',
    //'penalty',
    'collide',
    'proximity',
    'periphery',
    'preset',
    //'style',
    'score',
    'endState',
    //'del',
    //'phase',
    //'phase_q',
    //'bp',
    //'bp_q',
    //'modulation',
  ];

  function collectUsersParameters() {
    return Array.from(userStates.values())
      .sort((a, b) => Number(a.get('id') ?? 0) - Number(b.get('id') ?? 0))
      .map((state) => {
        const params = {
          stateId: state.id,
        };
        userParameterKeys.forEach((key) => {
          params[key] = state.get(key);
        });
        return params;
      });
  }

  function writeUsersParameters(event, time) {
    if (!logger_active || !global.get('running')) {
      return;
    }
    writer.write({
      event,
      time,
      users: collectUsersParameters(),
    });
  }

  function getRandomAutomationInterval() {
    const range = AUTOMATION_MAX_INTERVAL_MS - AUTOMATION_MIN_INTERVAL_MS;
    return AUTOMATION_MIN_INTERVAL_MS + Math.round(Math.random() * range);
  }

  function shouldRunAlarmAutomation() {
    return Boolean(global.get('automation')) && Boolean(global.get('running'));
  }

  function stopAlarmAutomation() {
    if (automationTimerId !== null) {
      window.clearTimeout(automationTimerId);
      automationTimerId = null;
    }
  }

  function scheduleAlarmAutomation() {
    stopAlarmAutomation();

    if (!shouldRunAlarmAutomation()) {
      return;
    }

    automationTimerId = window.setTimeout(() => {
      automationTimerId = null;

      if (!shouldRunAlarmAutomation()) {
        return;
      }

      const isAlarmEnabled = Number(global.get('alarm') ?? 0) > 0;
      global.set({ alarm: isAlarmEnabled ? 0 : 1 });
      scheduleAlarmAutomation();
    }, getRandomAutomationInterval());
  }

  userCollection.onAttach((state) => {
    userStates.set(state.id, state);
    const localTime = sync.getLocalTime();
    const off = state.onUpdate((updates) => {
      if ('preset' in updates) {
        renderApp();
      }
    });

    if (typeof off === 'function') {
      userUpdateUnsubs.set(state.id, off);
    }
    writeUsersParameters('user-attach', localTime);
  }, true);

  userCollection.onDetach((state) => {
    userStates.delete(state.id);
    const localTime = sync.getLocalTime();
    const off = userUpdateUnsubs.get(state.id);
    if (typeof off === 'function') {
      off();
    }
    userUpdateUnsubs.delete(state.id);
    writeUsersParameters('user-detach', localTime);
  });

  controlCollection.onAttach((state) => {
    controlStates.set(state.id, state);
  }, true);

  controlCollection.onDetach((state) => {
    controlStates.delete(state.id);
  });

  function clamp01(value) {
    return Math.max(0, Math.min(100, value));
  }

  function clampToUnitCircle(nx, ny) {
    const length = Math.hypot(nx, ny);
    if (!Number.isFinite(length) || length <= 1 || length === 0) {
      return { x: nx, y: ny };
    }
    return { x: nx / length, y: ny / length };
  }

  function normalizeXYToCircle(xRaw, yRaw) {
    const x = clamp01(Number(xRaw));
    const y = clamp01(Number(yRaw));
    const nx = ((x / 100) * 2) - 1;
    const ny = ((y / 100) * 2) - 1;
    const clamped = clampToUnitCircle(nx, ny);
    return {
      x: ((clamped.x + 1) * 0.5) * 100,
      y: ((clamped.y + 1) * 0.5) * 100,
    };
  }

  function getCirclePadGeometry(width, height) {
    const radius = Math.max(8, Math.min(width, height) * 0.5 - 2);
    return {
      cx: width * 0.5,
      cy: height * 0.5,
      radius,
    };
  }

  function percentToPadPoint(xRaw, yRaw, geometry) {
    const normalized = normalizeXYToCircle(xRaw, yRaw);
    const nx = ((normalized.x / 100) * 2) - 1;
    const ny = ((normalized.y / 100) * 2) - 1;
    return {
      x: geometry.cx + (nx * geometry.radius),
      y: geometry.cy + (ny * geometry.radius),
    };
  }

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
    const geometry = getCirclePadGeometry(width, height);

    ctx.fillStyle = '#05050710';
    ctx.fillRect(0, 0, width, height);

    ctx.beginPath();
    ctx.arc(geometry.cx, geometry.cy, geometry.radius, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0b0d23';
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i += 1) {
      ctx.beginPath();
      ctx.arc(geometry.cx, geometry.cy, geometry.radius * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(geometry.cx - geometry.radius, geometry.cy);
    ctx.lineTo(geometry.cx + geometry.radius, geometry.cy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(geometry.cx, geometry.cy - geometry.radius);
    ctx.lineTo(geometry.cx, geometry.cy + geometry.radius);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.arc(geometry.cx, geometry.cy, geometry.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.arc(geometry.cx, geometry.cy, geometry.radius, 0, Math.PI * 2);
    ctx.clip();

    const controls = Array.from(controlStates.values()).sort((a, b) => {
      return (a.get('id') ?? 0) - (b.get('id') ?? 0);
    });
    const collisionDistance = Number(global.get('collision_distance') ?? 3);
    const proximityOffset = Number(global.get('proximity_offset') ?? 10);
    const safeCollisionDistance = Number.isFinite(collisionDistance) ? collisionDistance : 3;
    const safeProximityOffset = Number.isFinite(proximityOffset) ? proximityOffset : 10;
    const proximityDistance = Math.max(0, safeCollisionDistance + safeProximityOffset);
    const proximityRadiusPx = (proximityDistance / 50) * geometry.radius;

    controls.forEach((state) => {
      const id = state.get('id') ?? '?';
      const xValue = state.get('X') ?? 0;
      const yValue = state.get('Y') ?? 0;
      const isActive = (state.get('active') ?? 0) > 0;
      const point = percentToPadPoint(xValue, yValue, geometry);
      const radius = isActive ? 8 : 5;
      const haloOpacity = isActive ? 1 : 0.55;

      if (proximityRadiusPx > 0) {
        const proximityGradient = ctx.createRadialGradient(
          point.x,
          point.y,
          0,
          point.x,
          point.y,
          proximityRadiusPx,
        );
        proximityGradient.addColorStop(0, `rgba(225, 225, 225, ${0.12 * haloOpacity})`);
        proximityGradient.addColorStop(0.5, `rgba(190, 190, 190, ${0.09 * haloOpacity})`);
        proximityGradient.addColorStop(1, 'rgba(170, 170, 170, 0)');
        ctx.fillStyle = proximityGradient;
        ctx.beginPath();
        ctx.arc(point.x, point.y, proximityRadiusPx, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(205, 205, 205, ${0.24 * haloOpacity})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, proximityRadiusPx, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.fillStyle = isActive ? '#ffffff' : 'rgba(255, 255, 255, 0.45)';
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${id}`, point.x + 10, point.y - 8);
    });

    ctx.restore();
  }

  function renderApp() {
    const isRunning = global.get('running');
    const isAlarmEnabled = Number(global.get('alarm') ?? 1) > 0;
    const isTrainingEnabled = Boolean(global.get('training'));
    const isAutomationEnabled = Boolean(global.get('automation'));
    //const globalIsRunning = Boolean(global.get('running'));
    const collisionDistance = Number(global.get('collision_distance') ?? 1.5);
    const proximityOffset = Number(global.get('proximity_offset') ?? 10);
    const peripheryOffset = Number(global.get('periphery_offset') ?? 15);
    const safeCollisionDistance = Number.isFinite(collisionDistance) ? collisionDistance : 1.5;
    const safeProximityOffset = Number.isFinite(proximityOffset) ? proximityOffset : 10;
    const safePeripheryOffset = Number.isFinite(peripheryOffset) ? peripheryOffset : 15;
    const presetRangeMin = Number(global.get('preset_range_min') ?? 0);
    const presetRangeMax = Number(global.get('preset_range_max') ?? 5);
    const safePresetRangeMin = Number.isFinite(presetRangeMin) ? presetRangeMin : 0;
    const safePresetRangeMax = Number.isFinite(presetRangeMax) ? presetRangeMax : 5;
    const proximityDistance = safeCollisionDistance + safeProximityOffset;
    const peripheryDistance = proximityDistance + safePeripheryOffset;
    const resetValue = Number(global.get('reset') ?? 0);
    const fullscreenActive = isFullscreenActive();
    const users = Array.from(userStates.values()).sort((a, b) => {
      return (a.get('id') ?? 0) - (b.get('id') ?? 0);
    });
    const controlsByUserId = new Map();
    controlStates.forEach((state) => {
      const userId = Number(state.get('id'));
      if (Number.isFinite(userId)) {
        controlsByUserId.set(userId, state);
      }
    });
    const userParamDefs = [
      //{ key: 'del_range', label: 'Delay Range', min: 0, max: 180, step: 1, digits: 0, default: 90 },
      //{ key: 'del_offset', label: 'Delay Offset', min: 1, max: 180, step: 1, digits: 0, default: 86 },
      //{ key: 'phase_range', label: 'Phase Range', min: 0, max: 180, step: 1, digits: 0, default: 80 },
      //{ key: 'phase_offset', label: 'Phase Offset', min: 1, max: 240, step: 1, digits: 0, default: 160 },
      //{ key: 'bp_range', label: 'Bandpass Range', min: 0, max: 180, step: 1, digits: 0, default: 100 },
      //{ key: 'bp_offset', label: 'Bandpass Offset', min: 1, max: 240, step: 1, digits: 0, default: 150 },
      //{ key: 'harsh', label: 'Harsh', min: 0, max: 1, step: 1, digits: 1, default: 1 },
      //{ key: 'level', label: 'level', min: 1, max: 4, step: 1, digits: 1, default: 1 },
      //{ key: 'fb_gain', label: 'Gain', min: 0.001, max: 1.99, step: 0.001, digits: 3, default: 1.2 },
      //{ key: 'fb_trim', label: 'Trim', min: 0.01, max: 1, step: 0.01, digits: 2, default: 0.44 },
      { key: 'collide', label: 'Collide', type: 'boolean', default: false },
      { key: 'proximity', label: 'Proximity', type: 'boolean', default: false, readOnly: true },
      { key: 'periphery', label: 'Periphery', type: 'boolean', default: false, readOnly: true },
    ];

    const formatValue = (value, digits) => {
      if (!Number.isFinite(value)) return '--';
      return value.toFixed(digits);
    };

    render(html`
      <div id="app-root" class="cloud-app controller-cloud-app">
        <div class="cloud-layer cloud-layer-a"></div>
        <div class="cloud-layer cloud-layer-b"></div>
        <div class="cloud-layer cloud-layer-c"></div>
        <div class="controller-layout">
          <header>
            <h1>${client.config.app.name} | ${client.role}</h1>
            <sw-audit .client="${client}"></sw-audit>
          </header>
          <div class="controller-columns">
            <div class="controller-left">
              <section>
                <h2>Global Parameters</h2>
                <label class="toggle-row">
                  <span class="toggle-label">RUNNING</span>
                  <input
                    class="toggle-input"
                    type="checkbox"
                    .checked="${isRunning}"
                    @change="${(event) => {
                      global.set({ running: event.target.checked });
                    }}"
                  />
                  <span class="toggle-indicator"></span>
                </label>
                <label class="toggle-row">
                  <span class="toggle-label">ALARM</span>
                  <input
                    class="toggle-input"
                    type="checkbox"
                    .checked="${isAlarmEnabled}"
                    @change="${(event) => {
                      global.set({ alarm: event.target.checked ? 1 : 0 });
                    }}"
                  />
                  <span class="toggle-indicator"></span>
                </label>
                <label class="toggle-row">
                  <span class="toggle-label">AUTOMATION</span>
                  <input
                    class="toggle-input"
                    type="checkbox"
                    .checked="${isAutomationEnabled}"
                    @change="${(event) => {
                      global.set({ automation: event.target.checked });
                    }}"
                  />
                  <span class="toggle-indicator"></span>
                </label>
                <label class="toggle-row">
                  <span class="toggle-label">TRAINING</span>
                  <input
                    class="toggle-input"
                    type="checkbox"
                    .checked="${isTrainingEnabled}"
                    @change="${(event) => {
                      global.set({ training: event.target.checked });
                    }}"
                  />
                  <span class="toggle-indicator"></span>
                </label>
            
                <div class="param-row">
                  <span class="param-label">Collision Distance</span>
                  <input
                    class="param-input"
                    type="number"
                    min="1"
                    max="20"
                    step="0.1"
                    .value="${safeCollisionDistance}"
                    @input="${(event) => {
                      const value = parseFloat(event.target.value);
                      if (Number.isFinite(value)) {
                        global.set({ collision_distance: value });
                      }
                    }}"
                  />
                  <span class="param-value">${formatValue(safeCollisionDistance, 2)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Proximity Offset</span>
                  <input
                    class="param-input"
                    type="number"
                    min="5"
                    max="20"
                    step="0.1"
                    .value="${safeProximityOffset}"
                    @input="${(event) => {
                      const value = parseFloat(event.target.value);
                      if (Number.isFinite(value)) {
                        global.set({ proximity_offset: value });
                      }
                    }}"
                  />
                  <span class="param-value">${formatValue(safeProximityOffset, 2)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Proximity Distance</span>
                  <span></span>
                  <span class="param-value">${formatValue(proximityDistance, 2)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Periphery Offset</span>
                  <input
                    class="param-input"
                    type="number"
                    min="10"
                    max="25"
                    step="0.1"
                    .value="${safePeripheryOffset}"
                    @input="${(event) => {
                      const value = parseFloat(event.target.value);
                      if (Number.isFinite(value)) {
                        global.set({ periphery_offset: value });
                      }
                    }}"
                  />
                  <span class="param-value">${formatValue(safePeripheryOffset, 2)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Periphery Distance</span>
                  <span></span>
                  <span class="param-value">${formatValue(peripheryDistance, 2)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Preset Range Min</span>
                  <input
                    class="param-input"
                    type="number"
                    min="0"
                    max="10"
                    step="1"
                    .value="${safePresetRangeMin}"
                    @input="${(event) => {
                      const value = parseFloat(event.target.value);
                      if (Number.isFinite(value)) {
                        const nextMin = Math.floor(value);
                        const nextMax = safePresetRangeMax;
                        if (nextMin > nextMax) {
                          global.set({
                            preset_range_min: nextMin,
                            preset_range_max: nextMin,
                          });
                        } else {
                          global.set({ preset_range_min: nextMin });
                        }
                      }
                    }}"
                  />
                  <span class="param-value">${formatValue(safePresetRangeMin, 0)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Preset Range Max</span>
                  <input
                    class="param-input"
                    type="number"
                    min="0"
                    max="10"
                    step="1"
                    .value="${safePresetRangeMax}"
                    @input="${(event) => {
                      const value = parseFloat(event.target.value);
                      if (Number.isFinite(value)) {
                        const nextMax = Math.floor(value);
                        const nextMin = safePresetRangeMin;
                        if (nextMax < nextMin) {
                          global.set({
                            preset_range_min: nextMax,
                            preset_range_max: nextMax,
                          });
                        } else {
                          global.set({ preset_range_max: nextMax });
                        }
                      }
                    }}"
                  />
                  <span class="param-value">${formatValue(safePresetRangeMax, 0)}</span>
                </div>
                <div class="param-row">
                  <span class="param-label">Reset</span>
                  <button
                    class="bang-button"
                    type="button"
                    @click="${() => {
                      const current = Number(global.get('reset') ?? 0);
                      const next = Number.isFinite(current) ? current + 1 : 1;
                      global.set({ reset: next });
                    }}"
                  >
                    BANG
                  </button>
                  <span class="param-value">${formatValue(resetValue, 0)}</span>
                </div>
              </section>
            </div>
            <div class="controller-center">
              <section>
                <h2>Playground</h2>
                <div class="control-frame controller-pad-frame">
                  <canvas id="controller-pad" width="420" height="420"></canvas>
                </div>
              </section>
            </div>
            <div class="controller-right">
              <section>
                <h2>User Parameters</h2>
                ${users.length === 0 ? html`
                  <p class="empty-state">No users connected.</p>
                ` : html`
                  <div class="user-params">
                    ${users.map((state) => {
                      const userId = state.get('id');
                      const presetValue = Number(state.get('preset') ?? 0);
                      const pointsValue = Number(state.get('score') ?? 0);
                      //const lfoEnabled = (state.get('LFO') ?? 0) > 0.5;
                      const controlState = controlsByUserId.get(Number(userId));
                      //const levelValue = Number(controlState?.get('level') ?? 1);
                      return html`
                        <div class="user-params-card">
                          <div class="user-params-header">User ${userId}</div>
                          <div class="param-row">
                            <span class="param-label">Preset</span>
                            <span></span>
                            <span class="param-value">${formatValue(presetValue, 0)}</span>
                          </div>
                          <div class="param-row">
                            <span class="param-label">Points</span>
                            <span></span>
                            <span class="param-value">${formatValue(pointsValue, 2)}</span>
                          </div>
                        
                          ${userParamDefs.map((def) => {
                            if (def.type === 'boolean') {
                              const value = Boolean(state.get(def.key) ?? def.default);
                              return html`
                                <label class="toggle-row param-row">
                                  <span class="param-label">${def.label}</span>
                                  <input
                                    class="toggle-input"
                                    type="checkbox"
                                    .checked="${value}"
                                    ?disabled="${Boolean(def.readOnly)}"
                                    @change="${(e) => {
                                      if (def.readOnly) {
                                        return;
                                      }
                                      state.set({ [def.key]: e.target.checked });
                                    }}"
                                  />
                                  <span class="toggle-indicator"></span>
                                </label>
                              `;
                            } else {
                              const value = Number(state.get(def.key) ?? def.default);
                              return html`
                                <div class="param-row">
                                  <span class="param-label">${def.label}</span>
                                  <input
                                    class="param-input"
                                    type="range"
                                    min="${def.min}"
                                    max="${def.max}"
                                    step="${def.step}"
                                    .value="${value}"
                                    @input="${(event) => {
                                      state.set({ [def.key]: parseFloat(event.target.value) });
                                    }}"
                                  />
                                  <span class="param-value">${formatValue(value, def.digits)}</span>
                                </div>
                              `;
                            }
                          })}
                        </div>
                      `;
                    })}
                  </div>
                `}
              </section>
            </div>
          </div>
          <button
            class="fullscreen-button ${fullscreenActive ? 'is-active' : ''}"
            type="button"
            @click="${async () => {
              try {
                if (isFullscreenActive()) {
                  await tryExitFullscreen();
                } else {
                  await tryEnterFullscreen();
                }
              } catch (err) {
                // noop: tryEnterFullscreen already logs on failure
              }
            }}"
          >
            ${fullscreenActive ? 'Exit Fullscreen' : 'Fullscreen'}
          </button>
        </div>
      </div>
    `, $container);

    drawPad();
  }

  renderApp();
  global.onUpdate((updates) => {
    renderApp();
    if ('running' in updates) {
      if (updates.running) {
        writeUsersParameters('running-start', sync.getLocalTime());
      } else {
        writer.flush?.();
      }
    }
    if ('running' in updates || 'automation' in updates) {
      scheduleAlarmAutomation();
    }
  });
  scheduleAlarmAutomation();
  userCollection.onChange(() => {
    const localTime = sync.getLocalTime();
    renderApp();
    writeUsersParameters('user-change', localTime);
  });
  controlCollection.onChange(() => {
    renderApp();
    //writer.write({ controlStates: Array.from(controlStates.values()) });
  });
}

launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
  width: '100%',
});
