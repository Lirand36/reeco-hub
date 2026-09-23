// In-process event bus; the SSE endpoint relays its events to every open browser tab.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
