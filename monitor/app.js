// ============================================================
// DISTRIBUTED SYSTEMS HEALTH MONITOR
// ============================================================
// Simulates a 6-service microservice architecture and
// visualizes its health in real-time. Circuit breaker follows
// the CLOSED/OPEN/HALF_OPEN state machine with exponential
// backoff + jitter on recovery to prevent thundering herd.
//
// Architecture decision: pure JS with Canvas, no framework.
// Data-flow layout (L-to-R) chosen over force-directed because
// service count is fixed and predictable positioning aids
// recognition during fault scenarios. Force-directed would be
// wrong here -- it optimizes for discovery, not monitoring.
//
// Event model: Poisson-distributed during steady-state (~120
// events/sec, ~2 per frame). During faults, switches to bursty
// correlated model where errors propagate upstream with
// 200-500ms hop delay. Poisson breaks during cascades because
// real failures are correlated, not independent.
// ============================================================

'use strict';

// ---- Colors ----
const C = {
  bg:     '#111',
  amber:  '#ff8c00',
  blue:   '#3388ff',
  green:  '#00cc66',
  red:    '#ff3333',
  yellow: '#ffcc00',
  muted:  '#555',
  dim:    '#333',
  text:   '#bbb',
  node:   '#161616',
  nodeBorder: '#222'
};

// ---- Service Definitions ----
// Data-flow: Gateway -> Order -> Risk -> Settlement -> Audit
//            Gateway -> Market Data -> Risk, Settlement
const SERVICES = [
  { id: 'gateway',    name: 'API Gateway',   short: 'GATEWAY',   x: 0.08, y: 0.50, latBase: 5,  errBase: 0.001, tputBase: 450, conns: ['order','market'] },
  { id: 'order',      name: 'Order Svc',     short: 'ORDER',     x: 0.30, y: 0.25, latBase: 18, errBase: 0.002, tputBase: 380, conns: ['risk'] },
  { id: 'market',     name: 'Market Data',   short: 'MKT DATA',  x: 0.30, y: 0.75, latBase: 8,  errBase: 0.001, tputBase: 820, conns: ['risk','settle'] },
  { id: 'risk',       name: 'Risk Engine',   short: 'RISK',      x: 0.54, y: 0.38, latBase: 25, errBase: 0.003, tputBase: 300, conns: ['settle'] },
  { id: 'settle',     name: 'Settlement',    short: 'SETTLE',    x: 0.76, y: 0.50, latBase: 35, errBase: 0.002, tputBase: 250, conns: ['audit'] },
  { id: 'audit',      name: 'Audit Logger',  short: 'AUDIT',     x: 0.92, y: 0.50, latBase: 3,  errBase: 0.0005,tputBase: 600, conns: [] }
];

// ---- Circuit Breaker ----
// Exponential backoff with jitter prevents thundering herd
// when multiple upstreams try to probe a recovering service
// at the same instant.
class CircuitBreaker {
  constructor(threshold, baseTimeout) {
    this.state = 'CLOSED';
    this.errorCount = 0;
    this.threshold = threshold;
    this.baseTimeout = baseTimeout;
    this.openedAt = 0;
    this.currentTimeout = baseTimeout;
    this.probeSent = false;
    this.forwarded = 0;
    this.rejected = 0;
    this.consecutiveFailures = 0;
  }

  // Invariant: when state === 'OPEN', this returns false.
  // Zero calls forwarded while OPEN.
  canForward() {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.currentTimeout) {
        this.state = 'HALF_OPEN';
        // This transition call IS the probe -- mark it sent
        // so exactly 1 call gets through, not 2
        this.probeSent = true;
        return true;
      }
      return false;
    }
    // HALF_OPEN: the probe was already sent during the
    // OPEN->HALF_OPEN transition. Reject everything else
    // until we get a success or failure result.
    return false;
  }

  recordSuccess() {
    this.forwarded++;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.errorCount = 0;
      this.consecutiveFailures = 0;
      this.currentTimeout = this.baseTimeout;
    }
  }

  recordFailure() {
    if (this.state === 'CLOSED') {
      this.errorCount++;
      if (this.errorCount >= this.threshold) {
        this._open();
      }
    } else if (this.state === 'HALF_OPEN') {
      this.consecutiveFailures++;
      this._open();
    }
  }

  _open() {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    // Exponential backoff with jitter:
    // timeout doubles each consecutive failure, capped at 30s,
    // plus random jitter of 0-2s
    const backoff = Math.min(
      this.baseTimeout * Math.pow(2, this.consecutiveFailures),
      30000
    );
    this.currentTimeout = backoff + Math.random() * 2000;
  }

  reset() {
    this.state = 'CLOSED';
    this.errorCount = 0;
    this.consecutiveFailures = 0;
    this.currentTimeout = this.baseTimeout;
    this.probeSent = false;
  }

  timeUntilHalfOpen() {
    if (this.state !== 'OPEN') return 0;
    return Math.max(0, this.currentTimeout - (Date.now() - this.openedAt));
  }
}

