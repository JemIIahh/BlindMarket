import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

// Same trailing-slash guard as API_BASE_URL (config/constants.ts).
const SOCKET_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    // WebSocket first (polling kept as fallback), and back off to 30s between
    // retries instead of socket.io's 5s ceiling. While the API is down or
    // restarting, the defaults re-handshake over HTTP polling every couple of
    // seconds — dozens of requests a minute per tab, which the platform in
    // front of the API rate-limits (429). Those 429s carry no CORS headers, so
    // the browser reports them as CORS failures and the whole app looks broken.
    // tryAllTransports is REQUIRED with a websocket-first list: without it,
    // engine.io-client gives up when the first transport fails to open and
    // retries websocket forever, so a network that blocks WebSockets would
    // never connect (engine.io-client 6.6.x, socket.js _onError).
    socket = io(SOCKET_URL, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
  }
  return socket;
}

/**
 * Join a room and listen for events.
 * @param room   Room name to join (e.g. 'platform', 'tasks', 'disputes', 'task:1')
 * @param events Map of event name → handler
 */
export function useSocket(room: string, events: Record<string, (data: unknown) => void>) {
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    const s = getSocket();
    // Rooms belong to the server-side connection, so a reconnect — every
    // backend restart/deploy — starts in no rooms. Join on EVERY connect, not
    // once at mount, or live updates silently stop until the page remounts.
    const join = () => s.emit('join', room);
    if (s.connected) join();
    s.on('connect', join);

    const handlers: Array<[string, (data: unknown) => void]> = Object.entries(eventsRef.current).map(
      ([event, _]) => {
        const handler = (data: unknown) => eventsRef.current[event]?.(data);
        s.on(event, handler);
        return [event, handler];
      }
    );

    return () => {
      s.off('connect', join);
      s.emit('leave', room);
      handlers.forEach(([event, handler]) => s.off(event, handler));
    };
  }, [room]);
}
