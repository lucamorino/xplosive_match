import '@soundworks/helpers/polyfills.js';
import { Client } from '@soundworks/core/client.js';
import { loadConfig, launcher } from '@soundworks/helpers/browser.js';
import { html, render } from 'lit';
import '@ircam/sc-components';
import devicemotion from '@ircam/devicemotion';

import "../lib/guardrails.js";

import { Scheduler } from '@ircam/sc-scheduling'; 
import loadAudioBuffer from '../lib/load-audio-buffer.js';
import LoopSampler from '../lib/LoopSampler.js';

import pluginPlatformInit from '@soundworks/plugin-platform-init/client.js'; 
import pluginSync from '@soundworks/plugin-sync/client.js'; 
import pluginCheckin from '@soundworks/plugin-checkin/client.js'; 
import ClientPluginLogger from '@soundworks/plugin-logger/client.js';
import { use } from 'react';
//import { send } from 'process';
//import { start } from 'repl';
//import { send } from 'process';

//import FeedbackDelay from '../lib/FeedbackDelay.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

/**
 * Attempts to request full-screen mode for the document.
 * Logs a warning if the API is not supported or if the request fails.
 */


let oscilloscopeStarted = false;
let backgroundRAF = null;
let reactiveBackgroundEnabled = false;
let reactiveNoisePhase = 0;
let reactiveNoiseLevel = 0;
let playerDebug = false;
const debugLog = (...args) => {
  if (playerDebug) {
    console.log(...args);
  }
};
//let currentHarsh = 0;
//let currentPenalty = 0;