// ============================================================
// STATE
// ============================================================

const svcMap = {};
const state = {
  services: [],
  selected: null,       // selected service id
  faultTarget: null,    // id of service currently under fault
  faultStart: 0,
  totalEvents: 0,
  streamFilter: 'ALL',
  particles: [],
  eventBuffer: [],      // recent events for stream display
  metricsHistory: {}    // per-service rolling latency samples
};

// ---- Initialize services ----
SERVICES.forEach(def => {
  const svc = {
    ...def,
    health: 'healthy',    // healthy | degraded | down
    cb: new CircuitBreaker(5, 8000),
    // Live metrics (smoothed)
    latency: def.latBase,
    latP50: def.latBase,
    latP95: def.latBase * 2.5,
    latP99: def.latBase * 4,
    throughput: def.tputBase,
    errorRate: def.errBase,
    queueDepth: 0,
    // Raw sample buffers for percentile calculation
    latSamples: [],
    errSamples: [],
    tputCounter: 0,
    lastTputReset: Date.now()
  };
  state.services.push(svc);
  svcMap[svc.id] = svc;
  state.metricsHistory[svc.id] = { p50: [], p95: [], p99: [] };
});

// System-wide history
state.metricsHistory['_system'] = { p50: [], p95: [], p99: [] };

// ============================================================
// SIMULATION ENGINE
// ============================================================

const SIM_INTERVAL = 16; // ~60fps tick rate
let lastSimTime = Date.now();
let lastMetricsSample = Date.now();

function simulationTick() {
  const now = Date.now();
  const dt = (now - lastSimTime) / 1000;
  lastSimTime = now;

  // -- Generate events --
  // Poisson: expected events this frame = rate * dt
  const baseRate = 120;
  const expectedEvents = baseRate * dt;
  // Poisson approximation: use the expected count with some variance
  const numEvents = Math.max(0, Math.round(expectedEvents + (Math.random() - 0.5) * 3));

  for (let i = 0; i < numEvents; i++) {
    generateEvent(now);
  }

  // -- Update fault propagation --
  if (state.faultTarget) {
    propagateFault(now);
  }

  // -- Update service metrics --
  state.services.forEach(svc => {
    updateServiceMetrics(svc, now);
  });

  // -- Sample metrics for chart (6Hz) --
  if (now - lastMetricsSample > 167) {
    sampleMetricsForChart();
    lastMetricsSample = now;
  }

  // -- Update particles --
  updateParticles(dt);

  // -- Recovery check --
  if (state.faultTarget) {
    const faultSvc = svcMap[state.faultTarget];
    if (faultSvc && faultSvc.cb.state === 'CLOSED' && now - state.faultStart > 20000) {
      // Auto-recover after 20s if CB has reset
      clearFault();
    }
  }
}

