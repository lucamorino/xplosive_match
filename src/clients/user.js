export default {
    id: {
      type: 'float',
      default: 0,
      min: 0,
      max: 20,
    },
    volume: {
      type: 'float',
      default: 1,
      min: 0,
      max: 1,
    },
    state: {
      type: 'float',
      default: 0,
      min: 0,
      max: 1,
    },
    penalty: {
      type: 'float',
      default: 0,
      min: 0,
      max: 1,
    },  
    collide: {
      type: 'boolean',
      default: false,
    },
    proximity: {
      type: 'boolean',
      default: false,
    },
    preset: {
      type: 'float',
      default: 0,
      min: 0,
      max: 20,
    },
    style: {
      type: 'any',
      default: [],
    },
    score: {
      type: 'float',
      default: 0,
      min: 0,
      max: 10,
    },
    endState: {
      type: 'float',
      default: 0,
      min: -1,
      max: 1,
    },
    del: {
      type: 'float',
      default: 86,
      min: 1,
      max: 2000,
    },
    phase: {
      type: 'float',
      default: 160,
      min: 1,
      max: 2000,
    },
    phase_q: {
      type: 'float',
      default: 0.76,
      min: 0,
      max: 1,
    },
    bp: {
      type: 'float',
      default: 100,
      min: 1,
      max: 2000,
    },
    bp_q: {
      type: 'float',
      default: 0.83,
      min: 0,
      max: 1,
    },
    modulation: {
      type: 'float',
      default: 0,
      min: 0,
      max: 1,
    },
  };
