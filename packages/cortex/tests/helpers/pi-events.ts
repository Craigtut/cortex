import type { PiEvent } from '../../src/event-bridge.js';

/**
 * A pi agent event written partially, with only the fields a test reads.
 * Scripted agents take these and hand them on as pi's event type.
 */
export type LoosePiEvent = { type: PiEvent['type']; [key: string]: unknown };
