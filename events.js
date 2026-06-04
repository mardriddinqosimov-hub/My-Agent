import { EventEmitter } from 'events';

export const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// Circular buffer — new dashboard connections get the last 200 events
const BUFFER = [];
const MAX = 200;

export function log(type, message, data = {}) {
  const event = { type, message, data, ts: Date.now() };
  BUFFER.push(event);
  if (BUFFER.length > MAX) BUFFER.shift();
  emitter.emit('event', event);
}

export function getRecent() { return [...BUFFER]; }
