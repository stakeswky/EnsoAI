import net from 'node:net';

/**
 * External TCP fault proxy for remote-mirror e2e.
 * Supports disconnect, delay, drop, and pause without product hooks.
 */
export function createTcpProxy(options = {}) {
  const state = {
    delayMs: options.delayMs ?? 0,
    dropProbability: options.dropProbability ?? 0,
    paused: false,
    closed: false,
    connections: new Set(),
  };

  const server = net.createServer((clientSocket) => {
    if (state.closed) {
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(options.targetPort, options.targetHost ?? '127.0.0.1');
    state.connections.add(clientSocket);
    state.connections.add(upstream);

    const pipe = (from, to) => {
      from.on('data', (buf) => {
        if (state.paused || state.closed) return;
        if (Math.random() < state.dropProbability) return;
        const send = () => {
          if (!to.destroyed) to.write(buf);
        };
        if (state.delayMs > 0) setTimeout(send, state.delayMs);
        else send();
      });
      from.on('close', () => to.destroy());
      from.on('error', () => to.destroy());
    };
    pipe(clientSocket, upstream);
    pipe(upstream, clientSocket);
  });

  return {
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address();
      return typeof address === 'object' && address ? address.port : port;
    },
    setDelay(ms) {
      state.delayMs = ms;
    },
    setDropProbability(p) {
      state.dropProbability = p;
    },
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
    },
    disconnectAll() {
      for (const socket of state.connections) socket.destroy();
      state.connections.clear();
    },
    async close() {
      state.closed = true;
      this.disconnectAll();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