function generateEvent(now) {
  // Pick a random starting service (weighted toward gateway)
  const weights = [0.35, 0.2, 0.15, 0.12, 0.1, 0.08];
  let r = Math.random();
  let srcIdx = 0;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) { srcIdx = i; break; }
  }
  const svc = state.services[srcIdx];

  // Check circuit breaker
  if (!svc.cb.canForward()) {
    svc.cb.rejected++;
    addStreamEvent(now, svc.short, 'WARN', 'Circuit breaker OPEN -- request rejected');
    state.totalEvents++;
    return;
  }

  // Simulate processing
  const isFaulted = svc.id === state.faultTarget;
  const baseErr = isFaulted ? 0.4 : svc.errBase;
  const isError = Math.random() < baseErr;

  // Calculate latency
  let lat = svc.latBase * (0.7 + Math.random() * 0.6);
  if (isFaulted) {
    // Faulted service: latency spikes 5-15x
    lat *= 5 + Math.random() * 10;
  }

  // Upstream degradation: if downstream is faulted, upstream feels it
  if (!isFaulted && state.faultTarget) {
    const faultSvc = svcMap[state.faultTarget];
    // Check if this service connects (directly or indirectly) to faulted service
    if (svc.conns.includes(state.faultTarget) || isUpstreamOf(svc.id, state.faultTarget)) {
      lat *= 1.5 + Math.random() * 2; // Backpressure: 1.5-3.5x latency
      svc.queueDepth = Math.min(svc.queueDepth + Math.random() * 2, 200);
    }
  }

  svc.latSamples.push(lat);
  if (svc.latSamples.length > 200) svc.latSamples.shift();
  svc.tputCounter++;

  if (isError) {
    svc.cb.recordFailure();
    svc.errSamples.push(1);
    addStreamEvent(now, svc.short, 'ERROR',
      isFaulted ? 'Service degraded -- ' + errorMessage() : 'Request failed -- ' + errorMessage());
  } else {
    svc.cb.recordSuccess();
    svc.errSamples.push(0);
    // Only log INFO for ~5% of successes to avoid flood
    if (Math.random() < 0.05) {
      addStreamEvent(now, svc.short, 'INFO', successMessage(svc));
    }
  }

  if (svc.errSamples.length > 200) svc.errSamples.shift();
  state.totalEvents++;

  // Spawn particle for visual feedback
  if (svc.conns.length > 0) {
    const targetId = svc.conns[Math.floor(Math.random() * svc.conns.length)];
    spawnParticle(svc.id, targetId, isError);
  }
}

function isUpstreamOf(srcId, targetId) {
  // BFS to check if srcId can reach targetId
  const visited = new Set();
  const queue = [srcId];
  while (queue.length > 0) {
    const curr = queue.shift();
    if (visited.has(curr)) continue;
    visited.add(curr);
    const s = svcMap[curr];
    if (!s) continue;
    for (const c of s.conns) {
      if (c === targetId) return true;
      queue.push(c);
    }
  }
  return false;
}

function propagateFault(now) {
  const elapsed = now - state.faultStart;
  const faultSvc = svcMap[state.faultTarget];
  if (!faultSvc) return;

  faultSvc.health = 'down';

  // Propagate upstream with delay per hop
  // Services that depend on faulted service degrade after 300ms per hop
  state.services.forEach(svc => {
    if (svc.id === state.faultTarget) return;
    if (svc.conns.includes(state.faultTarget)) {
      // Direct upstream -- degrade after 300ms
      if (elapsed > 300) {
        svc.health = 'degraded';
      }
    } else if (isUpstreamOf(svc.id, state.faultTarget)) {
      // Indirect upstream -- degrade after 600ms
      if (elapsed > 600) {
        svc.health = 'degraded';
      }
    }
  });
}

function updateServiceMetrics(svc, now) {
  // Throughput: events per second
  const tputElapsed = (now - svc.lastTputReset) / 1000;
  if (tputElapsed >= 1) {
    svc.throughput = Math.round(svc.tputCounter / tputElapsed);
    svc.tputCounter = 0;
    svc.lastTputReset = now;
  }

  // Percentiles from sample buffer
  if (svc.latSamples.length > 3) {
    const sorted = [...svc.latSamples].sort((a, b) => a - b);
    svc.latP50 = sorted[Math.floor(sorted.length * 0.5)];
    svc.latP95 = sorted[Math.floor(sorted.length * 0.95)];
    svc.latP99 = sorted[Math.floor(sorted.length * 0.99)];
  }

  // Error rate
  if (svc.errSamples.length > 3) {
    const errs = svc.errSamples.reduce((a, b) => a + b, 0);
    svc.errorRate = errs / svc.errSamples.length;
  }

  // Queue depth decay (drains naturally when not under pressure)
  if (svc.id !== state.faultTarget && !svc.conns.includes(state.faultTarget)) {
    // Invariant: queue depth never goes below 0
    svc.queueDepth = Math.max(0, svc.queueDepth - 0.3);
  }

  // Health status based on CB state
  if (svc.id !== state.faultTarget) {
    if (svc.cb.state === 'OPEN') {
      svc.health = 'degraded';
    } else if (svc.health === 'degraded' && svc.cb.state === 'CLOSED' && !state.faultTarget) {
      svc.health = 'healthy';
    } else if (!state.faultTarget) {
      svc.health = 'healthy';
    }
  }
}

