import type { CommunicationEvent } from '../types/communicationHistory';

function cloneEvent(event: CommunicationEvent): CommunicationEvent {
  return {
    ...event,
    contextRef: { ...event.contextRef },
  };
}

let events: CommunicationEvent[] = [];

export function getCommunicationHistoryStoreSnapshot(): CommunicationEvent[] {
  return events.map(cloneEvent);
}

export function hydrateCommunicationHistoryStore(items: CommunicationEvent[]): void {
  events = items.map(cloneEvent);
}

export function resetCommunicationHistoryStore(): void {
  events = [];
}

export function setCommunicationHistoryStoreForTests(items: CommunicationEvent[]): void {
  events = items.map(cloneEvent);
}

export function prependCommunicationEventToStore(event: CommunicationEvent): CommunicationEvent {
  events = [cloneEvent(event), ...events];
  return cloneEvent(event);
}

export function getCommunicationHistoryStoreEvents(): CommunicationEvent[] {
  return events.map(cloneEvent);
}
