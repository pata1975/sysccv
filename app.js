require('dotenv').config();

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const mlService = require('./services/mlibre');
const tnService = require('./services/tnube');
const mercadolibreWebhookRoutes = require('./routes/mercadolibreWebhook.routes');
const invoiceJobService = require('./invoicing/invoiceJob.service');
const mercadolibreInvoiceService = require('./invoicing/mercadolibreInvoice.service');
const pdfService = require('./invoicing/pdf.service');
const { runInvoiceWorker } = require('./workers/invoice.worker');
const arcaWsfeService = require('./invoicing/arcaWsfe.service');

const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

app.use('/webhooks/mercadolibre', mercadolibreWebhookRoutes);

function normalizeStock(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getErrorPreview(error, maxLength = 1000) {
  const rawData = error?.response?.data;
  if (typeof rawData === 'string') return rawData.slice(0, maxLength);
  return rawData || null;
}

function extractMlIdFromResource(resource) {
  if (!resource || typeof resource !== 'string') return null;

  const parts = resource.split('/').filter(Boolean);
  if (!parts.length) return null;

  const itemIdx = parts.findIndex((p) => p === 'items');
  if (itemIdx >= 0 && parts[itemIdx + 1]) return parts[itemIdx + 1];

  const upIdx = parts.findIndex((p) => p === 'user-products');
  if (upIdx >= 0 && parts[upIdx + 1]) return parts[upIdx + 1];

  return null;
}

function isDebugEnabled() {
  return process.env.DEBUG_INVOICE_JOBS === 'true';
}

function requireDebug(req, res) {
  if (!isDebugEnabled()) {
    res.status(404).json({ ok: false });
    return false;
  }
  return true;
}

function checkInvoiceAdminAuth(req, res) {
  const expectedToken = process.env.INVOICE_ADMIN_TOKEN;

  if (!expectedToken) {
    res.status(404).json({ ok: false });
    return false;
  }

  const receivedToken = req.headers['x-invoice-admin-token'];

  if (receivedToken !== expectedToken) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return false;
  }

  return true;
}

function summarizeJob(job) {
  return {
    id: job.id,
    status: job.status,
    orderId: job.orderId,
    attempts: job.attempts || 0,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    lastError: job.lastError || null,

    hasInvoice: !!job.result?.invoice || !!job.result?.cae,
    pointOfSale: job.result?.invoice?.pointOfSale || job.result?.pointOfSale || null,
    invoiceNumber: job.result?.invoice?.invoiceNumber || job.result?.invoiceNumber || null,
    cae: job.result?.invoice?.cae || job.result?.cae || null,
    caeDueDate: job.result?.invoice?.caeDueDate || job.result?.caeDueDate || null,
    issuedAt: job.result?.invoice?.issuedAt || job.result?.issuedAt || null,

    hasPdf: !!job.result?.pdf?.filePath || !!job.result?.pdfFilePath,
    pdfFileName: job.result?.pdf?.fileName || job.result?.pdfFileName || null,
    pdfFilePath: job.result?.pdf?.filePath || job.result?.pdfFilePath || null,

    uploadedToMercadoLibre: !!job.result?.mercadoLibreUpload?.uploadedAt,
    mercadoLibreUploadTargetId: job.result?.mercadoLibreUpload?.targetId || null
  };
}

async function syncMlEntryToTN(entry) {
  if (!entry?.sku) {
    console.warn('[ML -> TN] Entrada sin SKU. Se omite.', entry);
    return;
  }

  const cleanSku = String(entry.sku).trim();
  console.log(`[ML -> TN] Buscando SKU en Tiendanube: ${JSON.stringify(cleanSku)}`);

  const tnVariant = await tnService.getTNVariantBySKU(cleanSku);

  if (!tnVariant) {
    console.warn(`[ML -> TN] SKU ${cleanSku} no encontrado en Tiendanube.`);
    return;
  }

  const mlStock = normalizeStock(entry.stock);
  const tnStock = normalizeStock(tnVariant.stock);

  if (mlStock === tnStock) {
    console.log(`[ML -> TN] SKU ${cleanSku} ya está sincronizado en ${mlStock}.`);
    return;
  }

  await tnService.updateTNVariantStock(tnVariant.product_id, tnVariant.variant_id, mlStock);
  console.log(`[ML -> TN] SKU ${cleanSku} sincronizado ${tnStock} -> ${mlStock}.`);
}

