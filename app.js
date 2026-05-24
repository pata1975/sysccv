require('dotenv').config();

const express = require('express');
const mlService = require('./services/mlibre');
const tnService = require('./services/tnube');
const mercadolibreWebhookRoutes = require('./routes/mercadolibreWebhook.routes');
const app = express();
const invoiceJobService = require('./invoicing/invoiceJob.service');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/webhooks/mercadolibre', mercadolibreWebhookRoutes);
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

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

  const mlItemId = await mlService.findMLItemBySKU(sku, process.env.ML_ACCESS_TOKEN);
  console.log('[TN -> ML] resultado búsqueda ML:', mlItemId);

  if (!mlItemId) {
    console.warn(`[TN -> ML] SKU ${sku} no encontrado en Mercado Libre.`);
    return;
  }

  const mlData = await mlService.executeRequest(mlItemId, process.env.ML_ACCESS_TOKEN);
  console.log('[TN -> ML] detalle item ML:', mlData);

  const mlStock = normalizeStock(mlData?.stock);
  console.log('[TN -> ML] comparación stocks:', { sku, tnStock, mlStock, mlItemId });

  if (tnStock === mlStock) {
    console.log(`[TN -> ML] SKU ${sku} ya está sincronizado en ${tnStock}.`);
    return;
  }

  const updated = await mlService.updateMLStock(mlItemId, tnStock, process.env.ML_ACCESS_TOKEN);
  console.log('[TN -> ML] resultado updateMLStock:', updated);

  if (!updated) {
    console.warn(`[TN -> ML] La actualización de SKU ${sku} no fue confirmada por Mercado Libre.`);
    return;
  }

  console.log(`[TN -> ML] SKU ${sku} sincronizado ${mlStock} -> ${tnStock}.`);
}

app.post('/webhooks/ml', async (req, res) => {
  console.log('[ML webhook] entró');
  console.log('[ML webhook] content-type:', req.headers['content-type']);
  console.log('[ML webhook] query:', req.query);
  console.log('[ML webhook] body:', req.body);

  const invoiceEvent = req.body || {};
const invoiceTopic = invoiceEvent.topic || req.query.topic || null;
const invoiceResource = invoiceEvent.resource || req.query.resource || null;

if (
  invoiceTopic === 'orders_v2' &&
  typeof invoiceResource === 'string' &&
  invoiceResource.includes('/orders/')
) {
  const result = await invoiceJobService.createPendingJob({
    source: 'mercadolibre',
    payload: {
      ...invoiceEvent,
      topic: invoiceTopic,
      resource: invoiceResource
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
}

  if (!resource || !['items', 'stock-locations', 'user-products'].includes(topic)) {
    console.log('[ML webhook] Evento ignorado:', { topic, resource });
    return;
  }

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
      console.log('[TN webhook] procesando variante:', variant);

      try {
        await syncTnVariantToML(variant);
        console.log('[TN webhook] variante procesada OK:', variant?.sku);
      } catch (err) {
        console.error('[TN webhook] error procesando variante:', {
          sku: variant?.sku,
          error: err?.response?.data || err?.message || err,
        });
      }
    }
  } catch (error) {
    console.error('[TN webhook] Error general:', error.response?.data || error.message || error);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
