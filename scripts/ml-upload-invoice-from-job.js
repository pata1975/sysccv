require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const mlibreService = require('../services/mlibre');

const JOBS_FILE = path.join(__dirname, '..', 'data', 'invoiceJobs.json');

async function readJobs() {
  const raw = await fs.readFile(JOBS_FILE, 'utf8');
  return JSON.parse(raw);
}

function findJob(jobs, requestedId) {
  if (!requestedId) {
    return jobs
      .filter((job) => job.status === 'invoiced_mock' && job.result?.pdfFilePath)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  }

  return jobs.find((job) => {
    return (
      job.id === requestedId ||
      job.orderId === requestedId ||
      job.result?.orderId === requestedId
    );
  });
}

function assertUploadAllowed(job) {
  if (process.env.ML_UPLOAD_INVOICE_TO_ML !== 'true') {
    throw new Error(
      'Subida desactivada. Para subir a MercadoLibre configurá ML_UPLOAD_INVOICE_TO_ML=true'
    );
  }

  const environment = job?.result?.fiscalInvoice
    ? job?.result?.environment
    : null;

  const invoiceEnvironment =
    job?.result?.arcaResult ? process.env.ARCA_ENV : 'mock';

  const isProductionInvoice =
    invoiceEnvironment === 'production' ||
    job?.result?.environment === 'production';

  if (!isProductionInvoice && process.env.ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD !== 'true') {
    throw new Error(
      'El comprobante no parece ser de producción. No se sube a MercadoLibre. Si realmente querés probarlo, configurá ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD=true.'
    );
  }
}

async function main() {
  const requestedId = process.argv[2] || null;
  const jobs = await readJobs();
  const job = findJob(jobs, requestedId);

  if (!job) {
    throw new Error(
      requestedId
        ? `No se encontró job para ${requestedId}`
        : 'No se encontró ningún job facturado con PDF'
    );
  }

  if (!job.result?.pdfFilePath) {
    throw new Error(`El job ${job.id} no tiene pdfFilePath`);
  }

  const targetId =
    job.result.packId ||
    job.result.orderId ||
    job.orderId;

  if (!targetId) {
    throw new Error(`No se pudo determinar packId/orderId para ${job.id}`);
  }

  console.log('[ML upload invoice] Preparando subida', {
    jobId: job.id,
    orderId: job.orderId,
    targetId,
    pdfFilePath: job.result.pdfFilePath
  });

  assertUploadAllowed(job);

  const result = await mlibreService.uploadFiscalDocumentToPack(
    targetId,
    job.result.pdfFilePath
  );

  console.log('[ML upload invoice] Resultado:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[ML upload invoice] Error:', {
    message: error?.message,
    status: error?.response?.status || null,
    data: error?.response?.data || null,
    code: error?.code || null
  });

  process.exit(1);
});