// Create the device
async function main($container) {
  
  const config = loadConfig();
  const client = new Client(config);
  const audioContext = new AudioContext();
  const debug = true;
  playerDebug = debug;
  audioContext.sampleRate = 48000; // ensure consistent sample rate across devices
  debugLog(audioContext.sampleRate);
 
  client.pluginManager.register('checkin', pluginCheckin);
  client.pluginManager.register('platform-init', pluginPlatformInit, { 
    audioContext, devicemotion
    /* onActivate: (plugin) => {
      // tryEnterFullscreen now returns a Promise
      return tryEnterFullscreen();
    } */
  }); 
  client.pluginManager.register('sync', pluginSync, {
    getTimeFunction: () => audioContext.currentTime, 
  }, ['platform-init']); 

  // cf. https://soundworks.dev/tools/helpers.html#browserlauncher
  launcher.register(client, { initScreensContainer: $container });

  await client.start();

  const platformInit = await client.pluginManager.get('platform-init');

  let motionDebugEl = null;
  let motionPadHandler = null;
  let padUi = null;
  let lastMotionUpdate = 0;
  let controlState = null;
  let lastControlCoords = { x: null, y: null };
  const motionUpdateInterval = 50;
  const motionFallbackDelayMs = 1500;
  let motionEventReceived = false;
  let pointerDragFallbackActive = false;
  let device = null;
  let user = null;
  let isTrainingMode = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clampCoord = (value) => clamp(Number(value), 0, 100);

  const mapAccelToControlCoords = (accX, accY) => {
    const maxG = 2.81; //8.33;//
    const safeAccX = Number.isFinite(accX) ? accX : 0;
    const safeAccY = Number.isFinite(accY) ? accY : 0;
    const normX = clamp(safeAccX / maxG, -1, 1);
    const normY = clamp(safeAccY / maxG, -1, 1);
    const x = Math.round(((normX + 1) * 0.5) * 100);
    const y = Math.round((1 - ((normY + 1) * 0.5)) * 100);
    return { x, y };
  };

  const mapAccelToDeviceCoords = (accX, accY) => {
    const maxG = 2.81; //8.33;//
    const safeAccX = Number.isFinite(accX) ? accX : 0;
    const safeAccY = Number.isFinite(accY) ? accY : 0;
    const normX = clamp(safeAccX / maxG, -1, 1);
    const normY = clamp(safeAccY / maxG, -1, 1);
    const x = Math.round(normX * 10);
    const y = Math.round(normY * 10);
    return { x, y };
  };

  const motionSmoothingWindowSize = 50;
  const motionXHistory = [];
  const motionYHistory = [];
  const motionZHistory = [];
  const motionLogWeights = Array.from(
    { length: motionSmoothingWindowSize },
    (_, index) => Math.log(index + 2),
  );

  const smoothMotionValueLogarithmically = (history, nextValue) => {
    history.push(nextValue);
    if (history.length > motionSmoothingWindowSize) {
      history.shift();
    }

    const weightOffset = motionSmoothingWindowSize - history.length;
    let weightedSum = 0;
    let weightsSum = 0;

    for (let i = 0; i < history.length; i += 1) {
      const weight = motionLogWeights[weightOffset + i];
      weightedSum += history[i] * weight;
      weightsSum += weight;
    }

    return weightsSum > 0 ? weightedSum / weightsSum : nextValue;
  };

  const formatMotionValue = (value) => (
    typeof value === 'number' ? value.toFixed(2) : '--'
  );

  const formatMotionEvent = (e) => {
    const acc = e.accelerationIncludingGravity || {};
    const rot = e.rotationRate || {};
    return [
      `interval: ${formatMotionValue(e.interval)} ms`,
      `accG: x ${formatMotionValue(acc.x)} y ${formatMotionValue(acc.y)} z ${formatMotionValue(acc.z)}`,
      `rot: a ${formatMotionValue(rot.alpha)} b ${formatMotionValue(rot.beta)} g ${formatMotionValue(rot.gamma)}`,
    ].join('\n');
  };

  const commitControlCoords = (coords) => {
    if (controlState?.set) {
      if (coords.x !== lastControlCoords.x || coords.y !== lastControlCoords.y) {
        controlState.set({
          X: coords.x,
          Y: coords.y,
          x: coords.x,
          y: coords.y,
        });
        lastControlCoords = coords;
      }
    }

    if (typeof motionPadHandler === 'function') {
      motionPadHandler(coords);
    }
  };

  const applyControlCoords = (coords) => {
    if (!coords) {
      return;
    }
    commitControlCoords({
      x: clampCoord(coords.x),
      y: clampCoord(coords.y),
    });
  };

  const mapPointerCoordsToAccelerometer = (coords) => {
    const xNorm = clampCoord(coords?.x) / 100;
    const yNorm = clampCoord(coords?.y) / 100;
    const x = (xNorm * 20) - 10;
    // Invert Y so top of screen maps to positive values.
    const y = ((1 - yNorm) * 20) - 10;
    return { x, y, z: 0 };
  };

  const setPointerDragFallback = (enabled, reason = null) => {
    const nextValue = Boolean(enabled);
    if (pointerDragFallbackActive === nextValue) {
      return;
    }

    pointerDragFallbackActive = nextValue;
    if (nextValue) {
      const details = reason ? ` (${reason})` : '';
      debugLog(`Device motion unavailable${details}, enabling pointer drag fallback`);
    } else {
      debugLog('Device motion detected, disabling pointer drag fallback');
    }
    padUi?.setPointerDragEnabled?.(nextValue);
  };

  const sendMotionEvent = (e) => {
    const acc = e.accelerationIncludingGravity || {};
    const rawX = typeof acc.x === 'number' ? acc.x : 0;
    const rawY = typeof acc.y === 'number' ? acc.y : 0;
    const rawZ = typeof acc.z === 'number' ? acc.z : 0;
    const x = smoothMotionValueLogarithmically(motionXHistory, rawX);
    const y = smoothMotionValueLogarithmically(motionYHistory, rawY);
    const z = smoothMotionValueLogarithmically(motionZHistory, rawZ);
    const coords = mapAccelToControlCoords(x, y);
    const deviceCoords = mapAccelToDeviceCoords(x, y);
    if (device) {
      sendMessageToInport(device, 'accelerometer', [deviceCoords.x, deviceCoords.y, z]);
    }
    applyControlCoords(coords);
  };

  const updateMotionDebug = (e) => {
    if (!debug) {
      return;
    }
    const now = performance.now();
    if (now - lastMotionUpdate < motionUpdateInterval) return;
    lastMotionUpdate = now;
    if (!motionDebugEl) {
      motionDebugEl = document.getElementById('devicemotion-debug');
    }
    if (motionDebugEl) {
      motionDebugEl.textContent = formatMotionEvent(e);
    }
  };

  const hasDeviceMotionApi = (
    typeof window.DeviceMotionEvent !== 'undefined'
    && devicemotion
    && typeof devicemotion.addEventListener === 'function'
  );

  const shouldUsePointerAccelerometer = () => (
    pointerDragFallbackActive
    && (!hasDeviceMotionApi || !motionEventReceived)
  );

  if (hasDeviceMotionApi) {
    devicemotion.addEventListener((e) => {
      motionEventReceived = true;
      if (pointerDragFallbackActive) {
        setPointerDragFallback(false);
      }
      updateMotionDebug(e);
      sendMotionEvent(e);
    });

    window.setTimeout(() => {
      if (!motionEventReceived) {
        setPointerDragFallback(true, 'no motion events received');
      }
    }, motionFallbackDelayMs);
  } else {
    setPointerDragFallback(true, 'DeviceMotionEvent API not available');
  }
  
  // Attempt to enter full-screen mode automatically after initial user gesture
  //tryEnterFullscreen();

  // retrieve initialized sync plugin 
  const sync = await client.pluginManager.get('sync'); 
  const scheduler = new Scheduler(() => sync.getSyncTime(), { 
    currentTimeToProcessorTimeFunction: syncTime => sync.getLocalTime(syncTime), 
  });

  const checkin = await client.pluginManager.get('checkin');
  const index = checkin.getIndex();
  //const instr = checkin.getData();
  const global = await client.stateManager.attach('global');
  isTrainingMode = Boolean(global.get('training'));
  const userCollection = await client.stateManager.getCollection('user');
  user = await client.stateManager.create('user');
  const control = await client.stateManager.create('control');
  controlState = control;
  const userStates = new Map();
  const userUpdateUnsubs = new Map();

  user.set({id: index});
  control.set({id: index});

  // Create gain node and connect it to audio output
  const outputNode = audioContext.createGain();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.68;
  const reactiveNoiseData = new Uint8Array(analyser.frequencyBinCount);
  outputNode.connect(analyser);
  analyser.connect(audioContext.destination);


  const patchExportURL = "assets/rnbo_export/patch.export.json";
  let response, patcher;
  try {
      response = await fetch(patchExportURL);
      patcher = await response.json();
  
      if (!window.RNBO) {
          // Load RNBO script dynamically
          await loadRNBOScript(patcher.desc.meta.rnboversion);
      }
  } catch (err) {
      // Your existing error handling logic here...
      console.error("Failed to load patcher or RNBO script:", err);
      return;
  }

  let presets = patcher.presets || [];
  if (presets.length < 1) {
      debugLog("No presets defined");
  }

  function getRandomPresetIndexFromGlobalRange() {
    const presetCount = Array.isArray(presets) ? presets.length : 0;
    if (presetCount <= 0) {
      return 0;
    }

    const configuredMin = Number(global.get('preset_range_min'));
    const configuredMax = Number(global.get('preset_range_max'));
    const defaultMin = 0;
    const defaultMax = presetCount > 1 ? Math.min(presetCount - 1, 5) : 0;

    let rangeMin = Number.isFinite(configuredMin) ? Math.floor(configuredMin) : defaultMin;
    let rangeMax = Number.isFinite(configuredMax) ? Math.floor(configuredMax) : defaultMax;

    const safeMaxPreset = presetCount - 1;
    rangeMin = clamp(rangeMin, 0, safeMaxPreset);
    rangeMax = clamp(rangeMax, 0, safeMaxPreset);

    if (rangeMax < rangeMin) {
      [rangeMin, rangeMax] = [rangeMax, rangeMin];
    }

    const rangeSize = rangeMax - rangeMin + 1;
    return rangeMin + Math.floor(Math.random() * rangeSize);
  }

  function triggerCollision() {
    if (!user || !device) {
      return;
    }

    const coupled = Boolean(user.get('collide'));
    if (!coupled) {
      return;
    }

    const randPreset = getRandomPresetIndexFromGlobalRange();
    user.set({ preset: randPreset });
    loadPresetAtIndex(device, presets, randPreset);

    if (global.get('alarm') > 0) {
      const opponentScore = getCollidingOpponentScore();
      sendMessageToInport(device, 'score', [opponentScore]);
      user.set({ state: 1 });
    } 
  }

  debugLog("Attempting to create RNBO device...");
  debugLog("audioContext:", audioContext);
  debugLog("patcher:", patcher);
  
  try {
      // RNBO is loaded into the window object, so we use RNBO.createDevice()
      // Also, the audio context variable is `audioContext`, not `context`
      device = await RNBO.createDevice({ context: audioContext, patcher });
  } catch (err) {
      // Your existing error handling logic here...
      console.error("Failed to create RNBO device:", err);
      return;
  }
  //console.log("device:", device)

  // Connect the device to the web audio graph
  device.node.connect(outputNode);

  const inports = getInports(device);
  debugLog("Inports:");
  debugLog(inports);

  loadPresetAtIndex(device, presets, 1);
  debugLog('Initial preset 1 loaded');
  sendMessageToInport(device, 'state', [0]);
  sendMessageToInport(device, 'score', [0]);
  sendMessageToInport(device, 'start', [1]); // ensure the patch starts in a known state
  control.set({ active: 1 });

  function stopReactiveBackgroundLoop() {
    if (backgroundRAF !== null) {
      cancelAnimationFrame(backgroundRAF);
      backgroundRAF = null;
    }
    reactiveNoisePhase = 0;
    reactiveNoiseLevel = 0;
  }

  function renderReactiveBackgroundFrame() {
    if (!reactiveBackgroundEnabled) {
      stopReactiveBackgroundLoop();
      return;
    }

    const root = document.getElementById('app-root');
    if (!root) {
      backgroundRAF = requestAnimationFrame(renderReactiveBackgroundFrame);
      return;
    }

    analyser.getByteFrequencyData(reactiveNoiseData);
    let sum = 0;
    for (let i = 0; i < reactiveNoiseData.length; i += 2) {
      sum += reactiveNoiseData[i];
    }

    const bins = Math.max(1, Math.ceil(reactiveNoiseData.length / 2));
    const rawLevel = sum / (bins * 255);
    reactiveNoiseLevel = (reactiveNoiseLevel * 0.82) + (rawLevel * 0.18);
    const intensity = Math.max(0, Math.min(1, reactiveNoiseLevel * 1.6));

    reactiveNoisePhase += 0.7 + (intensity * 9);
    const posX = (reactiveNoisePhase * 0.83) % 180;
    const posY = (reactiveNoisePhase * 1.31) % 220;

    root.style.setProperty('--noise-opacity', (0.2 + intensity * 0.55).toFixed(3));
    root.style.setProperty('--noise-scale', `${20 + intensity * 38}px`);
    root.style.setProperty('--noise-contrast', `${105 + intensity * 85}%`);
    root.style.setProperty('--noise-brightness', `${84 + intensity * 30}%`);
    root.style.setProperty('--noise-pos-x', `${posX.toFixed(1)}px`);
    root.style.setProperty('--noise-pos-y', `${posY.toFixed(1)}px`);

    backgroundRAF = requestAnimationFrame(renderReactiveBackgroundFrame);
  }

  function setReactiveBackground(enabled) {
    reactiveBackgroundEnabled = Boolean(enabled);
    const root = document.getElementById('app-root');
    if (!root) {
      return;
    }

    root.classList.toggle('is-reactive-bw', reactiveBackgroundEnabled);

    if (reactiveBackgroundEnabled) {
      if (backgroundRAF === null) {
        renderReactiveBackgroundFrame();
      }
    } else {
      stopReactiveBackgroundLoop();
      root.style.removeProperty('--noise-opacity');
      root.style.removeProperty('--noise-scale');
      root.style.removeProperty('--noise-contrast');
      root.style.removeProperty('--noise-brightness');
      root.style.removeProperty('--noise-pos-x');
      root.style.removeProperty('--noise-pos-y');
    }
  }

  /* function updateSharpnessDisplay(value) {
    const el = document.getElementById('sharpness-value');
    if (!el) return;
    const v = Number(value);
    el.textContent = Number.isFinite(v) ? v.toFixed(2) : '0.00';
  }

  function updateRoughnessDisplay(value) {
    const el = document.getElementById('roughness-value');
    if (!el) return;
    const v = Number(value);
    el.textContent = Number.isFinite(v) ? v.toFixed(2) : '0.00';
  }

  function updateEnergyDisplay(energyValue) {
    const el = document.getElementById('energy-counter-value');
    const fill = document.getElementById('energy-fill');
    const normalized = Math.max(0, Math.min(1, energyValue));
    if (el) el.textContent = normalized.toFixed(2);
    if (fill) fill.style.width = `${normalized * 100}%`;
  } */

  function updatePointsDisplay(pointsValue) {
    const el = document.getElementById('points-counter-value');
    //const fill = document.getElementById('points-fill');
    //const normalized = Math.max(0, Math.min(1, pointsValue));
    if (el) el.textContent = pointsValue.toFixed(2);
    //if (fill) fill.style.width = `${normalized * 100}%`;
  }

  function updateSharpnessDisplay(sharpnessValue) {
    const el = document.getElementById('sharpness-counter-value');
    if (!el) {
      return;
    }
    const safeValue = Number(sharpnessValue);
    el.textContent = Number.isFinite(safeValue) ? safeValue.toFixed(2) : '0.00';
  }

  function updateOtherPointsDisplay(pointsValue) {
    const el = document.getElementById('other-points-counter-value');
    if (!el) return;
    const safePoints = Number(pointsValue);
    el.textContent = Number.isFinite(safePoints) ? safePoints.toFixed(2) : '0.00';
  }

  function applyTrainingModeState() {
    const root = document.getElementById('app-root');
    if (root) {
      root.classList.toggle('is-training-mode', isTrainingMode);
    }
  }

  function refreshOtherPointsDisplay() {
    const myStateId = user?.id;
    const otherStates = Array.from(userStates.values())
      .filter((state) => state.id !== myStateId)
      .sort((a, b) => Number(a.get('id') ?? 0) - Number(b.get('id') ?? 0));

    const otherPoints = otherStates.length > 0
      ? Number(otherStates[0].get('score') ?? 0)
      : 0;
    updateOtherPointsDisplay(otherPoints);
  }

  function getCollidingOpponentScore() {
    if (!user) {
      return 0;
    }

    const myStateId = Number(user.get('id'));
    if (!Number.isFinite(myStateId)) {
      return 0;
    }

    const opponentStates = Array.from(userStates.values())
      .filter((state) => {
        const stateId = Number(state.get('id'));
        return Number.isFinite(stateId) && stateId !== myStateId;
      });

    const opponentState = opponentStates.find((state) => Boolean(state.get('collide'))) || opponentStates[0];

    if (!opponentState) {
      return 0;
    }

    const opponentScoreRaw = Number(opponentState.get('score'));
    return Number.isFinite(opponentScoreRaw) ? opponentScoreRaw : 0;
  }

  function getEndgameOverlayText() {
    const endState = Number(user.get('endState') ?? 0);
    if (endState > 0) {
      return 'YOU WIN';
    }
    if (endState < 0) {
      return 'you loose';
    }
    return 'game over';
  }

  function showEndgameOverlay(visible) {
    const overlay = document.getElementById('gameover-overlay');
    const text = document.getElementById('gameover-text');
    if (!overlay || !text) {
      return;
    }

    if (!visible) {
      overlay.style.display = 'none';
      return;
    }

    text.textContent = getEndgameOverlayText();
    overlay.style.display = 'flex';
    sendMessageToInport(device, 'start', [0]); // ensure the patch is stopped when game over screen is shown
  }

  function updateAlarmWarningDisplay(alarmValue) {
    const warningEl = document.getElementById('alarm-warning');
    if (!warningEl) {
      return;
    }
    warningEl.classList.toggle('is-visible', Number(alarmValue) > 0);
  }

  userCollection.onAttach((state) => {
    userStates.set(state.id, state);

    const off = state.onUpdate((updates) => {
      if ('score' in updates || 'id' in updates) {
        refreshOtherPointsDisplay();
      }
    });

    if (typeof off === 'function') {
      userUpdateUnsubs.set(state.id, off);
    }

    refreshOtherPointsDisplay();
  }, true);

  userCollection.onDetach((state) => {
    userStates.delete(state.id);
    const off = userUpdateUnsubs.get(state.id);
    if (typeof off === 'function') {
      off();
    }
    userUpdateUnsubs.delete(state.id);
    refreshOtherPointsDisplay();
  });

  // Listen for messages from RNBO device
  device.messageEvent.subscribe((ev) => {
    if (ev.tag === "out2") {
      const sharpness = ev.payload;
      const sharpnessValue = Number(sharpness);
      if (isTrainingMode && Number.isFinite(sharpnessValue)) {
        updateSharpnessDisplay(sharpnessValue);
      }
    }
    /* if (ev.tag === "out3") {
      const roughness = ev.payload;
      updateRoughnessDisplay(roughness);
    }
    if (ev.tag === "out4") {
      const energy = ev.payload;
      //updateEnergyDisplay(energy);
    } */
    if (ev.tag === "out3") {
      if (isTrainingMode) {
        return;
      }

      const points = ev.payload;
      const safePoints = Number(points);
      if (!Number.isFinite(safePoints)) {
        return;
      }
      updatePointsDisplay(points);
      user.set({ score: points });
      if (safePoints >= 10) {
        global.set({ running: false });  
      }
    } 
    /* if (ev.tag === "out6") {
      const energy = ev.payload;
      updateEnergyDisplay(energy);
      //console.log(`Received message ${ev.tag}: ${ev.payload}`);
      //user.set({energy: energy});// store in user state
    } */
  });

  global.onUpdate(updates => {
    if ('running' in updates) {
      const isRunning = updates['running'];

      document.body.classList.toggle('is-game-running', Boolean(isRunning));
      debugLog('Running state updated:', isRunning);
      sendMessageToInport(device, 'start', isRunning ? [1] : [0]);
      showEndgameOverlay(!isRunning);
    }
    /* if ('penalty' in updates) {
      const penalty = updates['penalty'];
      const harshness = user.get('harsh');
      // start/stop penalty countdown
      if (penalty > 0 && harshness == 0) {
        sendMessageToInport(device, 'penalty', penalty);
        startPenaltyCounter();
      } else {
        sendMessageToInport(device, 'penalty', 0);
        stopPenaltyCounter(false);
      }
      applyBackgroundMode(harshness, penalty);
    } */
    if ('alarm' in updates) {
      const alarm = updates['alarm'];
      debugLog('Alarm level updated:', alarm);
      updateAlarmWarningDisplay(alarm);
      sendMessageToInport(device, 'alarm', [alarm]);
    }

    if ('training' in updates) {
      const nextTrainingMode = Boolean(updates['training']);
      const previousTrainingMode = isTrainingMode;
      isTrainingMode = nextTrainingMode;
      if (isTrainingMode && !previousTrainingMode) {
        updateSharpnessDisplay(0);
      }
      applyTrainingModeState();
    }

    if ('reset' in updates) {
      padUi?.applyReset?.();
      if (isTrainingMode) {
        updateSharpnessDisplay(0);
      }
      debugLog('Reset received, player coordinates rotated');
    }
  }); 

  user.onUpdate(updates => {
    if ('endState' in updates && !global.get('running')) {
      showEndgameOverlay(true);
    }
    /* if ('state' in updates) {
      const state = Number(updates['state']);
      sendMessageToInport(device, 'state', state);
    } */
    if ('state' in updates) {
      const state = Number(updates['state']);
      const isActive = state > 0;
      sendMessageToInport(device, 'state', [isActive ? 1 : 0]);
      setReactiveBackground(isActive);
    }
    /* if ('score' in updates) {
      const score = Number(updates['score']);
      const safeScore = Number.isFinite(score) ? score : 0;
      updatePointsDisplay(safeScore);
      sendMessageToInport(device, 'score', [safeScore]);
    } */
    if ('collide' in updates) {
      const collide = Boolean(updates['collide']);
      padUi?.setCoupled?.(collide);
      debugLog('Collide state updated:', collide);
      //sendMessageToInport(device, 'collision', [collide ? 1 : 0]);
      if (collide) {
        triggerCollision();
      } else if (Number(user.get('state')) !== 0) {
        user.set({ state: 0 });
      }
    }
    if ('proximity' in updates && global.get('running')) {
      const proximity = Boolean(updates['proximity']);
      debugLog('Proximity state updated:', proximity);
      sendMessageToInport(device, 'proximity', [proximity ? 1 : 0]);
    }
    if ('periphery' in updates && global.get('running')) {
      const periphery = Boolean(updates['periphery']);
      debugLog('Periphery state updated:', periphery);
      sendMessageToInport(device, 'periphery', [periphery ? 1 : 0]);
    }
     if ('preset' in updates) {
      const newPreset = updates['preset'];
      debugLog('Preset updated:', newPreset);
      //loadPresetAtIndex(device, presets, newPreset);
    }
  });


  // -------------------------------------------------------------------
  // RENDER FUNCTION AND GRID SETUP
  // -------------------------------------------------------------------
  function renderApp() {
    render(html`
      <div id="app-root" class="cloud-app ${Boolean(global.get('training')) ? 'is-training-mode' : ''}">
        <div id="gameover-overlay" role="status" aria-live="polite">
          <div id="gameover-text">game over</div>
        </div>
        <div class="player-points-hud">
          <span class="player-points-label">My S-Points:</span>
          <span id="points-counter-value" min="0.00" max="10.00" step="0.01">0.00</span>
        </div>
        <div class="player-points-hud player-points-hud-other">
          <span class="player-points-label">Other S-Points:</span>
          <span id="other-points-counter-value" min="0.00" max="10.00" step="0.01">0.00</span>
        </div>
        <div class="player-points-hud player-points-hud-sharpness">
          <span class="player-points-label">Sharpness:</span>
          <span id="sharpness-counter-value" min="0.00" max="10.00" step="0.01">0.00</span>
        </div>
        <img id="alarm-warning" class="alarm-warning" src="/images/warning.png" alt="Alarm warning" />
        <div class="cloud-layer cloud-layer-a"></div>
        <div class="cloud-layer cloud-layer-b"></div>
        <div class="cloud-layer cloud-layer-c"></div>
        <div class="noise-reactive-layer" aria-hidden="true"></div>
        <div id="motion-scene">
          <div id="motion-dot" aria-hidden="true"></div>
        </div>
        ${debug ? html`
          <pre id="devicemotion-debug" class="debug-box motion-debug-view">Waiting for motion...</pre>
        ` : null}
      </div>
    `, $container);
  }

  renderApp();
  const initialReactiveState = Number(user.get('state')) > 0;
  setReactiveBackground(initialReactiveState);
  refreshOtherPointsDisplay();
  updateAlarmWarningDisplay(global.get('alarm'));
  motionDebugEl = debug ? document.getElementById('devicemotion-debug') : null;
  padUi = setupUI(control, (handler) => {
    motionPadHandler = handler;
  }, {
    initialCoupled: Boolean(user.get('collide')),
    enablePointerDrag: pointerDragFallbackActive,
    onManualMove: (coords) => {
      applyControlCoords(coords);
      if (device && shouldUsePointerAccelerometer()) {
        const pointerAccel = mapPointerCoordsToAccelerometer(coords);
        sendMessageToInport(device, 'accelerometer', [pointerAccel.x, pointerAccel.y, pointerAccel.z]);
      }
    },
  });
  applyTrainingModeState();
  //startOscilloscope(analyser);
  }

