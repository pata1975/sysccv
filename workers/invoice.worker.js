const invoiceJobService = require('../invoicing/invoiceJob.service');
const mercadolibreInvoiceService = require('../invoicing/mercadolibreInvoice.service');

async function runInvoiceWorker() {
  const runnableJobs = await invoiceJobService.getRunnableJobs(5);

  if (runnableJobs.length === 0) {
    console.log('[invoice worker] No runnable jobs');
    return;
  }

  for (const job of runnableJobs) {
    try {
      console.log(`[invoice worker] Processing job ${job.id}`, {
        status: job.status,
        attempts: job.attempts || 0
      });

      await mercadolibreInvoiceService.processInvoiceJob(job);

      const updatedJob = await invoiceJobService.getJobById(job.id);

      console.log(`[invoice worker] Finished job ${job.id}`, {
        status: updatedJob?.status || null
      });
    } catch (error) {
      console.error(`[invoice worker] Failed job ${job.id}`, {
        message: error?.message,
        status: error?.response?.status || null,
        data: error?.response?.data || null,
        code: error?.code || null
      });

      await invoiceJobService.setLastError(job.id, error);
    }
  }
}

if (require.main === module) {
  runInvoiceWorker()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('[invoice worker] Fatal error', {
        message: error?.message,
        status: error?.response?.status || null,
        data: error?.response?.data || null,
        code: error?.code || null
      });

      process.exit(1);
    });
}

module.exports = {
  runInvoiceWorker
};