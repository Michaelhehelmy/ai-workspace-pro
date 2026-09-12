/**
 * app/pi/pi-rpc.js - Pi RPC sidecar (JSON-RPC 2.0)
 *
 * A tiny optional JSON-RPC 2.0 endpoint that lets a local Pi or external
 * controller drive the assistant's exported API. It is STRICTLY env-gated:
 * nothing binds a port unless AIWS_PI_RPC_PORT is set in the environment (or
 * `app.ai.pi.enabled` is true in config). In the browser the client half is
 * usable; the server half throws unless running under Node.
 *
 * Transport: HTTP POST {baseUrl}/rpc with a JSON-RPC 2.0 body.
 *   { "jsonrpc": "2.0", "method": "speak", "params": {...}, "id": 7 }
 * Response:
 *   { "jsonrpc": "2.0", "result": {...}, "id": 7 }
 *   { "jsonrpc": "2.0", "error": { "code": -32601, "message": "method not found" }, "id": 7 }
 */

const env = (typeof process !== 'undefined' && process.env) || {};
export const PI_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

const JSONRPC_ERRORS = Object.freeze({
  PARSE: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' }
});

export class PiRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'PiRpcError';
    this.code = code;
    this.data = data;
  }
}

let rpcId = 0;
function nextId() {
  rpcId += 1;
  return rpcId;
}

/** Build a JSON-RPC 2.0 request object. */
export function buildRequest(method, params, id) {
  const req = { jsonrpc: '2.0', method, id: id === undefined ? nextId() : id };
  if (params !== undefined) req.params = params;
  return req;
}

/**
 * Minimal JSON-RPC 2.0 client. Works in Node and browser (global fetch).
 * `fetchFn` is injectable for hermetic tests.
 */
export function createPiClient({ baseUrl, timeoutMs = 15000, fetchFn } = {}) {
  if (!baseUrl) throw new PiRpcError(JSONRPC_ERRORS.INVALID_PARAMS.code, 'createPiClient requires baseUrl');
  const doFetch = fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new PiRpcError(JSONRPC_ERRORS.INTERNAL.code, 'global fetch is unavailable');

  const rpcUrl = baseUrl.replace(/\/+$/, '') + '/rpc';

  async function call(method, params, opts = {}) {
    const req = buildRequest(method, params, opts.id);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || timeoutMs) : null;
    try {
      const res = await doFetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl ? ctrl.signal : undefined
      });
      const text = await res.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch (_) { /* keep null */ }
      if (!res.ok) {
        throw new PiRpcError(JSONRPC_ERRORS.INTERNAL.code, `Pi RPC HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!payload || payload.jsonrpc !== '2.0') {
        throw new PiRpcError(JSONRPC_ERRORS.PARSE.code, 'Invalid JSON-RPC envelope');
      }
      if (payload.error) {
        throw new PiRpcError(payload.error.code, payload.error.message || 'RPC error', payload.error.data);
      }
      return payload.result;
    } catch (err) {
      if (err instanceof PiRpcError) throw err;
      throw new PiRpcError(JSONRPC_ERRORS.INTERNAL.code, `Pi RPC call failed: ${err && err.message ? err.message : String(err)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    id: Math.random().toString(36).substring(2, 10),
    baseUrl: rpcUrl,
    call
  };
}

function handleRequest(req, methods) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string' || !('id' in req)) {
    return { jsonrpc: '2.0', error: JSONRPC_ERRORS.INVALID_REQUEST, id: null };
  }
  const handler = methods && methods[req.method];
  if (typeof handler !== 'function') {
    return { jsonrpc: '2.0', error: JSONRPC_ERRORS.METHOD_NOT_FOUND, id: req.id };
  }
  try {
    const result = handler(req.params, { method: req.method, id: req.id });
    return { jsonrpc: '2.0', result: result === undefined ? null : result, id: req.id };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      error: { code: JSONRPC_ERRORS.INTERNAL.code, message: err && err.message ? err.message : String(err) },
      id: req.id
    };
  }
}

/**
 * HTTP JSON-RPC server. NODE-ONLY (uses node:http). Throws a typed error in the
 * browser. `methods` maps names to async/plain handlers: (params, ctx) => any.
 */
export async function createPiServer({ port = 9300, host = '127.0.0.1', methods = {} } = {}) {
  if (!PI_NODE) {
    throw new PiRpcError(JSONRPC_ERRORS.INTERNAL.code, 'createPiServer requires Node.js (browser builds expose the client only)');
  }
  const { createServer } = await import('node:http');
  const registry = Object.assign({}, defaultMethods, methods || {});
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'allow': 'POST, OPTIONS', 'access-control-allow-methods': 'POST, OPTIONS' });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url || !req.url.endsWith('/rpc')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: JSONRPC_ERRORS.METHOD_NOT_FOUND, id: null }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_048_576) req.destroy();
    });
    req.on('end', () => {
      let head;
      try {
        head = JSON.parse(body || '{}');
      } catch (_) {
        head = null;
      }
      const reply = handleRequest(head, registry);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });

  let bound = false;
  return {
    id: Math.random().toString(36).substring(2, 10),
    port: 0,
    host,
    isListening: false,
    listen() {
      if (bound) return this;
      bound = true;
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          this.port = server.address().port;
          this.isListening = true;
          server.removeListener('error', reject);
          resolve(this);
        });
      });
    },
    close() {
      return new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    }
  };
}

export const defaultMethods = {
  ping(params, ctx) {
    return { pong: true, id: ctx && ctx.method, params: params === undefined ? null : params };
  },
  echo(params) {
    return params === undefined ? null : params;
  },
  time() {
    return Date.now();
  }
};

/**
 * Env-gated launcher. Returns null (disabled) unless the process is Node AND
 * one of:
 *   - process.env.AIWS_PI_RPC_PORT is set to a port number (not off/false/0)
 *   - config.app.ai.pi.enabled === true  (uses config port, default 9300)
 * An explicit numeric `opts.port` wins over env/config (port 0 → ephemeral).
 */
export async function startPiRpc({ config, port, host } = {}) {
  if (!PI_NODE) return null;
  const cfgPi = (config && config.app && config.app.ai && config.app.ai.pi) || {};
  const envPort = env.AIWS_PI_RPC_PORT !== undefined ? String(env.AIWS_PI_RPC_PORT) : null;
  const explicitlyEnabled = Boolean(cfgPi.enabled === true) || envPort !== null;
  if (!explicitlyEnabled) return null;
  if (envPort !== null && /^(off|false|0)$/i.test(envPort)) return null;

  let bindPort;
  if (Number.isInteger(port) && port >= 0) bindPort = port;
  else if (envPort !== null && envPort !== '') bindPort = parseInt(envPort, 10);
  else bindPort = Number(cfgPi.port) || 9300;
  if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) return null;

  const server = await createPiServer({ port: bindPort, host: host || '127.0.0.1' });
  await server.listen();
  return server;
}