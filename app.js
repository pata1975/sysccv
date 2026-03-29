require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('[FATAL uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL unhandledRejection]', reason);
});

const express = require('express');
const mlService = require('./services/mlibre');
const tnService = require('./services/tnube');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.originalUrl}`);
  next();
});

function normalizeStock(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function syncMlEntryToTN(entry) {
  if (!entry?.sku) {
    console.warn('[ML -> TN] Entrada sin SKU. Se omite.', entry);
    return;
  }

  const tnVariant = await tnService.getTNVariantBySKU(entry.sku);
  if (!tnVariant) {
    console.warn(`[ML -> TN] SKU ${entry.sku} no encontrado en Tiendanube.`);
    return;
  }

  const mlStock = normalizeStock(entry.stock);
  const tnStock = normalizeStock(tnVariant.stock);

  if (mlStock === tnStock) {
    console.log(`[ML -> TN] SKU ${entry.sku} ya está sincronizado en ${mlStock}.`);
    return;
  }

  await tnService.updateTNVariantStock(tnVariant.product_id, tnVariant.variant_id, mlStock);
  console.log(`[ML -> TN] SKU ${entry.sku} sincronizado ${tnStock} -> ${mlStock}.`);
}

async function syncTnVariantToML(variant) {
  const sku = variant?.sku ? String(variant.sku).trim() : null;
  if (!sku) {
    console.warn('[TN -> ML] Variante sin SKU. Se omite.', variant);
    return;
  }

  const mlMatch = await mlService.findMLPublicationBySKU(sku);
  if (!mlMatch) {
    console.warn(`[TN -> ML] SKU ${sku} no encontrado en Mercado Libre.`);
    return;
  }

  const tnStock = normalizeStock(variant.stock);
  const mlStock = normalizeStock(mlMatch.stock);

  if (tnStock === mlStock) {
    console.log(`[TN -> ML] SKU ${sku} ya está sincronizado en ${tnStock}.`);
    return;
  }

  await mlService.updateMLStock(mlMatch, tnStock);
  console.log(`[TN -> ML] SKU ${sku} sincronizado ${mlStock} -> ${tnStock}.`);
}

app.post('/webhooks/ml', async (req, res) => {
  console.log('[ML webhook] entró');
  console.log('[ML webhook] content-type:', req.headers['content-type']);
  console.log('[ML webhook] query:', req.query);
  console.log('[ML webhook] body:', req.body);

  res.sendStatus(200);

  const resource = req.body?.resource || req.query?.resource;
  const topic = req.body?.topic || req.query?.topic || req.body?.type;

  if (!resource || !['items', 'stock-locations', 'user-products'].includes(topic)) {
    console.log('[ML webhook] Evento ignorado:', { resource, topic });
    return;
  }

  try {
    const entries = await mlService.getStockEntriesFromResource(resource);
    if (!entries.length) {
      console.warn(`[ML webhook] No se pudieron resolver SKU/stock para ${resource}.`);
      return;
    }

    for (const entry of entries) {
      await syncMlEntryToTN(entry);
    }
  } catch (error) {
    console.error('[ML webhook] Error:', error.response?.data || error.message || error);
  }
});

app.post('/webhooks/tn', async (req, res) => {
  console.log('[TN webhook] entró');
  console.log('[TN webhook] content-type:', req.headers['content-type']);
  console.log('[TN webhook] query:', req.query);
  console.log('[TN webhook] body:', req.body);

  res.sendStatus(200);

  const productId = req.body?.id || req.query?.id;
  if (!productId) {
    console.warn('[TN webhook] ignorado por falta de id.');
    return;
  }

  try {
    const variants = await tnService.getTNProductById(productId);

    if (!Array.isArray(variants) || !variants.length) {
      console.warn(`[TN webhook] Producto ${productId} sin variantes.`);
      return;
    }

    for (const variant of variants) {
      await syncTnVariantToML(variant);
    }
  } catch (error) {
    console.error('[TN webhook] Error:', error.response?.data || error.message || error);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
