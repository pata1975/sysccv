const axios = require('axios');

function getHeaders() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': process.env.TN_USER_AGENT || 'ML-TN-Sync (chatgpt-debug)'
  };
}

function cleanSku(value) {
  return value == null ? null : String(value).trim();
}

function normalizeVariant(variant, productId) {
  return {
    product_id: productId,
    variant_id: variant.id,
    stock: variant.stock,
    sku: cleanSku(variant.sku),
  };
}

async function getTNProductBySKU(sku) {
  try {
    const targetSku = cleanSku(sku);
    if (!targetSku) return null;

    const res = await axios.get(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products`, {
      params: { q: targetSku },
      headers: getHeaders(),
      timeout: 30000,
    });

    if (!Array.isArray(res.data) || res.data.length === 0) {
      console.log(`[TN lookup] getTNProductBySKU sin resultados para ${JSON.stringify(targetSku)}.`);
      return null;
    }

    for (const product of res.data) {
      const variant = (product.variants || []).find((v) => cleanSku(v.sku) === targetSku);
      if (variant) {
        return {
          productId: product.id,
          variantId: variant.id,
          stock: variant.stock,
        };
      }
    }

    console.log(`[TN lookup] getTNProductBySKU sin match exacto para ${JSON.stringify(targetSku)}.`, {
      productsCount: res.data.length,
      sampleSkus: res.data.flatMap((p) => (p.variants || []).map((v) => cleanSku(v.sku))).filter(Boolean).slice(0, 15),
    });
    return null;
  } catch (err) {
    console.error('❌ Error TN:', err.response?.data || err.message);
    return null;
  }
}

async function updateTNStock(productId, variantId, stock) {
  try {
    await axios.put(
      `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${productId}/variants/${variantId}`,
      { stock: parseInt(stock, 10) },
      { headers: getHeaders(), timeout: 30000 }
    );
    return true;
  } catch (err) {
    console.error('❌ Error API Tiendanube (Update):', err.response?.data || err.message);
    throw err;
  }
}

async function getTNProductById(id) {
  try {
    const res = await axios.get(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${id}`, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const variants = (res.data?.variants || []).map((v) => ({
      sku: cleanSku(v.sku),
      stock: parseInt(v.stock || 0, 10),
    }));

    console.log(`[TN lookup] Producto ${id} -> variantes leídas:`, variants.map((v) => ({ sku: v.sku, stock: v.stock })));
    return variants;
  } catch (err) {
    console.error(`❌ Error TN [${id}]:`, err.response?.data || err.message);
    return null;
  }
}

async function getTNVariantBySKU(sku) {
  const targetSku = cleanSku(sku);
  if (!targetSku) return null;

  console.log('[TN lookup] buscando SKU exacto:', JSON.stringify(targetSku));

  // Intento exacto por endpoint específico
  try {
    const res = await axios.get(
      `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/sku/${encodeURIComponent(targetSku)}`,
      { headers: getHeaders(), timeout: 30000 }
    );

    const product = res.data;
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    console.log('[TN lookup] /products/sku respondió.', {
      productId: product?.id,
      variants: variants.map((v) => cleanSku(v.sku)).filter(Boolean),
    });

    const variant = variants.find((v) => cleanSku(v.sku) === targetSku);
    if (variant) {
      console.log('[TN lookup] match exacto por /products/sku.', {
        targetSku,
        productId: product.id,
        variantId: variant.id,
      });
      return normalizeVariant(variant, product.id);
    }
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn('[TN lookup] Error en /products/sku:', err.response?.data || err.message);
    } else {
      console.log('[TN lookup] /products/sku devolvió 404 para:', JSON.stringify(targetSku));
    }
  }

  // Fallback por listado
  try {
    const res = await axios.get(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products`, {
      headers: getHeaders(),
      timeout: 30000,
    });

    const products = Array.isArray(res.data) ? res.data : [];
    const sampleSkus = [];

    for (const product of products) {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      for (const v of variants) {
        const candidateSku = cleanSku(v.sku);
        if (candidateSku) sampleSkus.push(candidateSku);
        if (candidateSku === targetSku) {
          console.log('[TN lookup] match exacto por listado.', {
            targetSku,
            productId: product.id,
            variantId: v.id,
          });
          return normalizeVariant(v, product.id);
        }
      }
    }

    console.warn('[TN lookup] sin match exacto en Tiendanube.', {
      targetSku,
      productsCount: products.length,
      sampleSkus: sampleSkus.slice(0, 25),
    });
    return null;
  } catch (err) {
    console.error('❌ Error TN getTNVariantBySKU:', err.response?.data || err.message);
    return null;
  }
}

async function updateTNVariantStock(productId, variantId, stock) {
  return axios.put(
    `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${productId}/variants/${variantId}`,
    { stock: parseInt(stock, 10) },
    { headers: getHeaders(), timeout: 30000 }
  );
}

async function syncToTiendanube(sku, newStock) {
  try {
    const targetStock = parseInt(newStock, 10);
    const variantData = await getTNVariantBySKU(sku);

    if (!variantData) {
      console.warn(`[TN-SERVICE] SKU ${sku} no hallado en la tienda.`);
      return null;
    }

    console.log(`[TN-SERVICE] Actualizando SKU ${sku} -> Stock: ${targetStock}`);
    await updateTNVariantStock(variantData.product_id, variantData.variant_id, targetStock);
    return true;
  } catch (err) {
    console.error(`[TN-SERVICE] Error en syncToTiendanube para SKU ${sku}:`, err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  getTNProductBySKU,
  updateTNStock,
  getTNProductById,
  getTNVariantBySKU,
  updateTNVariantStock,
  syncToTiendanube,
};
