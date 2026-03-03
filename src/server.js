import '@soundworks/helpers/polyfills.js';
import '@soundworks/helpers/catch-unhandled-errors.js';
import { Server } from '@soundworks/core/server.js';
import { loadConfig, configureHttpRouter } from '@soundworks/helpers/server.js';
//import { WebSocketServer } from 'ws';
// 1. Import the `configureMaxClient` function from the @soundworks/max package
//import { configureMaxClient } from '@soundworks/max';
//import { loadConfig } from '../utils/load-config.js';

import pluginPlatformInit from '@soundworks/plugin-platform-init/server.js'; 
import pluginSync from '@soundworks/plugin-sync/server.js'; 
import pluginCheckin from '@soundworks/plugin-checkin/server.js'; 

import globalSchema from './global/global.js'; 
import userSchema from './clients/user.js';
import controlSchema from './clients/control.js';

// - General documentation: https://soundworks.dev/
// - API documentation:     https://soundworks.dev/api
// - Issue Tracker:         https://github.com/collective-soundworks/soundworks/issues
// - Wizard & Tools:        `npx soundworks`

const config = loadConfig(process.env.ENV, import.meta.url);
//configureMaxClient(config);

console.log(`
--------------------------------------------------------
- launching "${config.app.name}" in "${process.env.ENV || 'default'}" environment
- [pid: ${process.pid}]
--------------------------------------------------------
`);

const server = new Server(config);
configureHttpRouter(server);

// Try to attach Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy
// headers to the HTTP pipeline so the app can be cross-origin isolated.
// We attempt several common properties on the `server` object to be
// resilient to different versions of the soundworks helper.
try {
  const coopHeader = 'Cross-Origin-Opener-Policy';
  const coepHeader = 'Cross-Origin-Embedder-Policy';
  const coopValue = 'same-origin';
  const coepValue = 'require-corp';

  const attachHeadersToExpressApp = (app) => {
    try {
      app.use((req, res, next) => {
        res.setHeader(coopHeader, coopValue);
        res.setHeader(coepHeader, coepValue);
        next();
      });
      console.log('[server] COOP/COEP headers attached to express app');
      return true;
    } catch {
      return false;
    }
  };

  let done = false;

  // common places where helpers might expose the express app
  if (!done && server.httpApp && typeof server.httpApp.use === 'function') {
    done = attachHeadersToExpressApp(server.httpApp);
  }
  if (!done && server.app && typeof server.app.use === 'function') {
    done = attachHeadersToExpressApp(server.app);
  }
  if (!done && server._httpApp && typeof server._httpApp.use === 'function') {
    done = attachHeadersToExpressApp(server._httpApp);
  }

  // Fallback: if an http server instance is available, attach a request
  // listener that sets the headers early on each response.
  if (!done && server.httpServer && server.httpServer.on) {
    server.httpServer.on('request', (req, res) => {
      try {
        res.setHeader(coopHeader, coopValue);
        res.setHeader(coepHeader, coepValue);
      } catch { /* ignore */ }
    });
    done = true;
    console.log('[server] COOP/COEP headers attached to httpServer request event');
  }

  if (!done) {
    console.warn('[server] Could not automatically attach COOP/COEP headers. You may need to add middleware to your HTTP server to set these headers.');
  }
} catch (err) {
  console.warn('[server] Error while trying to attach COOP/COEP headers:', err);
}


// Register plugins and create shared state classes
server.pluginManager.register('platform-init', pluginPlatformInit); 
server.pluginManager.register('sync', pluginSync); 
server.pluginManager.register('checkin', pluginCheckin, {
  capacity: 20,
  data: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'o', 'p', 'q', 'r', 's', 't', 'u'],
}); 

server.stateManager.defineClass('global', globalSchema);
server.stateManager.defineClass('user', userSchema); 
server.stateManager.defineClass('control', controlSchema); 

await server.start();

const global = await server.stateManager.create('global');
//const user = await server.stateManager.create('user'); 

const userCollection = await server.stateManager.getCollection('user');
const userStates = new Map();
const controlCollection = await server.stateManager.getCollection('control');
const controlStates = new Map();

const ACTIVE_THRESHOLD = 0.5;
const HARSH_THRESHOLD = 0.5;
const WINNING_SCORE = 10;

