// src/server/schemas/global.js
export default {
  running: {
    type: 'boolean',
    default: false,
  },
  syncTriggerTime: {
    type: 'float',
    default: 0,
  },
  /* goal: {
    type: 'any',
    default: [30, 30, 100],
  },
  movingGoal: {
    type: 'boolean',
    default: false,
  },
  penalty: {
    type: 'float',
    default: 0,
    min: 0,
    max: 20,
  },
  hrsh_threshold: {
    type: 'float',
    default: 0.45,
    min: 0.1,
    max: 0.99,
  }, */
  collision_distance: {
    type: 'float',
    default: 5,
    min: 1,
    max: 20,
  },
  proximity_offset: {
    type: 'float',
    default: 10,
    min: 5,
    max: 20,
  },
  collision_drift_strength: {
    type: 'float',
    default: 1.8,
    min: 0,
    max: 5,
  },
  reset: {
    type: 'float',
    default: 0,
  },
};