async function syncTnVariantToML(variant) {
  const sku = variant?.sku ? String(variant.sku).trim() : null;
  console.log('[TN -> ML] variante recibida:', variant);
  console.log('[TN -> ML] sku normalizado:', sku);

  if (!sku) {
    console.warn('[TN -> ML] variante sin SKU, se omite');
    return;
  }

  const tnStock = normalizeStock(variant.stock);
  console.log('[TN -> ML] stock Tiendanube:', tnStock);
  console.log(`[TN -> ML] Buscando SKU en Mercado Libre: ${JSON.stringify(sku)}`);

  const mlTarget = await mlService.findMLPublicationBySKU(sku);
  console.log('[TN -> ML] resultado búsqueda ML:', mlTarget);

  if (!mlTarget) {
    console.warn(`[TN -> ML] SKU ${sku} no encontrado en Mercado Libre.`);
    return;
  }

  const mlStock = normalizeStock(mlTarget.stock);
  console.log('[TN -> ML] comparación stocks:', {
    sku,
    tnStock,
    mlStock,
    itemId: mlTarget.itemId || null,
    variationId: mlTarget.variationId || null,
    userProductId: mlTarget.userProductId || null
  });

  if (tnStock === mlStock) {
    console.log(`[TN -> ML] SKU ${sku} ya está sincronizado en ${tnStock}.`);
    return;
  }

  await mlService.updateMLStock(mlTarget, tnStock);
  console.log(`[TN -> ML] SKU ${sku} sincronizado ${mlStock} -> ${tnStock}.`);
}

let invoiceWorkerRunning = false;

async function runInvoiceWorkerSafely(context = 'manual') {
  if (invoiceWorkerRunning) {
    console.log('[invoice worker] Previous run still active. Skipping.', { context });
    return;
  }

  invoiceWorkerRunning = true;

  try {
    await runInvoiceWorker();
  } catch (error) {
    console.error('[invoice worker] Error', {
      context,
      message: error?.message,
      status: error?.response?.status || null,
      data: getErrorPreview(error),
      code: error?.code || null
    });
  } finally {
    invoiceWorkerRunning = false;
  }
}

function startInvoiceWorkerScheduler() {
  if (process.env.INVOICE_WORKER_ENABLED !== 'true') {
    console.log('[invoice worker scheduler] Disabled');
    return;
  }

  const intervalMs = Number(process.env.INVOICE_WORKER_INTERVAL_MS || 300000);

  console.log('[invoice worker scheduler] Enabled', { intervalMs });

  setTimeout(() => {
    runInvoiceWorkerSafely('startup-delay');
  }, 10000);

  setInterval(() => {
    runInvoiceWorkerSafely('interval');
  }, intervalMs);
}

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/debug/config', async (req, res) => {
  if (!requireDebug(req, res)) return;

  return res.json({
    ok: true,
    nodeEnv: process.env.NODE_ENV || null,
    invoiceWorkerEnabled: process.env.INVOICE_WORKER_ENABLED === 'true',
    mlUploadInvoiceToMl: process.env.ML_UPLOAD_INVOICE_TO_ML === 'true',
    invoiceDataDir: process.env.INVOICE_DATA_DIR || null,
    invoicePdfDir: process.env.INVOICE_PDF_DIR || null,
    arcaEnv: process.env.ARCA_ENV || null,
    arcaPointOfSale: process.env.ARCA_POINT_OF_SALE || null,
    arcaInvoiceType: process.env.ARCA_INVOICE_TYPE || null,
    mlUserIdConfigured: process.env.ML_USER_ID || null,
    mlTokenStorePath: process.env.ML_TOKEN_STORE_PATH || null,
    tnUserIdConfigured: process.env.TN_USER_ID || null,
    hasTnAccessToken: !!process.env.TN_ACCESS_TOKEN,
    tnTokenLooksLikeMercadoLibre: String(process.env.TN_ACCESS_TOKEN || '').startsWith('APP_USR-')
  });
});

