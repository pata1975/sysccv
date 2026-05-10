const express = require('express');
const invoiceJobService = require('../invoicing/invoiceJob.service');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const payload = req.body || {};

    const result = await invoiceJobService.createPendingJob({
      source: 'mercadolibre',
      payload
    });

    return res.status(200).json({
      ok: true,
      created: result.created,
      jobId: result.job.id,
      status: result.job.status
    });
  } catch (error) {
    console.error('[mercadolibre webhook] error creating invoice job', error);

    return res.status(500).json({
      ok: false,
      error: 'Could not create invoice job'
    });
  }
});

module.exports = router;