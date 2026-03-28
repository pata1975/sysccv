require('dotenv').config();

const express = require('express');
const mlService = require('./services/mlibre');
const tnService = require('./services/tnube');

const app = express();
app.use(express.json());

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
  if (!sku) return;

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
  res.sendStatus(200);

  const { resource, topic } = req.body || {};
  if (!resource || !['items', 'stock-locations'].includes(topic)) return;

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
    console.error('[ML webhook] Error:', error.response?.data || error.message);
  }
});

app.post('/webhooks/tn', async (req, res) => {
  res.sendStatus(200);

  const productId = req.body?.id;
  if (!productId) return;

  try {
    const product = await tnService.getTNProductById(productId);
    if (!product?.variants?.length) {
      console.warn(`[TN webhook] Producto ${productId} sin variantes.`);
      return;
    }

    for (const variant of product.variants) {
      await syncTnVariantToML(variant);
    }
  } catch (error) {
    console.error('[TN webhook] Error:', error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de sincronización corriendo en puerto ${PORT}`);
});