app.get('/debug/invoice-jobs', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const jobs = typeof invoiceJobService.getAllJobs === 'function'
      ? await invoiceJobService.getAllJobs(50)
      : await invoiceJobService.getRunnableJobs(50);

    return res.json({
      ok: true,
      count: jobs.length,
      jobs: jobs.map(summarizeJob)
    });
  } catch (error) {
    console.error('[debug invoice jobs] Error:', { message: error?.message, code: error?.code || null });
    return res.status(500).json({ ok: false, error: 'Could not read invoice jobs' });
  }
});

app.get('/debug/ml-config', async (req, res) => {
  if (!requireDebug(req, res)) return;

  return res.json({
    ok: true,
    mlUserIdConfigured: process.env.ML_USER_ID || null,
    hasClientId: !!process.env.ML_CLIENT_ID,
    hasClientSecret: !!process.env.ML_CLIENT_SECRET,
    hasAccessToken: !!process.env.ML_ACCESS_TOKEN,
    hasRefreshToken: !!process.env.ML_REFRESH_TOKEN,
    tokenStorePath: process.env.ML_TOKEN_STORE_PATH || null
  });
});

app.get('/debug/ml-me', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const data = await mlService.getMLAuthenticatedUserDebug();
    return res.json({ ok: true, user: data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      contentType: error?.response?.headers?.['content-type'] || null,
      dataPreview: getErrorPreview(error, 1000),
      code: error?.code || null
    });
  }
});

app.get('/debug/ml-me-direct', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const accessToken = String(process.env.ML_ACCESS_TOKEN || '').trim();

    if (!accessToken) {
      return res.status(500).json({ ok: false, error: 'ML_ACCESS_TOKEN no configurado' });
    }

    const response = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      },
      timeout: 30000
    });

    return res.json({
      ok: true,
      user: {
        id: response.data?.id,
        nickname: response.data?.nickname,
        site_id: response.data?.site_id,
        status: response.data?.status
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      contentType: error?.response?.headers?.['content-type'] || null,
      dataPreview: getErrorPreview(error, 1000),
      code: error?.code || null
    });
  }
});

app.get('/debug/ml-order-raw/:orderId', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const data = await mlService.getOrderById(req.params.orderId);

    return res.json({
      ok: true,
      order: {
        id: data?.id,
        status: data?.status,
        pack_id: data?.pack_id || null,
        seller: data?.seller ? { id: data.seller.id, nickname: data.seller.nickname } : null,
        buyer: data?.buyer ? { id: data.buyer.id, nickname: data.buyer.nickname } : null,
        total_amount: data?.total_amount,
        order_items_count: Array.isArray(data?.order_items) ? data.order_items.length : 0
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      step: 'getOrderById',
      message: error?.message,
      status: error?.response?.status || null,
      contentType: error?.response?.headers?.['content-type'] || null,
      dataPreview: getErrorPreview(error, 1000),
      code: error?.code || null
    });
  }
});

app.get('/debug/ml-order-billing/:orderId', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const data = await mlService.getOrderBillingInfo(req.params.orderId);
    return res.json({ ok: true, hasBillingInfo: !!data, keys: data && typeof data === 'object' ? Object.keys(data) : [] });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      step: 'getOrderBillingInfo',
      message: error?.message,
      status: error?.response?.status || null,
      contentType: error?.response?.headers?.['content-type'] || null,
      dataPreview: getErrorPreview(error, 1000),
      code: error?.code || null
    });
  }
});