function sampleMetricsForChart() {
  const maxHistory = 180; // 30 seconds at 6Hz

  state.services.forEach(svc => {
    const h = state.metricsHistory[svc.id];
    h.p50.push(svc.latP50);
    h.p95.push(svc.latP95);
    h.p99.push(svc.latP99);
    if (h.p50.length > maxHistory) { h.p50.shift(); h.p95.shift(); h.p99.shift(); }
  });

  // System-wide aggregate
  const sys = state.metricsHistory['_system'];
  const allP50 = state.services.reduce((s, v) => s + v.latP50, 0) / state.services.length;
  const allP95 = state.services.reduce((s, v) => s + v.latP95, 0) / state.services.length;
  const allP99 = state.services.reduce((s, v) => s + v.latP99, 0) / state.services.length;
  sys.p50.push(allP50);
  sys.p95.push(allP95);
  sys.p99.push(allP99);
  if (sys.p50.length > maxHistory) { sys.p50.shift(); sys.p95.shift(); sys.p99.shift(); }
}

// ---- Fault injection ----

function injectFault(targetId) {
  if (state.faultTarget) {
    clearFault();
    return;
  }
  // If no target selected, pick a random non-gateway service
  if (!targetId) {
    const candidates = state.services.filter(s => s.id !== 'gateway');
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    targetId = pick.id;
  }
  state.faultTarget = targetId;
  state.faultStart = Date.now();
  state.selected = targetId;

  const svc = svcMap[targetId];
  svc.health = 'down';

  addStreamEvent(Date.now(), svc.short, 'ERROR', 'FAULT INJECTED -- service degradation initiated');

  document.getElementById('inject-btn').textContent = 'CLEAR FAULT';
  document.getElementById('inject-btn').classList.add('injected');
}

function clearFault() {
  if (!state.faultTarget) return;
  const svc = svcMap[state.faultTarget];

  addStreamEvent(Date.now(), svc.short, 'OK', 'Fault cleared -- recovery in progress');

  state.faultTarget = null;
  state.faultStart = 0;

  // Reset all services to healthy, reset CBs
  state.services.forEach(s => {
    s.health = 'healthy';
    s.cb.reset();
    s.queueDepth = 0;
    s.latSamples = [];
    s.errSamples = [];
  });

  document.getElementById('inject-btn').textContent = 'INJECT FAULT';
  document.getElementById('inject-btn').classList.remove('injected');
}

// ---- Event stream ----

const MAX_STREAM = 150;

function addStreamEvent(time, service, level, message) {
  state.eventBuffer.unshift({ time, service, level, message });
  if (state.eventBuffer.length > MAX_STREAM) {
    state.eventBuffer.pop();
  }
}

// ---- Particles ----

function spawnParticle(fromId, toId, isError) {
  const from = svcMap[fromId];
  const to = svcMap[toId];
  if (!from || !to) return;

  // Don't spawn if target is down and CB is open
  if (to.health === 'down' && to.cb.state === 'OPEN') return;

  state.particles.push({
    fromX: from.x, fromY: from.y,
    toX: to.x, toY: to.y,
    progress: 0,
    speed: 0.8 + Math.random() * 0.6,
    isError: isError
  });
}

function updateParticles(dt) {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    state.particles[i].progress += state.particles[i].speed * dt;
    if (state.particles[i].progress >= 1) {
      state.particles.splice(i, 1);
    }
  }
  // Cap total particles for performance
  if (state.particles.length > 200) {
    state.particles.splice(0, state.particles.length - 200);
  }
}

// ---- Message templates ----

