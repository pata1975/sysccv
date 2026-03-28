require('dotenv').config();

const axios = require('axios');

const baseURL = `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}`;

function getHeaders() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'User-Agent': process.env.TN_USER_AGENT || 'ML-TN Sync (dev@example.com)',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function cleanSku(value) {
  return value == null ? null : String(value).trim();
}

function normalizeVariant(variant, productId) {
  return {
    product_id: productId ?? variant.product_id,
    variant_id: variant.id,
    sku: cleanSku(variant.sku),
    stock: variant.stock,
    updated_at: variant.updated_at || null,
    inventory_levels: Array.isArray(variant.inventory_levels) ? variant.inventory_levels : [],
  };
}

async function getTNProductById(productId) {
  const { data } = await axios.get(`${baseURL}/products/${productId}`, {
    headers: getHeaders(),
    timeout: 30000,
  });

  return {
    id: data.id,
    variants: Array.isArray(data.variants)
      ? data.variants.map((variant) => normalizeVariant(variant, data.id))
      : [],
  };
}

async function getTNVariantBySKU(rawSku) {
  const sku = cleanSku(rawSku);
  if (!sku) return null;

  const { data } = await axios.get(`${baseURL}/products/sku/${encodeURIComponent(sku)}`, {
    headers: getHeaders(),
    timeout: 30000,
  });

  if (!data?.id || !Array.isArray(data?.variants)) return null;

  const variant = data.variants.find((v) => cleanSku(v.sku) === sku);
  if (!variant) return null;

  return normalizeVariant(variant, data.id);
}

async function updateTNVariantStock(productId, variantId, stock) {
  const payload = { stock: Number.isFinite(Number(stock)) ? Number(stock) : 0 };

  const { data } = await axios.put(
    `${baseURL}/products/${productId}/variants/${variantId}`,
    payload,
    {
      headers: getHeaders(),
      timeout: 30000,
    }
  );

  return data;
}

module.exports = {
  getTNProductById,
  getTNVariantBySKU,
  updateTNVariantStock,
};