app.get('/debug/tn-config', async (req, res) => {
  if (!requireDebug(req, res)) return;

  return res.json({
    ok: true,
    hasAccessToken: !!process.env.TN_ACCESS_TOKEN,
    userIdConfigured: process.env.TN_USER_ID || null,
    userAgent: process.env.TN_USER_AGENT || 'SysCcv Corre con Ventaja',
    tokenLooksLikeMercadoLibre: String(process.env.TN_ACCESS_TOKEN || '').startsWith('APP_USR-')
  });
});

app.get('/debug/tn-products', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const products = await tnService.getTNProductsDebug();

    return res.json({
      ok: true,
      count: Array.isArray(products) ? products.length : null,
      firstProduct: Array.isArray(products) && products.length
        ? {
            id: products[0].id,
            name: products[0].name,
            variantsCount: Array.isArray(products[0].variants) ? products[0].variants.length : null
          }
        : null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      contentType: error?.response?.headers?.['content-type'] || null,
      dataPreview: getErrorPreview(error, 1000),
      code: error?.code || null
    });
  }
});

app.get('/debug/tn-product/:productId', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const variants = await tnService.getTNProductById(req.params.productId);
    return res.json({ ok: true, variants });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      dataPreview: getErrorPreview(error),
      code: error?.code || null
    });
  }
});

app.get('/debug/tn-sku/:sku', async (req, res) => {
  if (!requireDebug(req, res)) return;

  try {
    const variant = await tnService.getTNVariantBySKU(req.params.sku);
    return res.json({ ok: true, found: !!variant, variant });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      dataPreview: getErrorPreview(error),
      code: error?.code || null
    });
  }
});

app.get('/debug/arca-last', async (req, res) => {
  if (process.env.DEBUG_ARCA_CHECKS !== 'true') {
    return res.status(404).json({ ok: false });
  }

  try {
    const pointOfSale = Number(process.env.ARCA_POINT_OF_SALE || 1);
    const invoiceType = Number(process.env.ARCA_INVOICE_TYPE || 11);

    const result = await arcaWsfeService.feCompUltimoAutorizado({ pointOfSale, invoiceType });

    return res.json({
      ok: true,
      env: process.env.ARCA_ENV || null,
      cuitConfigured: !!process.env.ARCA_CUIT,
      pointOfSale,
      invoiceType,
      result
    });
  } catch (error) {
    console.error('[debug arca last] Error:', {
      message: error?.message,
      status: error?.response?.status || null,
      data: getErrorPreview(error),
      details: error?.details || null
    });

    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      data: getErrorPreview(error, 2000),
      details: error?.details || null
    });
  }
});

app.post('/admin/invoice-jobs/:jobId/status', async (req, res) => {
  if (!checkInvoiceAdminAuth(req, res)) return;

  try {
    const { jobId } = req.params;
    const { status } = req.body || {};

    if (!status) {
      return res.status(400).json({ ok: false, error: 'Missing status' });
    }

    const job = await invoiceJobService.markStatus(jobId, status);
    return res.json({ ok: true, job: summarizeJob(job) });
  } catch (error) {
    console.error('[admin invoice jobs] Error changing status:', { message: error?.message, code: error?.code || null });
    return res.status(500).json({ ok: false, error: error?.message || 'Could not update job status' });
  }
});

app.post('/admin/invoice-jobs/:jobId/process', async (req, res) => {
  if (!checkInvoiceAdminAuth(req, res)) return;

  try {
    const { jobId } = req.params;
    const job = await invoiceJobService.getJobById(jobId);

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    await mercadolibreInvoiceService.processInvoiceJob(job);
    const updatedJob = await invoiceJobService.getJobById(jobId);
    return res.json({ ok: true, job: summarizeJob(updatedJob) });
  } catch (error) {
    console.error('[admin invoice jobs] Error processing job:', {
      message: error?.message,
      status: error?.response?.status || null,
      data: getErrorPreview(error),
      code: error?.code || null,
      details: error?.details || null
    });

    return res.status(500).json({
      ok: false,
      error: error?.message || 'Could not process job',
      status: error?.response?.status || null,
      data: getErrorPreview(error, 2000),
      details: error?.details || null
    });
  }
});