const ERROR_MSGS = [
  'Timeout exceeded (5000ms)',
  'Connection refused',
  'Internal server error (500)',
  'Resource exhausted',
  'Deadline exceeded',
  'Service unavailable (503)',
  'Rate limit exceeded',
  'Out of memory',
  'Socket hangup',
  'ECONNRESET'
];

const SUCCESS_MSGS_MAP = {
  GATEWAY:  ['Request routed successfully', 'Health check passed', 'Load balanced to instance'],
  ORDER:    ['Order validated', 'Order queued for processing', 'Batch committed'],
  'MKT DATA': ['Price tick processed', 'Feed snapshot delivered', 'Subscription refreshed'],
  RISK:     ['Risk check passed', 'Exposure within limits', 'Margin calculated'],
  SETTLE:   ['Trade confirmed', 'Settlement instruction sent', 'Position updated'],
  AUDIT:    ['Event persisted', 'Audit log flushed', 'Checkpoint written']
};

function errorMessage() {
  return ERROR_MSGS[Math.floor(Math.random() * ERROR_MSGS.length)];
}

function successMessage(svc) {
  const msgs = SUCCESS_MSGS_MAP[svc.short] || ['Processed'];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

// ============================================================
// RENDERING
// ============================================================

// ---- DOM references ----
const dom = {};

function cacheDom() {
  dom.clock = document.getElementById('clock');
  dom.totalEvents = document.getElementById('total-events');
  dom.systemDot = document.getElementById('system-dot');
  dom.topoCanvas = document.getElementById('topology-canvas');
  dom.topoCtx = dom.topoCanvas.getContext('2d');
  dom.topoSelected = document.getElementById('topo-selected');
  dom.metricsTarget = document.getElementById('metrics-target');
  dom.mP50 = document.getElementById('m-p50');
  dom.mP95 = document.getElementById('m-p95');
  dom.mP99 = document.getElementById('m-p99');
  dom.mThroughput = document.getElementById('m-throughput');
  dom.mError = document.getElementById('m-error');
  dom.mQueue = document.getElementById('m-queue');
  dom.latChart = document.getElementById('latency-chart');
  dom.latCtx = dom.latChart.getContext('2d');
  dom.stream = document.getElementById('event-stream');
  dom.cbTarget = document.getElementById('cb-target');
  dom.cbClosed = document.getElementById('cb-closed');
  dom.cbOpen = document.getElementById('cb-open');
  dom.cbHalf = document.getElementById('cb-half');
  dom.cbErrors = document.getElementById('cb-errors');
  dom.cbForwarded = document.getElementById('cb-forwarded');
  dom.cbRejected = document.getElementById('cb-rejected');
  dom.cbTimer = document.getElementById('cb-timer');
  dom.injectBtn = document.getElementById('inject-btn');
}

// ---- Canvas sizing (retina-aware) ----
function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { w: rect.width, h: rect.height };
}

// ---- Status bar ----
function renderStatusBar() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  dom.clock.textContent = h + ':' + m + ':' + s + '.' + ms;

  dom.totalEvents.textContent = state.totalEvents.toLocaleString();

  // System status
  const hasDown = state.services.some(s => s.health === 'down');
  const hasDegraded = state.services.some(s => s.health === 'degraded');
  dom.systemDot.className = 'status-dot' +
    (hasDown ? ' down' : hasDegraded ? ' degraded' : '');
}

// ---- Topology ----
const NODE_W = 82;
const NODE_H = 36;
const NODE_R = 4;

