const axios = require('axios');

const TN_API_BASE_URL = 'https://api.tiendanube.com/v1';

function getStoreId() {
  const storeId = String(process.env.TN_USER_ID || '').trim();

  if (!storeId) {
    throw new Error('Falta configurar TN_USER_ID');
  }

  return storeId;
}

function getAccessToken() {
  const token = String(process.env.TN_ACCESS_TOKEN || '').trim();

  if (!token) {
    throw new Error('Falta configurar TN_ACCESS_TOKEN');
  }

  if (token.startsWith('APP_USR-')) {
    throw new Error('TN_ACCESS_TOKEN parece ser un token de MercadoLibre. Cargar el token real de Tiendanube.');
  }

  return token;
}

function getHeaders(extra = {}) {
  return {
    Authentication: `bearer ${getAccessToken()}`,
    'User-Agent': process.env.TN_USER_AGENT || 'SysCcv Corre con Ventaja',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...extra
  };
}

function cleanSku(value) {
  return value == null ? null : String(value).trim();
}

function normalizeStock(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeVariant(variant, productId) {
  return {
    product_id: productId,
    variant_id: variant.id,
    productId,
    variantId: variant.id,
    stock: normalizeStock(variant.stock),
    sku: cleanSku(variant.sku),
    raw: variant
  };
}

async function tnRequest(config) {
  return axios.request({
    baseURL: `${TN_API_BASE_URL}/${getStoreId()}`,
    timeout: 30000,
    ...config,
    headers: getHeaders(config.headers || {})
  });
}

async function getTNProductsDebug() {
  const { data } = await tnRequest({
    method: 'GET',
    url: '/products',
    params: { per_page: 1 }
  });

  return data;
}

async function listProducts(params = {}) {
  const { data } = await tnRequest({
    method: 'GET',
    url: '/products',
    params
  });

  return Array.isArray(data) ? data : [];
}

async function getTNProductBySKU(sku) {
  const targetSku = cleanSku(sku);
  if (!targetSku) return null;

  const variant = await getTNVariantBySKU(targetSku);

  if (!variant) return null;

  return {
    productId: variant.product_id,
    variantId: variant.variant_id,
    product_id: variant.product_id,
    variant_id: variant.variant_id,
    stock: variant.stock,
    sku: variant.sku
  };
}

async function getTNProductById(id) {
  const productId = String(id || '').trim();

  if (!productId) {
    throw new Error('No se recibió productId para getTNProductById');
  }

  const { data } = await tnRequest({
    method: 'GET',
    url: `/products/${productId}`
  });

  const variants = (data?.variants || []).map((v) => normalizeVariant(v, data.id || productId));

  console.log(`[TN lookup] Producto ${productId} -> variantes leídas:`,
    variants.map((v) => ({ sku: v.sku, stock: v.stock, product_id: v.product_id, variant_id: v.variant_id }))
  );

  return variants;
}

async function getTNVariantBySKU(sku) {
  const targetSku = cleanSku(sku);
  if (!targetSku) return null;

  console.log('[TN lookup] buscando SKU exacto:', JSON.stringify(targetSku));

  try {
    const { data } = await tnRequest({
      method: 'GET',
      url: `/products/sku/${encodeURIComponent(targetSku)}`
    });

    const product = data;
    const variants = Array.isArray(product?.variants) ? product.variants : [];
    const variant = variants.find((v) => cleanSku(v.sku) === targetSku);

    if (variant) {
      console.log('[TN lookup] match exacto por /products/sku.', {
        targetSku,
        productId: product.id,
        variantId: variant.id
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

  const products = await listProducts({ q: targetSku, per_page: 200 });
  const sampleSkus = [];

  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants : [];

    for (const variant of variants) {
      const candidateSku = cleanSku(variant.sku);
      if (candidateSku) sampleSkus.push(candidateSku);

      if (candidateSku === targetSku) {
        console.log('[TN lookup] match exacto por listado.', {
          targetSku,
          productId: product.id,
          variantId: variant.id
        });
        return normalizeVariant(variant, product.id);
      }
    }
  }

  console.warn('[TN lookup] sin match exacto en Tiendanube.', {
    targetSku,
    productsCount: products.length,
    sampleSkus: sampleSkus.slice(0, 25)
  });

  return null;
}

async function updateTNVariantStock(productId, variantId, stock) {
  if (!productId || !variantId) {
    throw new Error('Faltan productId o variantId para updateTNVariantStock');
  }

  const targetStock = normalizeStock(stock);

  const { data } = await tnRequest({
    method: 'PUT',
    url: `/products/${productId}/variants/${variantId}`,
    data: { stock: targetStock }
  });

  return data;
}

async function updateTNStock(productId, variantId, stock) {
  return updateTNVariantStock(productId, variantId, stock);
}

async function syncToTiendanube(sku, newStock) {
  const targetStock = normalizeStock(newStock);
  const variantData = await getTNVariantBySKU(sku);

  if (!variantData) {
    console.warn(`[TN-SERVICE] SKU ${sku} no hallado en la tienda.`);
    return null;
  }

  console.log(`[TN-SERVICE] Actualizando SKU ${sku} -> Stock: ${targetStock}`);
  await updateTNVariantStock(variantData.product_id, variantData.variant_id, targetStock);
  return true;
}

module.exports = {
  getHeaders,
  getTNProductsDebug,
  getTNProductBySKU,
  updateTNStock,
  getTNProductById,
  getTNVariantBySKU,
  updateTNVariantStock,
  syncToTiendanube
};
