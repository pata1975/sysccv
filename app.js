require('dotenv').config();

const express = require('express');

const mlService = require('./services/mlibre');
const tnService = require('./services/tnube');
const mercadolibreWebhookRoutes = require('./routes/mercadolibreWebhook.routes');
const invoiceJobService = require('./invoicing/invoiceJob.service');
const { runInvoiceWorker } = require('./workers/invoice.worker');
const arcaWsfeService = require('./invoicing/arcaWsfe.service');

const app = express();

app.use(express.json());
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

  await tnService.updateTNVariantStock(
    tnVariant.product_id,
    tnVariant.variant_id,
    mlStock
  );

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

  const mlItemId = await mlService.findMLItemBySKU(sku, process.env.ML_ACCESS_TOKEN);

  console.log('[TN -> ML] resultado búsqueda ML:', mlItemId);

  if (!mlItemId) {
    console.warn(`[TN -> ML] SKU ${sku} no encontrado en Mercado Libre.`);
    return;
  }

  const mlData = await mlService.executeRequest(mlItemId, process.env.ML_ACCESS_TOKEN);

  console.log('[TN -> ML] detalle item ML:', mlData);

  const mlStock = normalizeStock(mlData?.stock);

  console.log('[TN -> ML] comparación stocks:', {
    sku,
    tnStock,
    mlStock,
    mlItemId
  });

  if (tnStock === mlStock) {
    console.log(`[TN -> ML] SKU ${sku} ya está sincronizado en ${tnStock}.`);
    return;
  }

  const updated = await mlService.updateMLStock(
    mlItemId,
    tnStock,
    process.env.ML_ACCESS_TOKEN
  );

  console.log('[TN -> ML] resultado updateMLStock:', updated);

  if (!updated) {
    console.warn(
      `[TN -> ML] La actualización de SKU ${sku} no fue confirmada por Mercado Libre.`
    );
    return;
  }

  console.log(`[TN -> ML] SKU ${sku} sincronizado ${mlStock} -> ${tnStock}.`);
}

app.get('/debug/invoice-jobs', async (req, res) => {
  if (process.env.DEBUG_INVOICE_JOBS !== 'true') {
    return res.status(404).json({ ok: false });
  }

  try {
    const jobs = typeof invoiceJobService.getAllJobs === 'function'
      ? await invoiceJobService.getAllJobs(50)
      : await invoiceJobService.getRunnableJobs(50);

    return res.json({
      ok: true,
      count: jobs.length,
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        orderId: job.orderId,
        attempts: job.attempts || 0,
        updatedAt: job.updatedAt,
        lastError: job.lastError || null,
        hasInvoice: !!job.result?.invoice || !!job.result?.cae,
        hasPdf: !!job.result?.pdf?.filePath || !!job.result?.pdfFilePath,
        uploadedToMercadoLibre: !!job.result?.mercadoLibreUpload?.uploadedAt
      }))
    });
  } catch (error) {
    console.error('[debug invoice jobs] Error:', {
      message: error?.message,
      code: error?.code || null
    });

    return res.status(500).json({
      ok: false,
      error: 'Could not read invoice jobs'
    });
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

  if (
    topic === 'orders_v2' &&
    typeof resource === 'string' &&
    resource.includes('/orders/')
  ) {
    try {
      const result = await invoiceJobService.createPendingJob({
        source: 'mercadolibre',
        payload: {
          ...event,
          topic,
          resource
        }
      });

      console.log('[ML webhook] Invoice job creado o existente:', {
        created: result.created,
        jobId: result.job.id,
        status: result.job.status
      });

      return res.status(200).json({
        ok: true,
        created: result.created,
        jobId: result.job.id,
        status: result.job.status
      });
    } catch (error) {
      console.error('[ML webhook] Error creando invoice job:', {
        message: error?.message,
        code: error?.code || null
      });

      return res.status(500).json({
        ok: false,
        error: 'Could not create invoice job'
      });
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
      console.warn('[ML webhook] No se pudo extraer id desde resource.', {
        resource,
        topic
      });
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
      console.log('[TN webhook] procesando variante:', variant);

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

app.get('/debug/arca-last', async (req, res) => {
  if (process.env.DEBUG_ARCA_CHECKS !== 'true') {
    return res.status(404).json({ ok: false });
  }

  try {
    const pointOfSale = Number(process.env.ARCA_POINT_OF_SALE || 1);
    const invoiceType = Number(process.env.ARCA_INVOICE_TYPE || 11);

    const result = await arcaWsfeService.feCompUltimoAutorizado({
      pointOfSale,
      invoiceType
    });

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
      data: error?.response?.data || null,
      details: error?.details || null
    });

    return res.status(500).json({
      ok: false,
      message: error?.message,
      status: error?.response?.status || null,
      data: error?.response?.data || null,
      details: error?.details || null
    });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

let invoiceWorkerRunning = false;

function startInvoiceWorkerScheduler() {
  if (process.env.INVOICE_WORKER_ENABLED !== 'true') {
    console.log('[invoice worker scheduler] Disabled');
    return;
  }

  const intervalMs = Number(process.env.INVOICE_WORKER_INTERVAL_MS || 300000);

  console.log('[invoice worker scheduler] Enabled', {
    intervalMs
  });

  const runSafely = async () => {
    if (invoiceWorkerRunning) {
      console.log('[invoice worker scheduler] Previous run still active. Skipping.');
      return;
    }

    invoiceWorkerRunning = true;

    try {
      await runInvoiceWorker();
    } catch (error) {
      console.error('[invoice worker scheduler] Error', {
        message: error?.message,
        status: error?.response?.status || null,
        data: error?.response?.data || null,
        code: error?.code || null
      });
    } finally {
      invoiceWorkerRunning = false;
    }
  };

  setTimeout(runSafely, 10000);
  setInterval(runSafely, intervalMs);
}

startInvoiceWorkerScheduler();

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});