function renderTopology() {
  // Dynamic resize: ensure canvas matches its container
  const dpr = window.devicePixelRatio || 1;
  const rect = dom.topoCanvas.parentElement.getBoundingClientRect();
  if (dom.topoCanvas.width !== Math.round(rect.width * dpr) ||
      dom.topoCanvas.height !== Math.round(rect.height * dpr)) {
    dom.topoCanvas.width = rect.width * dpr;
    dom.topoCanvas.height = rect.height * dpr;
    dom.topoCanvas.style.width = rect.width + 'px';
    dom.topoCanvas.style.height = rect.height + 'px';
    dom.topoCtx.scale(dpr, dpr);
  }
  const w = rect.width;
  const h = rect.height;
  const ctx = dom.topoCtx;
  ctx.clearRect(0, 0, w, h);

  // Draw connections
  state.services.forEach(svc => {
    svc.conns.forEach(targetId => {
      const target = svcMap[targetId];
      if (!target) return;
      drawConnection(ctx, svc, target, w, h);
    });
  });

  // Draw particles
  state.particles.forEach(p => {
    const x = (p.fromX + (p.toX - p.fromX) * p.progress) * w;
    const y = (p.fromY + (p.toY - p.fromY) * p.progress) * h;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = p.isError ? C.red : C.amber;
    ctx.globalAlpha = 0.7;
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  // Draw nodes
  state.services.forEach(svc => {
    drawNode(ctx, svc, w, h);
  });

  // Selected label
  if (state.selected) {
    dom.topoSelected.textContent = svcMap[state.selected].short;
  } else {
    dom.topoSelected.textContent = '';
  }
}

function drawConnection(ctx, from, to, w, h) {
  const x1 = from.x * w;
  const y1 = from.y * h;
  const x2 = to.x * w;
  const y2 = to.y * h;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);

  // Connection color based on health of target
  if (to.health === 'down') {
    ctx.strokeStyle = C.red;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.4;
  } else if (to.health === 'degraded') {
    ctx.strokeStyle = C.yellow;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.5;
  } else {
    ctx.strokeStyle = C.dim;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.4;
  }

  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Arrow head
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const arrowDist = NODE_W * 0.55;
  const ax = x2 - Math.cos(angle) * arrowDist;
  const ay = y2 - Math.sin(angle) * arrowDist;
  const arrowLen = 6;

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(
    ax - arrowLen * Math.cos(angle - 0.4),
    ay - arrowLen * Math.sin(angle - 0.4)
  );
  ctx.moveTo(ax, ay);
  ctx.lineTo(
    ax - arrowLen * Math.cos(angle + 0.4),
    ay - arrowLen * Math.sin(angle + 0.4)
  );
  ctx.strokeStyle = to.health === 'down' ? C.red : C.dim;
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawNode(ctx, svc, w, h) {
  const x = svc.x * w;
  const y = svc.y * h;
  const nx = x - NODE_W / 2;
  const ny = y - NODE_H / 2;
  const isSelected = svc.id === state.selected;

  // Node background
  ctx.fillStyle = C.node;
  roundRect(ctx, nx, ny, NODE_W, NODE_H, NODE_R);
  ctx.fill();

  // Border color by health
  const borderColor = svc.health === 'healthy' ? C.green :
                       svc.health === 'degraded' ? C.yellow : C.red;
  ctx.strokeStyle = isSelected ? C.amber : borderColor;
  ctx.lineWidth = isSelected ? 2 : 1;
  roundRect(ctx, nx, ny, NODE_W, NODE_H, NODE_R);
  ctx.stroke();

  // Glow for selected
  if (isSelected) {
    ctx.shadowColor = C.amber;
    ctx.shadowBlur = 8;
    roundRect(ctx, nx, ny, NODE_W, NODE_H, NODE_R);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Service name
  ctx.fillStyle = isSelected ? C.amber : '#999';
  ctx.font = '9px "SF Mono", "Fira Code", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(svc.short, x, y - 5);

  // Health dot
  ctx.beginPath();
  ctx.arc(x, y + 8, 3, 0, Math.PI * 2);
  ctx.fillStyle = borderColor;
  if (svc.health === 'down') {
    ctx.shadowColor = C.red;
    ctx.shadowBlur = 6;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---- Click handler for topology ----
function handleTopoClick(e) {
  const rect = dom.topoCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const w = rect.width;
  const h = rect.height;

  let clicked = null;
  state.services.forEach(svc => {
    const nx = svc.x * w - NODE_W / 2;
    const ny = svc.y * h - NODE_H / 2;
    if (mx >= nx && mx <= nx + NODE_W && my >= ny && my <= ny + NODE_H) {
      clicked = svc.id;
    }
  });

  if (clicked) {
    state.selected = (state.selected === clicked) ? null : clicked;
  } else {
    state.selected = null;
  }
}

// ---- Metrics panel ----
function renderMetrics() {
  const target = state.selected ? svcMap[state.selected] : null;

  // Target label
  dom.metricsTarget.textContent = target ? target.short : 'SYSTEM';

  if (target) {
    setMetricValue(dom.mP50, target.latP50, 'ms', 'latency');
    setMetricValue(dom.mP95, target.latP95, 'ms', 'latency');
    setMetricValue(dom.mP99, target.latP99, 'ms', 'latency');
    dom.mThroughput.innerHTML = Math.round(target.throughput) + '<span class="metric-unit"> msg/s</span>';
    setMetricValue(dom.mError, target.errorRate * 100, '%', 'error');
    dom.mQueue.innerHTML = Math.round(target.queueDepth);
    dom.mQueue.className = 'metric-value' + (target.queueDepth > 50 ? ' bad' : target.queueDepth > 20 ? ' warn' : '');
  } else {
    // System-wide aggregates
    const avgP50 = avg(state.services.map(s => s.latP50));
    const avgP95 = avg(state.services.map(s => s.latP95));
    const avgP99 = avg(state.services.map(s => s.latP99));
    const totalTput = state.services.reduce((s, v) => s + v.throughput, 0);
    const avgErr = avg(state.services.map(s => s.errorRate));
    const totalQueue = state.services.reduce((s, v) => s + v.queueDepth, 0);

    setMetricValue(dom.mP50, avgP50, 'ms', 'latency');
    setMetricValue(dom.mP95, avgP95, 'ms', 'latency');
    setMetricValue(dom.mP99, avgP99, 'ms', 'latency');
    dom.mThroughput.innerHTML = Math.round(totalTput) + '<span class="metric-unit"> msg/s</span>';
    setMetricValue(dom.mError, avgErr * 100, '%', 'error');
    dom.mQueue.innerHTML = Math.round(totalQueue);
    dom.mQueue.className = 'metric-value' + (totalQueue > 100 ? ' bad' : totalQueue > 50 ? ' warn' : '');
  }
}

function setMetricValue(el, val, unit, type) {
  const formatted = val < 10 ? val.toFixed(1) : Math.round(val);
  let cls = 'metric-value';
  if (type === 'latency') {
    cls += val > 100 ? ' bad' : val > 50 ? ' warn' : ' good';
  } else if (type === 'error') {
    cls += val > 5 ? ' bad' : val > 1 ? ' warn' : ' good';
  }
  el.innerHTML = formatted + '<span class="metric-unit"> ' + unit + '</span>';
  el.className = cls;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---- Latency chart ----
function renderLatencyChart() {
  const canvas = dom.latChart;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  const h = rect.height;

  // Only resize if needed
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  const ctx = dom.latCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const key = state.selected || '_system';
  const history = state.metricsHistory[key];
  if (!history || history.p50.length < 2) return;

  const pad = { top: 4, right: 8, bottom: 4, left: 32 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  // Auto-scale Y
  const allVals = [...history.p50, ...history.p95, ...history.p99];
  const maxVal = Math.max(10, Math.max(...allVals) * 1.1);

  // Y-axis labels
  ctx.fillStyle = C.dim;
  ctx.font = '8px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(maxVal) + '', pad.left - 4, pad.top);
  ctx.fillText('0', pad.left - 4, pad.top + ch);

  // Draw lines
  const drawLine = (data, color) => {
    if (data.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    for (let i = 0; i < data.length; i++) {
      const x = pad.left + (i / (data.length - 1)) * cw;
      const y = pad.top + ch - (data[i] / maxVal) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  drawLine(history.p50, C.green);
  drawLine(history.p95, C.amber);
  drawLine(history.p99, C.red);
}

// ---- Event stream ----
let lastStreamRender = 0;

function renderEventStream() {
  // Throttle DOM updates to 4Hz
  const now = Date.now();
  if (now - lastStreamRender < 250) return;
  lastStreamRender = now;

  const container = dom.stream;
  const filter = state.streamFilter;

  // Build HTML for visible events
  const filtered = filter === 'ALL'
    ? state.eventBuffer
    : state.eventBuffer.filter(e => e.level === filter);

  const visible = filtered.slice(0, 80);

  let html = '';
  visible.forEach(ev => {
    const t = new Date(ev.time);
    const ts = String(t.getHours()).padStart(2,'0') + ':' +
               String(t.getMinutes()).padStart(2,'0') + ':' +
               String(t.getSeconds()).padStart(2,'0') + '.' +
               String(t.getMilliseconds()).padStart(3,'0').slice(0,2);
    html += '<div class="ev">' +
      '<span class="ev-t">' + ts + '</span>' +
      '<span class="ev-s">' + ev.service + '</span>' +
      '<span class="ev-l ' + ev.level + '">' + ev.level + '</span>' +
      '<span class="ev-m">' + ev.message + '</span>' +
      '</div>';
  });

  container.innerHTML = html;
}

// ---- Circuit breaker panel ----
function renderCircuitBreaker() {
  const targetId = state.selected || (state.faultTarget || null);
  const svc = targetId ? svcMap[targetId] : null;

  if (!svc) {
    dom.cbTarget.textContent = 'Select a service or inject fault';
    dom.cbClosed.className = 'cb-node is-closed';
    dom.cbOpen.className = 'cb-node';
    dom.cbHalf.className = 'cb-node';
    dom.cbErrors.textContent = '0 / 5';
    dom.cbForwarded.textContent = '0';
    dom.cbRejected.textContent = '0';
    dom.cbTimer.textContent = '';
    dom.cbTimer.className = 'cb-timer';
    return;
  }

  dom.cbTarget.textContent = svc.short;

  const cb = svc.cb;

  // State nodes
  dom.cbClosed.className = 'cb-node' + (cb.state === 'CLOSED' ? ' is-closed' : '');
  dom.cbOpen.className = 'cb-node' + (cb.state === 'OPEN' ? ' is-open' : '');
  dom.cbHalf.className = 'cb-node' + (cb.state === 'HALF_OPEN' ? ' is-half-open' : '');

  // Stats
  dom.cbErrors.textContent = cb.errorCount + ' / ' + cb.threshold;
  dom.cbErrors.className = 'cb-stat-value' + (cb.errorCount >= cb.threshold ? ' bad' : '');
  dom.cbForwarded.textContent = cb.forwarded.toLocaleString();
  dom.cbRejected.textContent = cb.rejected.toLocaleString();
  dom.cbRejected.className = 'cb-stat-value' + (cb.rejected > 0 ? ' bad' : '');

  // Timer
  if (cb.state === 'OPEN') {
    const remaining = cb.timeUntilHalfOpen();
    dom.cbTimer.textContent = 'HALF-OPEN probe in ' + (remaining / 1000).toFixed(1) + 's';
    dom.cbTimer.className = 'cb-timer active';
  } else if (cb.state === 'HALF_OPEN') {
    dom.cbTimer.textContent = 'Probing...';
    dom.cbTimer.className = 'cb-timer active';
  } else {
    dom.cbTimer.textContent = '';
    dom.cbTimer.className = 'cb-timer';
  }
}

// ============================================================
// MAIN LOOP
// ============================================================

function frame() {
  simulationTick();
  renderStatusBar();
  renderTopology();
  renderMetrics();
  renderLatencyChart();
  renderEventStream();
  renderCircuitBreaker();
  requestAnimationFrame(frame);
}

// ============================================================
// INITIALIZATION
// ============================================================

function init() {
  cacheDom();

  // Size canvases
  sizeCanvas(dom.topoCanvas);
  sizeCanvas(dom.latChart);

  // Event listeners
  dom.topoCanvas.addEventListener('click', handleTopoClick);

  dom.injectBtn.addEventListener('click', () => {
    injectFault(state.selected);
  });

  // Stream filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.streamFilter = btn.dataset.level;
    });
  });

  // Resize handler
  window.addEventListener('resize', () => {
    sizeCanvas(dom.topoCanvas);
    sizeCanvas(dom.latChart);
  });

  // Seed initial events
  for (let i = 0; i < 30; i++) {
    generateEvent(Date.now() - (30 - i) * 200);
  }
  sampleMetricsForChart();

  // Start
  addStreamEvent(Date.now(), 'SYSTEM', 'INFO', 'Monitor initialized -- 6 services online');
  requestAnimationFrame(frame);
}

document.addEventListener('DOMContentLoaded', init);