// load RNBO script dynamically
function loadRNBOScript(version) {
  return new Promise((resolve, reject) => {
    if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
      throw new Error("Patcher exported with a Debug Version! Please specify the correct RNBO version to use in the code.");
    }

    // Try same-origin local copy first to avoid COEP/CORS issues.
    const localSrc = `assets/rnbo/${encodeURIComponent(version)}/rnbo.min.js`;
    const cdnSrc = `https://c74-public.nyc3.digitaloceanspaces.com/rnbo/${encodeURIComponent(version)}/rnbo.min.js`;

    function appendScript(src, useCrossOrigin) {
      const el = document.createElement('script');
      if (useCrossOrigin) {
        // when requesting cross-origin script, set crossorigin so proper CORS flow
        // can occur if the CDN returns Access-Control-Allow-Origin.
        el.crossOrigin = 'anonymous';
      }
      el.src = src;
      el.onload = () => resolve();
      el.onerror = (err) => {
        // If the local copy failed, try the CDN as a fallback. If CDN fails too, reject.
        if (src === localSrc) {
          console.warn(`Local RNBO not found at ${localSrc}, falling back to CDN`);
          // try CDN (may still be blocked by COEP if the CDN doesn't provide proper headers)
          appendScript(cdnSrc, true);
        } else {
          console.error(err);
          reject(new Error("Failed to load rnbo.js v" + version));
        }
      };
      document.body.append(el);
    }

    appendScript(localSrc, false);
  });
}
// helper functions
function getInports(device) {
  const messages = device.messages;
  const inports = messages.filter(
    (message) => message.type === RNBO.MessagePortType.Inport
  );
  return inports;
}
function getParameters(device) {
  const parameters = device.parameters;
  return parameters;
}
function getParameter(device, parameterName) {
  const parameters = device.parameters;
  const parameter = parameters.find((param) => param.name === parameterName);
  return parameter;
}
function loadPresetAtIndex(device, presets, index) {
    const presetIndex = Math.floor(Number(index));
    if (!Number.isFinite(presetIndex) || presetIndex < 0 || presetIndex >= presets.length) {
      console.warn('Ignoring invalid preset index:', index);
      return;
    }

    const preset = presets[presetIndex];
    if (!preset) {
      console.warn('Preset not found at index:', presetIndex);
      return;
    }

    debugLog(`Loading preset ${preset.name}`);
    device.setPreset(preset.preset);
}
function sendMessageToInport(device, inportTag, values) {
  //Turn the text into a list of numbers (RNBO messages must be numbers, not text)
  //const messsageValues = values.split(/\s+/).map((s) => parseFloat(s));

  // Send the message event to the RNBO device
  let messageEvent = new RNBO.MessageEvent(
    RNBO.TimeNow,
    inportTag,
    values
  );
  device.scheduleEvent(messageEvent);
}

