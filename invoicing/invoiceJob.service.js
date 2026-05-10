const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'invoiceJobs.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(JOBS_FILE);
  } catch {
    await fs.writeFile(JOBS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

async function readJobs() {
  await ensureStore();

  const raw = await fs.readFile(JOBS_FILE, 'utf8');

  if (!raw.trim()) {
    return [];
  }

  return JSON.parse(raw);
}

async function writeJobs(jobs) {
  await ensureStore();
  await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf8');
}

function extractMercadoLibreOrderId(payload) {
  if (!payload) {
    return null;
  }

  if (payload.order_id) {
    return String(payload.order_id);
  }

  if (payload.id) {
    return String(payload.id);
  }

  if (payload.resource) {
    const match = String(payload.resource).match(/orders\/(\d+)/);

    if (match) {
      return match[1];
    }
  }

  return null;
}

function buildJobId({ source, payload }) {
  const orderId = extractMercadoLibreOrderId(payload);

  if (source === 'mercadolibre' && orderId) {
    return `ml-order-${orderId}`;
  }

  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ source, payload }))
    .digest('hex')
    .slice(0, 12);

  return `${source}-${hash}`;
}

async function createPendingJob({ source, payload }) {
  const jobs = await readJobs();

  const id = buildJobId({ source, payload });
  const existingJob = jobs.find((job) => job.id === id);

  if (existingJob) {
    return {
      created: false,
      job: existingJob
    };
  }

  const now = new Date().toISOString();

  const job = {
    id,
    source,
    status: 'pending',
    orderId: extractMercadoLibreOrderId(payload),
    payload,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    result: null
  };

  jobs.push(job);
  await writeJobs(jobs);

  return {
    created: true,
    job
  };
}

async function getPendingJobs(limit = 5) {
  const jobs = await readJobs();

  return jobs
    .filter((job) => job.status === 'pending')
    .slice(0, limit);
}

async function updateJob(jobId, patch) {
  const jobs = await readJobs();

  const index = jobs.findIndex((job) => job.id === jobId);

  if (index === -1) {
    throw new Error(`Invoice job not found: ${jobId}`);
  }

  jobs[index] = {
    ...jobs[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  await writeJobs(jobs);

  return jobs[index];
}

async function markProcessing(jobId) {
  const jobs = await readJobs();
  const job = jobs.find((item) => item.id === jobId);

  return updateJob(jobId, {
    status: 'processing',
    attempts: (job?.attempts || 0) + 1,
    lastError: null
  });
}

async function markFailed(jobId, error) {
  return updateJob(jobId, {
    status: 'failed',
    lastError: error instanceof Error ? error.message : String(error)
  });
}

async function markCompleted(jobId, result) {
  return updateJob(jobId, {
    status: 'invoiced_mock',
    result
  });
}

module.exports = {
  createPendingJob,
  getPendingJobs,
  updateJob,
  markProcessing,
  markFailed,
  markCompleted
};