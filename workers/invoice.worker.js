const invoiceJobService = require('../invoicing/invoiceJob.service');
const mercadolibreInvoiceService = require('../invoicing/mercadolibreInvoice.service');

async function runInvoiceWorker() {
  const pendingJobs = await invoiceJobService.getPendingJobs(5);

  if (pendingJobs.length === 0) {
    console.log('[invoice worker] No pending jobs');
    return;
  }

  for (const job of pendingJobs) {
    try {
      console.log(`[invoice worker] Processing job ${job.id}`);

      await invoiceJobService.markProcessing(job.id);

      const result = await mercadolibreInvoiceService.processInvoiceJob(job);

      await invoiceJobService.markCompleted(job.id, result);

      console.log(`[invoice worker] Completed job ${job.id}`);
    } catch (error) {
      console.error(`[invoice worker] Failed job ${job.id}`, error);

      await invoiceJobService.markFailed(job.id, error);
    }
  }
}

if (require.main === module) {
  runInvoiceWorker()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('[invoice worker] Fatal error', error);
      process.exit(1);
    });
}

module.exports = {
  runInvoiceWorker
};