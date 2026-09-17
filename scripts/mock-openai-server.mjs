#!/usr/bin/env node
/**
 * Mock OpenAI-compatible server for CI integration testing
 * 
 * Usage:
 *   node scripts/mock-openai-server.mjs --port=18080 --mode=success
 *   node scripts/mock-openai-server.mjs --port=18081 --mode=fail
 *   node scripts/mock-openai-server.mjs --port=18082 --mode=hang
 *   node scripts/mock-openai-server.mjs --port=18083 --mode=timeout
 * 
 * Admin endpoints:
 *   POST /__admin/mode/success  - return successful stream
 *   POST /__admin/mode/fail     - return connection error
 *   POST /__admin/mode/hang     - accept connection but never send data
 *   POST /__admin/mode/timeout  - timeout before first token (30s)
 */

import { createServer } from 'http';
import { parseArgs } from 'util';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string', short: 'p', default: '18080' },
    mode: { type: 'string', short: 'm', default: 'success' },
    host: { type: 'string', short: 'h', default: '127.0.0.1' },
  },
  allowPositionals: true,
});

const PORT = parseInt(values.port, 10);
const HOST = values.host;
let MODE = values.mode; // 'success' | 'fail' | 'hang' | 'timeout'

// Simple SSE stream generator for successful responses
function* generateSuccessStream(model = 'mock-model') {
  const chunks = [
    { role: 'assistant', content: '' },
    { content: 'Hello' },
    { content: ' from' },
    { content: ' mock' },
    { content: ' server!' },
  ];
  
  for (const chunk of chunks) {
    yield `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: chunk, finish_reason: null }],
    })}\n\n`;
    
    // Small delay to simulate streaming
    yield new Promise(r => setTimeout(r, 50));
  }
  
  yield `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`;
  yield 'data: [DONE]\n\n';
}

function handleChatCompletions(req, res, mode) {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  };
  
  if (mode === 'fail') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'Service unavailable', type: 'server_error', code: 'service_unavailable' }
    }));
    return;
  }
  
  if (mode === 'hang') {
    // Accept connection but never send data - client will timeout
    res.writeHead(200, headers);
    // Don't end - just hang
    return;
  }
  
  if (mode === 'timeout') {
    // Accept but delay first token beyond typical timeout (30s)
    res.writeHead(200, headers);
    setTimeout(() => {
      for (const chunk of generateSuccessStream('timeout-model')) {
        if (typeof chunk === 'string') res.write(chunk);
      }
      res.end();
    }, 35000);
    return;
  }
  
  // success mode
  res.writeHead(200, headers);
  
  const stream = generateSuccessStream();
  const sendNext = () => {
    const result = stream.next();
    if (result.done) {
      res.end();
      return;
    }
    
    const value = result.value;
    if (value instanceof Promise) {
      value.then(() => sendNext());
    } else {
      res.write(value);
      sendNext();
    }
  };
  
  sendNext();
}

function handleAdmin(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { mode } = JSON.parse(body || '{}');
      if (['success', 'fail', 'hang', 'timeout'].includes(mode)) {
        MODE = mode;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: MODE }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid mode. Use: success, fail, hang, timeout' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  
  if (url.pathname === '/__admin/mode' && req.method === 'POST') {
    return handleAdmin(req, res);
  }
  
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    return handleChatCompletions(req, res, MODE);
  }
  
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: MODE }));
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-openai] Server running at http://${HOST}:${PORT} (mode: ${MODE})`);
  console.log(`[mock-openai] Admin: POST http://${HOST}:${PORT}/__admin/mode { "mode": "success|fail|hang|timeout" }`);
  console.log(`[mock-openai] Health: GET http://${HOST}:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[mock-openai] Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[mock-openai] Shutting down...');
  server.close(() => process.exit(0));
});