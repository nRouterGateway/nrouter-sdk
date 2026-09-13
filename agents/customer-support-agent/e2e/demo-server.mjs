import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSupportAgent } from '../dist/index.js';
import { loadKnowledgeIndex } from '../dist/node.js';

const apiKey = process.env.NROUTER_API_KEY;
if (!apiKey) {
  console.error('NROUTER_API_KEY is required');
  process.exit(1);
}

const baseURL = process.env.NROUTER_BASE_URL || undefined;
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4174;
const kbPathEnv = process.env.KB_PATH || 'e2e/.kb.json';
const model = process.env.MODEL || 'claude-haiku-4-5-20251001';

function resolveKbPath() {
  if (path.isAbsolute(kbPathEnv)) return kbPathEnv;
  const fromCwd = path.resolve(process.cwd(), kbPathEnv);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), path.basename(kbPathEnv));
  if (fs.existsSync(fromDir)) return fromDir;
  return fromCwd;
}

let agentPromise = null;
function getAgent() {
  if (!agentPromise) {
    agentPromise = (async () => {
      try {
        const kbFile = resolveKbPath();
        const knowledge = await loadKnowledgeIndex(kbFile);
        return createSupportAgent({
          apiKey,
          baseURL,
          model,
          knowledge
        });
      } catch (err) {
        agentPromise = null;
        throw err;
      }
    })();
  }
  return agentPromise;
}

function getTrustedContext(req) {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) {
        const name = part.slice(0, eqIdx).trim();
        const value = part.slice(eqIdx + 1).trim();
        if (name === 'demo_session' && value === 'partner') {
          return { audiences: ['partners'], sessionId: undefined };
        }
      }
    }
  }
  return {};
}

const server = http.createServer(async (req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});

  try {
    const host = req.headers.host || '127.0.0.1';
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const { pathname } = parsedUrl;

    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && pathname === '/login-as-partner') {
      res.writeHead(302, {
        'Set-Cookie': 'demo_session=partner; Path=/',
        'Location': '/'
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': 'demo_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0',
        'Location': '/'
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
      const html = await fs.promises.readFile(indexPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html)
      });
      res.end(html);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const MAX_BODY_BYTES = 64 * 1024;
      let totalBytes = 0;
      const chunks = [];
      let limitExceeded = false;

      req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          limitExceeded = true;
          req.destroy();
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', async () => {
        if (limitExceeded) return;
        try {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const body = JSON.parse(rawBody);
          const ctx = getTrustedContext(req);
          const agent = await getAgent();
          const stream = agent.chatSSE(body, ctx);
          const reader = stream.getReader();

          let streamEnded = false;
          req.on('close', () => {
            if (!streamEnded) {
              reader.cancel().catch(() => {});
            }
          });

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
          });

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              streamEnded = true;
              break;
            }
            if (value) {
              res.write(value);
            }
          }

          if (!res.writableEnded) {
            res.end();
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
          } else if (!res.writableEnded) {
            res.end();
          }
        }
      });
      return;
    }

    // Unknown routes / methods
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Demo server listening on http://${host}:${port}`);
});