function startOscilloscope(analyser) {
  if (!analyser || oscilloscopeStarted) return;
  const canvas = document.getElementById('oscilloscope');
  if (!canvas) {
    // retry once the UI is rendered
    requestAnimationFrame(() => startOscilloscope(analyser));
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  oscilloscopeStarted = true;

  // ensure consistent pixel size in case CSS resizes the canvas
  const width = canvas.width;
  const height = canvas.height;
  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    analyser.getByteTimeDomainData(dataArray);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, width, height);

    // midline for reference
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#f4f4f4';
    ctx.beginPath();

    const sliceWidth = width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0; // 128 is midline
      const y = (v * height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.stroke();
    requestAnimationFrame(draw);
  };

  draw();
}

function setupUI(control, registerMotionHandler, options = {}) {
  const {
    initialCoupled = false,
    enablePointerDrag = false,
    onManualMove = null,
  } = options;
  const scene = document.getElementById('motion-scene');
  const dot = document.getElementById('motion-dot');
  let motionPoint = {
    x: Number(control?.get?.('X') ?? control?.get?.('x') ?? 50),
    y: Number(control?.get?.('Y') ?? control?.get?.('y') ?? 50),
  };
  let isCoupled = Boolean(initialCoupled);
  let isPointerDragEnabled = Boolean(enablePointerDrag);
  let dragPointerId = null;
  const pointerDragLerp = 0.35;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clamp01 = (value) => clamp(value, 0, 100);

  function updateMotionDotPosition(xRaw, yRaw) {
    motionPoint = {
      x: clamp01(Number(xRaw)),
      y: clamp01(Number(yRaw)),
    };

    if (dot) {
      dot.style.left = `${motionPoint.x}%`;
      dot.style.top = `${motionPoint.y}%`;
    }
  }

  function getCoordsFromPointerEvent(event) {
    const target = scene || dot;
    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }

    return {
      x: clamp01(((event.clientX - rect.left) / rect.width) * 100),
      y: clamp01(((event.clientY - rect.top) / rect.height) * 100),
    };
  }

  function applyPointerCoords(event) {
    const coords = getCoordsFromPointerEvent(event);
    if (!coords) {
      return;
    }

    const smoothedCoords = {
      x: motionPoint.x + ((coords.x - motionPoint.x) * pointerDragLerp),
      y: motionPoint.y + ((coords.y - motionPoint.y) * pointerDragLerp),
    };

    updateMotionDotPosition(smoothedCoords.x, smoothedCoords.y);
    if (typeof onManualMove === 'function') {
      onManualMove(smoothedCoords);
    }
  }

  function setPointerDragEnabled(nextValue) {
    isPointerDragEnabled = Boolean(nextValue);
    if (scene) {
      scene.classList.toggle('is-pointer-drag-enabled', isPointerDragEnabled);
    }
  }

  function setCoupled(nextValue) {
    isCoupled = Boolean(nextValue);
    if (!dot) {
      return;
    }

    dot.classList.toggle('is-collision-active', isCoupled);
  }

  if (scene) {
    scene.addEventListener('pointerdown', (event) => {
      if (!isPointerDragEnabled) {
        return;
      }

      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }

      dragPointerId = event.pointerId;
      applyPointerCoords(event);
      if (scene.setPointerCapture) {
        try {
          scene.setPointerCapture(event.pointerId);
        } catch (err) {
          // no-op
        }
      }
    });

    scene.addEventListener('pointermove', (event) => {
      if (!isPointerDragEnabled || dragPointerId !== event.pointerId) {
        return;
      }

      applyPointerCoords(event);
    });

    const stopPointerDrag = (event) => {
      if (dragPointerId === event.pointerId) {
        dragPointerId = null;
      }
    };

    scene.addEventListener('pointerup', stopPointerDrag);
    scene.addEventListener('pointercancel', stopPointerDrag);
    scene.addEventListener('pointerleave', stopPointerDrag);
  }

  if (typeof registerMotionHandler === 'function') {
    registerMotionHandler((coords) => {
      if (!coords) return;
      updateMotionDotPosition(coords.x, coords.y);
    });
  }

  updateMotionDotPosition(motionPoint.x, motionPoint.y);
  setPointerDragEnabled(isPointerDragEnabled);
  setCoupled(isCoupled);

  return {
    applyReset: () => ({ ...motionPoint }),
    setCoupled,
    setPointerDragEnabled,
  };
}

// The launcher allows to launch multiple clients in the same browser window
// e.g. `http://127.0.0.1:8000?emulate=10` to run 10 clients side-by-side
launcher.execute(main, {
  numClients: parseInt(new URLSearchParams(window.location.search).get('emulate') || '') || 1,
});
   
