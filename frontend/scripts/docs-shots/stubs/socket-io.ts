/**
 * Stand-in for `socket.io-client` in the docs-screenshot build. Pages only
 * join rooms and listen for live updates; a socket that never connects keeps
 * every page on the data its fixtures returned, and no reconnect loop runs
 * while the screenshots are taken.
 */
class QuietSocket {
  connected = false;
  on() { return this; }
  off() { return this; }
  emit() { return this; }
  connect() { return this; }
  disconnect() { return this; }
}

export function io(_url?: string, _opts?: unknown) {
  return new QuietSocket();
}

export type Socket = QuietSocket;