app.post('/admin/invoice-jobs/:jobId/regenerate-pdf', async (req, res) => {
  if (!checkInvoiceAdminAuth(req, res)) return;

  try {
    const { jobId } = req.params;
    const job = await invoiceJobService.getJobById(jobId);

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    const result = job.result || {};
    const order = result.order;
    const invoice = result.invoice || (
      result.cae && result.invoiceNumber
        ? {
            environment: process.env.ARCA_ENV || 'production',
            invoiceType: result.invoiceType || 'C',
            invoiceTypeCode: result.invoiceTypeCode || 11,
            pointOfSale: result.pointOfSale,
            invoiceNumber: result.invoiceNumber,
            cae: result.cae,
            caeDueDate: result.caeDueDate,
            issuedAt: result.issuedAt,
            currency: result.currency || 'ARS',
            total: result.total || 0
          }
        : null
    );

    if (!invoice?.cae || !invoice?.invoiceNumber) {
      return res.status(400).json({ ok: false, error: 'Job has no authorized invoice. Refusing to regenerate PDF.' });
    }

    if (!order) {
      return res.status(400).json({ ok: false, error: 'Job has no persisted order data. Cannot regenerate PDF safely.' });
    }

    const pdf = await pdfService.createInvoicePdfMock({ job, order, invoice });
    await invoiceJobService.mergeJobResult(job.id, {
      pdf: {
        fileName: pdf.fileName,
        filePath: pdf.filePath,
        generatedAt: new Date().toISOString()
      },
      pdfFileName: pdf.fileName,
      pdfFilePath: pdf.filePath
    });

    const updatedJob = await invoiceJobService.markStatus(job.id, 'pdf_generated');
    return res.json({ ok: true, job: summarizeJob(updatedJob) });
  } catch (error) {
    console.error('[admin invoice jobs] Error regenerating PDF:', { message: error?.message, code: error?.code || null });
    return res.status(500).json({ ok: false, error: error?.message || 'Could not regenerate PDF' });
  }
});

app.get('/admin/invoice-jobs/:jobId/pdf', async (req, res) => {
  if (!checkInvoiceAdminAuth(req, res)) return;

  try {
    const { jobId } = req.params;
    const job = await invoiceJobService.getJobById(jobId);

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    const filePath = job.result?.pdf?.filePath || job.result?.pdfFilePath || null;
    const fileName = job.result?.pdf?.fileName || job.result?.pdfFileName || `factura-${job.id}.pdf`;

    if (!filePath) {
      return res.status(404).json({ ok: false, error: 'Job has no PDF file path' });
    }

    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ ok: false, error: 'Invalid PDF file name' });
    }

    await fs.access(filePath);
    return res.download(filePath, fileName);
  } catch (error) {
    return res.status(404).json({ ok: false, error: error?.message || 'Invoice PDF not found' });
  }
});

app.get('/admin/invoices', async (req, res) => {
  if (!checkInvoiceAdminAuth(req, res)) return;

  try {
    const invoicesDir = process.env.INVOICE_PDF_DIR || path.join(__dirname, 'data', 'invoices');
    await fs.mkdir(invoicesDir, { recursive: true });
    const files = await fs.readdir(invoicesDir);
    const pdfs = files.filter((file) => file.toLowerCase().endsWith('.pdf')).sort().reverse();

    return res.json({ ok: true, invoicesDir, count: pdfs.length, files: pdfs });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Could not list invoices' });
  }
});

