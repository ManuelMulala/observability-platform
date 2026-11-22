const os = require('os');
const { Worker } = require('worker_threads');
const express = require('express');
const mysql = require('mysql2/promise');
const AWSXRay = require('aws-xray-sdk-core');
const xrayExpress = require('aws-xray-sdk-express');

// Configuration comes from the ECS task definition (set by CDK)
const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME = 'obs', PORT = '3000' } = process.env;
const TASK = os.hostname();

AWSXRay.setContextMissingStrategy('LOG_ERROR'); // never crash if a call happens outside a request

const pool = mysql.createPool({
  host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  connectionLimit: 5, waitForConnections: true, connectTimeout: 5000, enableKeepAlive: true,
});

// One JSON line per event: easy to filter with metric filters and Logs Insights
function log(level, msg, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, task: TASK, ...fields }));
}

// Run a SQL query inside its own X-Ray subsegment, so slow SQL is visible in the trace
async function query(sql, params = []) {
  const parent = AWSXRay.getSegment();
  const sub = parent ? parent.addNewSubsegment('mysql') : null;
  if (sub) {
    sub.namespace = 'remote';
    sub.addSqlData({ url: `mysql://${DB_HOST}/${DB_NAME}`, database_type: 'MySQL', sanitized_query: sql });
  }
  try {
    const [rows] = await pool.query(sql, params);
    if (sub) sub.close();
    return rows;
  } catch (e) {
    if (sub) { sub.addError(e); sub.close(); }
    throw e;
  }
}

async function initSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, price DECIMAL(10,2) NOT NULL)`);
  await pool.query(`INSERT IGNORE INTO products (id, name, price) VALUES
    (1, 'Prepaid Data Bundle 10GB', 1000.00), (2, 'Home Fibre 40Mbps', 4100.00),
    (3, '4G Mi-Fi Router', 3999.00), (4, 'Postpaid Plan Gold', 2500.00)`);
}

async function withRetry(name, fn, attempts = 30, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    try { await fn(); log('INFO', `${name} ok`); return; }
    catch (e) { log('WARN', `${name} attempt ${i}/${attempts} failed`, { error: e.message }); }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

const app = express();

// Health checks are registered before X-Ray so they do not flood the trace map
app.get(['/health', '/api/health'], (req, res) => res.json({ status: 'ok', task: TASK }));

app.use(xrayExpress.openSegment('obs-app'));

// Request log: method, path, status, latency and the X-Ray trace ID for correlation
app.use((req, res, next) => {
  const started = Date.now();
  const seg = AWSXRay.getSegment();
  res.on('finish', () => {
    log(res.statusCode >= 500 ? 'ERROR' : 'INFO', 'request', {
      method: req.method, path: req.path, status: res.statusCode,
      latencyMs: Date.now() - started, traceId: seg && seg.trace_id,
    });
  });
  next();
});

app.get('/api', (req, res) => res.json({
  service: 'obs-app', task: TASK,
  endpoints: ['GET /api/products', 'GET /api/slow', 'GET /api/heavy', 'GET /api/error', 'GET /api/cpu?seconds=N', 'GET /api/health'],
}));

app.get('/api/products', async (req, res) => {
  try {
    res.json({ products: await query('SELECT id, name, price FROM products ORDER BY id') });
  } catch (e) {
    log('ERROR', 'products query failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Slow query: shows up in X-Ray, the RDS slow query log and Performance Insights at the same time
app.get('/api/slow', async (req, res) => {
  const seconds = Math.min(Math.max(Number(req.query.seconds) || 2, 1), 10);
  try {
    await query('SELECT SLEEP(?) AS slept', [seconds]);
    res.json({ slowQuerySeconds: seconds });
  } catch (e) {
    log('ERROR', 'slow query failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// CPU-heavy query: real database work, visible as DB load / Top SQL in Database Insights
app.get('/api/heavy', async (req, res) => {
  const rounds = Math.min(Math.max(Number(req.query.rounds) || 3000000, 100000), 20000000);
  const started = Date.now();
  try {
    await query("SELECT BENCHMARK(?, SHA2('obs-platform', 256)) AS done", [rounds]);
    res.json({ benchmarkRounds: rounds, dbMs: Date.now() - started });
  } catch (e) {
    log('ERROR', 'heavy query failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// Mock failure: an application error that returns 500 and logs ERROR (drives the ErrorCount alarm)
app.get('/api/error', (req, res) => {
  log('ERROR', 'simulated payment gateway failure', { errorCode: 'PAYMENT_TIMEOUT' });
  res.status(500).json({ error: 'Simulated failure for alarm testing' });
});

// Mock failure: burns CPU in a worker thread so /health stays responsive (drives the CPU alarm)
app.get('/api/cpu', (req, res) => {
  const seconds = Math.min(Math.max(Number(req.query.seconds) || 60, 1), 600);
  new Worker(`const end = Date.now() + ${seconds * 1000}; while (Date.now() < end) { Math.sqrt(Math.random()); }`, { eval: true });
  log('WARN', 'cpu burn started', { seconds });
  res.json({ cpuBurnSeconds: seconds, task: TASK });
});

app.use(xrayExpress.closeSegment());

const server = app.listen(Number(PORT), () => log('INFO', `obs-app listening on ${PORT}`));
withRetry('schema init', initSchema);

process.on('SIGTERM', async () => {
  log('INFO', 'SIGTERM received, shutting down');
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
});
