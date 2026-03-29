require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const api = axios.create({
  baseURL: 'https://api.mercadolibre.com',
  timeout: 30000,
});

let refreshPromise = null;
let refreshTokenInvalid = false;
let currentAccessToken = process.env.ML_ACCESS_TOKEN || null;
let currentRefreshToken = process.env.ML_REFRESH_TOKEN || null;

function getAuthHeaders(token = currentAccessToken || process.env.ML_ACCESS_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

function setCurrentTokens(accessToken, refreshToken) {
  if (accessToken) {
    currentAccessToken = accessToken;
    process.env.ML_ACCESS_TOKEN = accessToken;
  }

  if (refreshToken) {
    currentRefreshToken = refreshToken;
    process.env.ML_REFRESH_TOKEN = refreshToken;
    refreshTokenInvalid = false;
  }
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanSku(value) {
  return value == null ? null : String(value).trim();
}

function extractMlId(resource) {
  return String(resource || '').match(/ML[A-Z]{1,5}\d+/)?.[0] || null;
}

function extractSellerSkuFromAttributes(attributes = []) {
  if (!Array.isArray(attributes)) return null;

  const attr = attributes.find((a) => a?.id === 'SELLER_SKU' || a?.name === 'SELLER_SKU');
  if (!attr) return null;

  return cleanSku(
    attr?.value_name ||
      attr?.values?.[0]?.name ||
      attr?.values?.[0]?.value_name ||
      attr?.value_id ||
      null
  );
}

function extractSkuFromAnyKnownShape(entity) {
  if (!entity || typeof entity !== 'object') return null;

  return (
    cleanSku(entity?.seller_custom_field) ||
    cleanSku(entity?.seller_sku) ||
    extractSellerSkuFromAttributes(entity?.attributes) ||
    extractSellerSkuFromAttributes(entity?.variation_attributes) ||
    extractSellerSkuFromAttributes(entity?.sale_terms) ||
    null
  );
}

function sumStockFromLocations(locations = []) {
  if (!Array.isArray(locations)) return 0;

  return locations.reduce((acc, location) => {
    return acc + toInt(location?.quantity ?? location?.available_quantity ?? location?.sellable_quantity, 0);
  }, 0);
}

function dedupeEntries(entries) {
  const seen = new Set();

  return entries.filter((entry) => {
    const key = `${entry?.sku || ''}|${entry?.itemId || ''}|${entry?.variationId || ''}|${entry?.userProductId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractItemIdsFromSearch(data) {
  const results = Array.isArray(data?.results) ? data.results : [];

  return [
    ...new Set(
      results
        .map((r) => {
          if (typeof r === 'string') return r.trim();
          if (r && typeof r === 'object' && r.id) return String(r.id).trim();
          return null;
        })
        .filter(Boolean)
    ),
  ];
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function persistTokensToEnvFile(accessToken, refreshToken) {
  const envPath = process.env.ML_ENV_FILE || path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  let content = fs.readFileSync(envPath, 'utf8');

  const upsert = (text, key, value) => {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(text)) return text.replace(pattern, `${key}=${value}`);
    return `${text.trim()}\n${key}=${value}\n`;
  };

  content = upsert(content, 'ML_ACCESS_TOKEN', accessToken);
  content = upsert(content, 'ML_REFRESH_TOKEN', refreshToken);

  fs.writeFileSync(envPath, content, 'utf8');
}

function isInvalidGrantError(error) {
  const data = error?.response?.data;
  return data?.error === 'invalid_grant';
}

function createMlReauthError(originalError) {
  const message = 'Mercado Libre rechazó el refresh token (invalid_grant). Tenés que reautorizar la app y actualizar ML_ACCESS_TOKEN y ML_REFRESH_TOKEN.';
  const err = new Error(message);
  err.code = 'ML_REAUTH_REQUIRED';
  err.original = originalError?.response?.data || originalError?.message || originalError;
  return err;
}

async function refreshMLToken() {
  if (refreshTokenInvalid) {
    throw createMlReauthError({ response: { data: { error: 'invalid_grant' } } });
  }

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const clientId = process.env.ML_CLIENT_ID;
    const clientSecret = process.env.ML_CLIENT_SECRET;
    const refreshToken = currentRefreshToken || process.env.ML_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Faltan ML_CLIENT_ID, ML_CLIENT_SECRET o ML_REFRESH_TOKEN en el .env');
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('refresh_token', refreshToken);

    try {
      const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
      });

      setCurrentTokens(data.access_token, data.refresh_token);

      try {
        persistTokensToEnvFile(data.access_token, data.refresh_token);
      } catch (error) {
        console.warn('[ML auth] No se pudieron persistir los tokens en el .env:', error.message);
      }

      console.log('[ML auth] Token renovado correctamente.');
      return data.access_token;
    } catch (error) {
      if (isInvalidGrantError(error)) {
        refreshTokenInvalid = true;
        throw createMlReauthError(error);
      }
      throw error;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function mlRequest(config, { retry = true } = {}) {
  try {
    const headers = {
      ...(config.headers || {}),
      ...getAuthHeaders(),
    };

    return await api.request({ ...config, headers });
  } catch (error) {
    if (retry && error.response?.status === 401) {
      await refreshMLToken();
      return mlRequest(config, { retry: false });
    }
    throw error;
  }
}

async function getItem(itemId) {
  const { data } = await mlRequest({ method: 'GET', url: `/items/${itemId}` });
  return data;
}

async function getUserProduct(userProductId) {
  const { data } = await mlRequest({ method: 'GET', url: `/user-products/${userProductId}` });
  return data;
}

async function getUserProductStock(userProductId) {
  const response = await mlRequest({ method: 'GET', url: `/user-products/${userProductId}/stock` });
  const body = response.data || {};
  const locations = Array.isArray(body?.locations) ? body.locations : [];

  const candidates = [
    toInt(body?.available_quantity, NaN),
    toInt(body?.total_reportable_quantity, NaN),
    toInt(body?.sellable_quantity, NaN),
    sumStockFromLocations(locations),
  ];

  const stock = candidates.find((n) => Number.isFinite(n));

  return {
    stock: Number.isFinite(stock) ? stock : 0,
    raw: body,
    xVersion: response.headers['x-version'] || null,
  };
}

async function searchItemIdsByParams(params) {
  const { data } = await mlRequest({
    method: 'GET',
    url: `/users/${process.env.ML_USER_ID}/items/search`,
    params,
  });

  return extractItemIdsFromSearch(data);
}

async function multigetItemsByIds(itemIds, attributes = null) {
  const ids = Array.isArray(itemIds) ? itemIds.filter(Boolean) : [];
  if (!ids.length) return [];

  const groups = chunk(ids, 20);
  const results = [];

  for (const group of groups) {
    const params = { ids: group.join(',') };
    if (attributes) params.attributes = attributes;

    const { data } = await mlRequest({
      method: 'GET',
      url: '/items',
      params,
    });

    if (Array.isArray(data)) results.push(...data);
  }

  return results;
}

async function getItemIdsByUserProductId(userProductId) {
  try {
    const directIds = await searchItemIdsByParams({ user_product_id: userProductId });
    if (directIds.length > 0) {
      return directIds;
    }
  } catch (error) {
    console.warn('[ML user-product] Falló búsqueda directa por user_product_id.', {
      userProductId,
      message: error.code === 'ML_REAUTH_REQUIRED' ? error.message : error.response?.data || error.message,
    });
    throw error;
  }

  try {
    const fallbackIds = await searchItemIdsByParams({ product_id: userProductId });
    if (fallbackIds.length > 0) {
      console.warn('[ML user-product] Se resolvió por fallback con product_id.', {
        userProductId,
        itemIdsCount: fallbackIds.length,
      });
      return fallbackIds;
    }
  } catch (error) {
    console.warn('[ML user-product] Falló fallback por product_id.', {
      userProductId,
      message: error.code === 'ML_REAUTH_REQUIRED' ? error.message : error.response?.data || error.message,
    });
    throw error;
  }

  return [];
}

function mapItemToEntries(item) {
  const baseUserProductId = item?.user_product_id || null;
  const itemLevelSku = extractSkuFromAnyKnownShape(item);

  if (Array.isArray(item?.variations) && item.variations.length > 0) {
    return item.variations
      .map((variation) => ({
        sku: extractSkuFromAnyKnownShape(variation) || itemLevelSku,
        stock: toInt(variation?.available_quantity, 0),
        itemId: item.id,
        variationId: variation.id,
        userProductId: variation?.user_product_id || baseUserProductId,
      }))
      .filter((entry) => entry.sku);
  }

  if (!itemLevelSku) return [];

  return [
    {
      sku: itemLevelSku,
      stock: toInt(item?.available_quantity, 0),
      itemId: item.id,
      variationId: null,
      userProductId: baseUserProductId,
    },
  ];
}

async function getStockEntriesFromItemId(itemId) {
  const item = await getItem(itemId);
  return mapItemToEntries(item);
}

async function getStockEntriesFromUserProductId(userProductId) {
  const [userProduct, itemIds, userProductStock] = await Promise.all([
    getUserProduct(userProductId).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return null;
    }),
    getItemIdsByUserProductId(userProductId).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return [];
    }),
    getUserProductStock(userProductId).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return null;
    }),
  ]);

  let entries = [];

  if (itemIds.length) {
    const rows = await multigetItemsByIds(
      itemIds,
      'id,user_product_id,available_quantity,seller_custom_field,attributes,variations'
    ).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return [];
    });

    for (const row of rows) {
      if (row?.code !== 200 || !row?.body) continue;
      const itemEntries = mapItemToEntries(row.body);
      entries.push(
        ...itemEntries.filter((entry) => !entry.userProductId || entry.userProductId === userProductId)
      );
    }
  }

  if (!entries.length && userProduct?.item_id) {
    const fallbackEntries = await getStockEntriesFromItemId(userProduct.item_id).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return [];
    });
    entries.push(...fallbackEntries);
  }

  if (!entries.length) {
    const userProductSku = extractSkuFromAnyKnownShape(userProduct);
    if (userProductSku) {
      entries.push({
        sku: userProductSku,
        stock: toInt(userProductStock?.stock, 0),
        itemId: userProduct?.item_id || itemIds[0] || null,
        variationId: null,
        userProductId,
      });
    }
  }

  if (userProductStock) {
    entries = entries.map((entry) => ({
      ...entry,
      stock: userProductStock.stock,
    }));
  }

  entries = dedupeEntries(entries);

  if (!entries.length) {
    console.warn('[ML user-product] No se pudo mapear el user-product a SKU/item.', {
      userProductId,
      itemIds,
      userProductItemId: userProduct?.item_id || null,
      userProductSku: extractSkuFromAnyKnownShape(userProduct),
      stockShape: userProductStock?.raw ? Object.keys(userProductStock.raw) : [],
      userProductShape: userProduct ? Object.keys(userProduct) : [],
    });
  } else {
    console.log('[ML user-product] items/search resuelto', {
      userProductId,
      itemIdsCount: itemIds.length,
      firstItemIds: itemIds.slice(0, 5),
      entries: entries.map((e) => ({
        sku: e.sku,
        itemId: e.itemId,
        variationId: e.variationId,
        stock: e.stock,
      })),
    });
  }

  return entries;
}

async function getStockEntriesFromResource(resource) {
  const mlId = extractMlId(resource);
  if (!mlId) return [];

  if (mlId.startsWith('MLAU')) {
    return getStockEntriesFromUserProductId(mlId);
  }

  return getStockEntriesFromItemId(mlId);
}

async function findMLPublicationBySKU(rawSku) {
  const sku = cleanSku(rawSku);
  if (!sku) return null;

  console.log('[ML lookup] buscando SKU exacto:', JSON.stringify(sku));
  const searches = [{ seller_sku: sku }, { sku }];
  const tried = [];

  for (const params of searches) {
    const itemIds = await searchItemIdsByParams(params).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return [];
    });

    console.log('[ML lookup] items/search resultado.', {
      params,
      itemIdsCount: itemIds.length,
      firstItemIds: itemIds.slice(0, 10),
    });

    if (!itemIds.length) {
      tried.push({ params, itemIdsCount: 0, sampleSkus: [] });
      continue;
    }

    if (params.seller_sku && itemIds.length === 1) {
      const directMatch = await executeRequest(itemIds[0]).catch((error) => {
        if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
        return null;
      });

      if (directMatch) {
        console.log('[ML lookup] match directo por seller_sku con único candidato.', {
          sku,
          itemId: directMatch.itemId,
          variationId: directMatch.variationId,
          stock: directMatch.stock,
        });
        return directMatch;
      }

      console.warn('[ML lookup] seller_sku devolvió un único itemId, pero no se pudo reconstruir el SKU desde el detalle. Se usa igual el item como fallback.', {
        sku,
        itemId: itemIds[0],
      });

      return {
        sku,
        itemId: itemIds[0],
        variationId: null,
        stock: 0,
      };
    }

    const rows = await multigetItemsByIds(
      itemIds,
      'id,user_product_id,available_quantity,seller_custom_field,attributes,variations'
    ).catch((error) => {
      if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
      return [];
    });

    const sampleSkus = [];

    for (const row of rows) {
      if (row?.code !== 200 || !row?.body) continue;
      const entries = mapItemToEntries(row.body);
      for (const entry of entries) {
        if (entry?.sku) sampleSkus.push(entry.sku);
      }
      const match = entries.find((entry) => entry.sku === sku);
      if (match) {
        console.log('[ML lookup] match exacto en Mercado Libre.', {
          sku,
          itemId: match.itemId,
          variationId: match.variationId,
          stock: match.stock,
        });
        return match;
      }
    }

    if (itemIds.length === 1) {
      console.warn('[ML lookup] un solo candidato en Mercado Libre; se usa como fallback aunque no haya match exacto por parsing.', {
        sku,
        itemId: itemIds[0],
      });

      const fallbackMatch = await executeRequest(itemIds[0]).catch((error) => {
        if (error?.code === 'ML_REAUTH_REQUIRED') throw error;
        return null;
      });

      if (fallbackMatch) {
        return {
          ...fallbackMatch,
          sku,
        };
      }

      return {
        sku,
        itemId: itemIds[0],
        variationId: null,
        stock: 0,
      };
    }

    tried.push({ params, itemIdsCount: itemIds.length, sampleSkus: sampleSkus.slice(0, 25) });
  }

  console.warn('[ML lookup] sin match exacto en Mercado Libre.', {
    sku,
    tried,
  });
  return null;
}

async function updateVariationStock(itemId, variationId, newStock) {
  const item = await getItem(itemId);
  const variations = Array.isArray(item?.variations) ? item.variations : [];
  if (!variations.length) {
    throw new Error(`El item ${itemId} no tiene variaciones.`);
  }

  const payload = {
    variations: variations.map((variation) => ({
      id: variation.id,
      available_quantity:
        variation.id === variationId
          ? toInt(newStock, 0)
          : toInt(variation.available_quantity, 0),
    })),
  };

  await mlRequest({
    method: 'PUT',
    url: `/items/${itemId}`,
    data: payload,
  });
}

async function updateItemStock(itemId, newStock) {
  await mlRequest({
    method: 'PUT',
    url: `/items/${itemId}`,
    data: { available_quantity: toInt(newStock, 0) },
  });
}

async function updateMLStock(target, newStock) {
  if (!target) throw new Error('No se recibió target para updateMLStock');

  if (typeof target === 'string') {
    return updateItemStock(target, newStock);
  }

  if (target.variationId) {
    return updateVariationStock(target.itemId, target.variationId, newStock);
  }

  if (target.itemId) {
    return updateItemStock(target.itemId, newStock);
  }

  throw new Error('No se pudo determinar itemId/variationId para actualizar stock en Mercado Libre');
}

async function executeRequest(idOrResource) {
  const raw = String(idOrResource || '');
  if (!raw) return null;

  let resource = raw;
  if (!raw.includes('/')) {
    resource = raw.startsWith('MLAU') ? `/user-products/${raw}` : `/items/${raw}`;
  }

  const entries = await getStockEntriesFromResource(resource);
  return entries[0] || null;
}

async function findMLItemBySKU(rawSku) {
  const match = await findMLPublicationBySKU(rawSku);
  return match?.itemId || null;
}

module.exports = {
  refreshMLToken,
  getStockEntriesFromResource,
  getStockEntriesFromItemId,
  getStockEntriesFromUserProductId,
  findMLPublicationBySKU,
  updateMLStock,
  executeRequest,
  findMLItemBySKU,
};