function getPosition(state) {
  const x = Number(state.get('X') ?? state.get('x'));
  const y = Number(state.get('Y') ?? state.get('y'));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

/* function getNormalizedHarsh(state) {
  const raw = state.get('harsh');
  const value = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
  return Number.isFinite(value) && value > HARSH_THRESHOLD ? 1 : 0;
}

function evaluatePenalties() {
  const states = Array.from(userStates.values());
  if (states.length === 0) {
    return;
  }

  const harshStates = new Map();
  let totalHarshPlayers = 0;

  states.forEach((state) => {
    const harsh = getNormalizedHarsh(state);
    harshStates.set(state, harsh);
    totalHarshPlayers += harsh;
  });

  states.forEach((state) => {
    const ownHarsh = harshStates.get(state) ?? 0;
    const nextPenalty = ownHarsh > 0 ? 0 : totalHarshPlayers;
    const currentPenalty = Number(state.get('penalty') ?? 0);
    if (nextPenalty !== currentPenalty) {
      state.set({ penalty: nextPenalty });
    }
  });
} */

function evaluateCollisions() {
  const collisionDistance = Number(global.get('collision_distance') ?? 3);
  const safeCollisionDistance = Number.isFinite(collisionDistance) ? collisionDistance : 3;
  const proximityOffset = Number(global.get('proximity_offset') ?? 10);
  const safeProximityOffset = Number.isFinite(proximityOffset) ? proximityOffset : 10;
  const proximityDistance = Math.max(0, safeCollisionDistance + safeProximityOffset);
  const peripheryOffset = Number(global.get('periphery_offset') ?? 15);
  const safePeripheryOffset = Number.isFinite(peripheryOffset) ? peripheryOffset : 15;
  const peripheryDistance = Math.max(0, proximityDistance + safePeripheryOffset);
  const collisionDistanceSq = safeCollisionDistance * safeCollisionDistance;
  const proximityDistanceSq = proximityDistance * proximityDistance;
  const peripheryDistanceSq = peripheryDistance * peripheryDistance;
  const states = Array
    .from(controlStates.values())
    .filter((state) => Number(state.get('active') ?? 0) > ACTIVE_THRESHOLD);

  const collidingUserIds = new Set();
  const proximateUserIds = new Set();
  const peripheralUserIds = new Set();
  const usersByExternalId = new Map();
  userStates.forEach((userState) => {
    const externalId = Number(userState.get('id'));
    if (Number.isFinite(externalId)) {
      usersByExternalId.set(externalId, userState);
    }
  });

  for (let i = 0; i < states.length; i += 1) {
    const stateA = states[i];
    const posA = getPosition(stateA);
    const userIdA = Number(stateA.get('id'));
    if (!posA) {
      continue;
    }
    if (!Number.isFinite(userIdA)) {
      continue;
    }

    for (let j = i + 1; j < states.length; j += 1) {
      const stateB = states[j];
      const posB = getPosition(stateB);
      const userIdB = Number(stateB.get('id'));
      if (!posB) {
        continue;
      }
      if (!Number.isFinite(userIdB) || userIdA === userIdB) {
        continue;
      }

      const dx = posA.x - posB.x;
      const dy = posA.y - posB.y;
      const distanceSquared = dx * dx + dy * dy;

      if (distanceSquared < peripheryDistanceSq) {
        peripheralUserIds.add(userIdA);
        peripheralUserIds.add(userIdB);
      }

      if (distanceSquared < proximityDistanceSq) {
        proximateUserIds.add(userIdA);
        proximateUserIds.add(userIdB);
      }

      if (distanceSquared < collisionDistanceSq) {
        collidingUserIds.add(userIdA);
        collidingUserIds.add(userIdB);
      }
    }
  }

  usersByExternalId.forEach((userState, userId) => {
    const nextCouple = collidingUserIds.has(userId);
    const currentCouple = userState.get('collide');
    if (nextCouple !== currentCouple) {
      userState.set({ collide: nextCouple });
    }

    const nextProximity = proximateUserIds.has(userId);
    const currentProximity = userState.get('proximity');
    if (nextProximity !== currentProximity) {
      userState.set({ proximity: nextProximity });
    }

    const nextPeriphery = peripheralUserIds.has(userId);
    const currentPeriphery = userState.get('periphery');
    if (nextPeriphery !== currentPeriphery) {
      userState.set({ periphery: nextPeriphery });
    }
  });
}

function hasReachedWinningScore(value) {
  const score = Number(value);
  return Number.isFinite(score) && score >= WINNING_SCORE;
}

function evaluateEndStates() {
  const running = Boolean(global.get('running'));
  const states = Array.from(userStates.values());

  if (states.length === 0) {
    return;
  }

  if (running) {
    states.forEach((state) => {
      const currentEndState = Number(state.get('endState') ?? 0);
      if (currentEndState !== 0) {
        state.set({ endState: 0 });
      }
    });
    return;
  }

  const winnerIds = new Set();
  states.forEach((state) => {
    if (!hasReachedWinningScore(state.get('score'))) {
      return;
    }

    const externalId = Number(state.get('id'));
    if (Number.isFinite(externalId)) {
      winnerIds.add(externalId);
    }
  });

  const hasWinner = winnerIds.size > 0;
  states.forEach((state) => {
    const externalId = Number(state.get('id'));
    let nextEndState = 0;

    if (hasWinner) {
      nextEndState = winnerIds.has(externalId) ? 1 : -1;
    }

    const currentEndState = Number(state.get('endState') ?? 0);
    if (currentEndState !== nextEndState) {
      state.set({ endState: nextEndState });
    }
  });
}

controlCollection.onAttach((state) => {
  controlStates.set(state.id, state);
  evaluateCollisions();
}, true);

controlCollection.onDetach((state) => {
  controlStates.delete(state.id);
  evaluateCollisions();
});

controlCollection.onChange(() => {
  evaluateCollisions();
});

userCollection.onAttach((state) => {
  userStates.set(state.id, state);
  //evaluatePenalties();
  evaluateCollisions();
  evaluateEndStates();
}, true);

userCollection.onDetach((state) => {
  userStates.delete(state.id);
  //evaluatePenalties();
  evaluateCollisions();
  evaluateEndStates();
});

userCollection.onChange(() => {
  //evaluatePenalties();
  evaluateEndStates();
});

const sync = await server.pluginManager.get('sync');
const syncTime = sync.getSyncTime();

global.onUpdate(updates => {
  if ('running' in updates) {
    const running = global.get('running');
    const triggerTime = syncTime + sync.getLocalTime();
    console.log(triggerTime);
    
    if (running) {
      global.set({ syncTriggerTime: triggerTime });
      console.log(`Running state ON at syncTime ${triggerTime}`);
    }

    evaluateEndStates();
  }
  if ('collision_distance' in updates) {
    evaluateCollisions();
  }
  if ('proximity_offset' in updates) {
    evaluateCollisions();
  }
  if ('periphery_offset' in updates) {
    evaluateCollisions();
  }
}, true);
