const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.INVOICE_DATA_DIR
  ? path.resolve(process.env.INVOICE_DATA_DIR)
  : path.join(__dirname, '..', 'data');

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

async function getJobById(jobId) {
  const jobs = await readJobs();
  return jobs.find((job) => job.id === jobId) || null;
}

function getRunnableStatuses() {
  const statuses = [
    'pending',
    'arca_authorized',
    'pdf_failed',
    'upload_pending',
    'upload_failed'
  ];

  // En producción es más seguro no reintentar ARCA automáticamente.
  // Si necesitás reintentar jobs en arca_failed, hacelo manualmente por endpoint admin
  // o activá explícitamente INVOICE_RETRY_ARCA_FAILED=true.
  if (process.env.INVOICE_RETRY_ARCA_FAILED === 'true') {
    statuses.push('arca_failed');
  }

  if (process.env.ML_UPLOAD_INVOICE_TO_ML === 'true') {
    statuses.push('pdf_generated');
  }

  return statuses;
}

async function getRunnableJobs(limit = 5) {
  const jobs = await readJobs();
  const runnableStatuses = getRunnableStatuses();

  return jobs
    .filter((job) => runnableStatuses.includes(job.status))
    .slice(0, limit);
}

async function getPendingJobs(limit = 5) {
  return getRunnableJobs(limit);
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

async function markStatus(jobId, status, patch = {}) {
  return updateJob(jobId, {
    ...patch,
    status,
    updatedAt: new Date().toISOString()
  });
}

async function mergeJobResult(jobId, resultPatch) {
  const job = await getJobById(jobId);

  if (!job) {
    throw new Error(`Invoice job not found: ${jobId}`);
  }

  const result = {
    ...(job.result || {}),
    ...resultPatch
  };

  return updateJob(jobId, {
    result,
    lastError: null
  });
}

async function incrementAttempts(jobId) {
  const job = await getJobById(jobId);

  if (!job) {
    throw new Error(`Invoice job not found: ${jobId}`);
  }

  return updateJob(jobId, {
    attempts: (job.attempts || 0) + 1,
    lastError: null
  });
}

async function setLastError(jobId, error) {
  return updateJob(jobId, {
    lastError: error instanceof Error ? error.message : String(error)
  });
}

async function markStageFailed(jobId, status, error) {
  return updateJob(jobId, {
    status,
    lastError: error instanceof Error ? error.message : String(error)
  });
}

async function markProcessing(jobId) {
  await incrementAttempts(jobId);

  return markStatus(jobId, 'processing', {
    lastError: null
  });
}

async function markFailed(jobId, error) {
  return markStageFailed(jobId, 'failed', error);
}

async function markCompleted(jobId, result) {
  return updateJob(jobId, {
    status: 'invoice_completed',
    result,
    lastError: null
  });
}

async function getAllJobs(limit = 50) {
  const jobs = await readJobs();

  return jobs
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}

module.exports = {
  createPendingJob,
  getJobById,
  getPendingJobs,
  getRunnableJobs,
  updateJob,
  markStatus,
  mergeJobResult,
  incrementAttempts,
  setLastError,
  markStageFailed,
  markProcessing,
  markFailed,
  markCompleted,
  getAllJobs
};