app.get('/admin/invoices/:fileName', async (req, res) => {
  if (!checkInvoiceAdminAuth(req, res)) return;

  try {
    const invoicesDir = process.env.INVOICE_PDF_DIR || path.join(__dirname, 'data', 'invoices');
    const fileName = path.basename(req.params.fileName);
    const filePath = path.join(invoicesDir, fileName);

    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ ok: false, error: 'Only PDF files are allowed' });
    }

    await fs.access(filePath);
    return res.download(filePath, fileName);
  } catch (error) {
    return res.status(404).json({ ok: false, error: error?.message || 'Invoice PDF not found' });
  }
});

app.post('/webhooks/ml', async (req, res) => {
  console.log('[ML webhook] entró');
  console.log('[ML webhook] content-type:', req.headers['content-type']);
  console.log('[ML webhook] query:', req.query);
  console.log('[ML webhook] body:', req.body);

  const event = req.body || {};
  const topic = event.topic || req.query.topic || null;
  const resource = event.resource || req.query.resource || null;

  if (topic === 'orders_v2' && typeof resource === 'string' && resource.includes('/orders/')) {
    try {
      const result = await invoiceJobService.createPendingJob({
        source: 'mercadolibre',
        payload: { ...event, topic, resource }
      });

      console.log('[ML webhook] Invoice job creado o existente:', {
        created: result.created,
        jobId: result.job.id,
        status: result.job.status
      });

      if (process.env.INVOICE_WORKER_ENABLED === 'true') {
        setTimeout(() => runInvoiceWorkerSafely('webhook'), 3000);
      }

      return res.status(200).json({ ok: true, created: result.created, jobId: result.job.id, status: result.job.status });
    } catch (error) {
      console.error('[ML webhook] Error creando invoice job:', { message: error?.message, code: error?.code || null });
      return res.status(500).json({ ok: false, error: 'Could not create invoice job' });
    }
  }

  if (!resource || !['items', 'stock-locations', 'user-products'].includes(topic)) {
    console.log('[ML webhook] Evento ignorado:', { topic, resource });
    return res.sendStatus(200);
  }

  res.sendStatus(200);

  try {
    const mlId = extractMlIdFromResource(resource);

    if (!mlId) {
      console.warn('[ML webhook] No se pudo extraer id desde resource.', { resource, topic });
      return;
    }

    const entry = await mlService.getMLData(mlId);

    if (!entry?.sku) {
      console.warn(`[ML webhook] No se pudieron resolver SKU/stock para ${resource}.`, entry);
      return;
    }

    await syncMlEntryToTN(entry);
  } catch (error) {
    console.error('[ML webhook] Error:', error.response?.data || error.message || error);
  }
});

app.post('/webhooks/tn', async (req, res) => {
  console.log('[TN webhook] entró');
  console.log('[TN webhook] content-type:', req.headers['content-type']);
  console.log('[TN webhook] body:', req.body);

  res.sendStatus(200);

  const productId = req.body?.id;
  const event = req.body?.event;

  if (!productId) {
    console.warn('[TN webhook] sin productId, se ignora');
    return;
  }

  console.log(`[TN webhook] event=${event} productId=${productId}`);

  try {
    const variants = await tnService.getTNProductById(productId);
    console.log('[TN lookup] Producto ' + productId + ' -> variantes leídas:', variants);

    if (!Array.isArray(variants) || !variants.length) {
      console.warn(`[TN webhook] Producto ${productId} sin variantes.`);
      return;
    }

    for (const variant of variants) {
      try {
        await syncTnVariantToML(variant);
        console.log('[TN webhook] variante procesada OK:', variant?.sku);
      } catch (err) {
        console.error('[TN webhook] error procesando variante:', {
          sku: variant?.sku,
          error: err?.response?.data || err?.message || err
        });
      }
    }
  } catch (error) {
    console.error('[TN webhook] Error general:', error.response?.data || error.message || error);
  }
});

startInvoiceWorkerScheduler();

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
