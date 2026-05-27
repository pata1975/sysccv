require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const api = axios.create({
  baseURL: 'https://api.mercadolibre.com',
  timeout: 30000,
});

let refreshPromise = null;
let currentAccessToken = process.env.ML_ACCESS_TOKEN || null;
let currentRefreshToken = process.env.ML_REFRESH_TOKEN || null;
let invalidRefreshToken = null;

function resolveTokenStorePath() {
  if (process.env.ML_TOKEN_STORE_PATH) return process.env.ML_TOKEN_STORE_PATH;
  if (fs.existsSync('/data')) return '/data/ml_tokens.json';
  return path.join(process.cwd(), '.ml_tokens.json');
}

const tokenStorePath = resolveTokenStorePath();
console.log('[ML auth] tokenStorePath =', tokenStorePath);

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTokenStore() {
  try {
    if (!fs.existsSync(tokenStorePath)) {
      console.log('[ML auth] token store no existe todavía:', tokenStorePath);
      return null;
    }

    const raw = fs.readFileSync(tokenStorePath, 'utf8');
    if (!raw.trim()) {
      console.log('[ML auth] token store existe pero está vacío:', tokenStorePath);
      return null;
    }

    const data = JSON.parse(raw);
    const normalized = {
      accessToken: data?.accessToken || data?.ML_ACCESS_TOKEN || data?.access_token || null,
      refreshToken: data?.refreshToken || data?.ML_REFRESH_TOKEN || data?.refresh_token || null,
      updatedAt: data?.updatedAt || null,
    };

    console.log('[ML auth] token store leído OK:', {
      tokenStorePath,
      hasAccessToken: !!normalized.accessToken,
      hasRefreshToken: !!normalized.refreshToken,
      updatedAt: normalized.updatedAt,
    });

    return normalized;
  } catch (error) {
    console.warn('[ML auth] No se pudo leer el store persistente de tokens:', error.message);
    return null;
  }
}

function persistTokensToStore(accessToken, refreshToken) {
  if (!accessToken && !refreshToken) return;

  try {
    ensureParentDir(tokenStorePath);
    const payload = {
      accessToken: accessToken || currentAccessToken || null,
      refreshToken: refreshToken || currentRefreshToken || null,
      updatedAt: new Date().toISOString(),
    };
    const tmpPath = `${tokenStorePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, tokenStorePath);

    console.log('[ML auth] token store persistido OK:', {
      tokenStorePath,
      hasAccessToken: !!payload.accessToken,
      hasRefreshToken: !!payload.refreshToken,
      updatedAt: payload.updatedAt,
    });
  } catch (error) {
    console.warn('[ML auth] No se pudo persistir el store de tokens:', error.message);
  }
}

function setCurrentTokens(accessToken, refreshToken, options = {}) {
  const prevRefresh = currentRefreshToken || process.env.ML_REFRESH_TOKEN || null;

  if (accessToken) {
    currentAccessToken = accessToken;
    process.env.ML_ACCESS_TOKEN = accessToken;
  }

  if (refreshToken) {
    currentRefreshToken = refreshToken;
    process.env.ML_REFRESH_TOKEN = refreshToken;
  }

  const newRefresh = currentRefreshToken || process.env.ML_REFRESH_TOKEN || null;
  if (newRefresh && newRefresh !== prevRefresh) {
    invalidRefreshToken = null;
  }

  if (options.persistStore) {
    persistTokensToStore(accessToken, refreshToken);
  }

  if (options.persistEnvFile) {
    try {
      persistTokensToEnvFile(accessToken || currentAccessToken, refreshToken || currentRefreshToken);
    } catch (error) {
      console.warn('[ML auth] No se pudieron persistir los tokens en el .env:', error.message);
    }
  }
}

function loadTokensFromStore(options = {}) {
  const stored = readTokenStore();
  if (!stored) return null;

  const shouldApply =
    options.preferStore ||
    !currentAccessToken ||
    !currentRefreshToken ||
    stored.refreshToken !== currentRefreshToken ||
    stored.accessToken !== currentAccessToken;

  if (shouldApply) {
    setCurrentTokens(stored.accessToken, stored.refreshToken);
    if (!options.silent) {
      console.log('[ML auth] Tokens cargados desde store persistente.', {
        hasAccessToken: !!stored.accessToken,
        hasRefreshToken: !!stored.refreshToken,
        updatedAt: stored.updatedAt || null,
        tokenStorePath,
      });
    }
  }

  return stored;
}

loadTokensFromStore({ preferStore: true, silent: true });

function getAuthHeaders(token = currentAccessToken || process.env.ML_ACCESS_TOKEN) {
  return { Authorization: `Bearer ${token}` };
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

function isAvailableQuantityNotModifiableError(error) {
  const data = error?.response?.data;
  const causes = Array.isArray(data?.cause) ? data.cause : [];
  return (
    error?.response?.status === 400 &&
    (causes.some((cause) => cause?.cause_id === 240) ||
      /available_quantity is not modifiable/i.test(data?.message || '') ||
      /available_quantity is not modifiable/i.test(causes.map((c) => c?.message).join(' | ')))
  );
}

function pickUserProductStockTargets(stockResponse) {
  const locations = Array.isArray(stockResponse?.raw?.locations) ? stockResponse.raw.locations : [];
  const sellerWarehouses = locations.filter((location) => location?.type === 'seller_warehouse');
  const sellingAddresses = locations.filter((location) => location?.type === 'selling_address');

  const targets = [];

  for (const location of sellerWarehouses) {
    targets.push({
      type: 'seller_warehouse',
      network_node_id: location?.network_node_id || null,
      store_id: location?.store_id || null,
      currentQuantity: toInt(location?.quantity, 0),
    });
  }

  for (const location of sellingAddresses) {
    targets.push({
      type: 'selling_address',
      network_node_id: null,
      store_id: null,
      currentQuantity: toInt(location?.quantity, 0),
    });
  }

  return targets;
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
  const stored = loadTokensFromStore({ preferStore: true, silent: false });

  let refreshTokenInState = currentRefreshToken || null;

  if (!refreshTokenInState && !stored) {
    refreshTokenInState = process.env.ML_REFRESH_TOKEN || null;
    console.warn('[ML auth] usando refresh token desde process.env porque no existe store todavía');
  }

  if (!refreshTokenInState) {
    throw new Error('No hay refresh token disponible ni en memoria ni en store ni en process.env');
  }
  if (invalidRefreshToken && refreshTokenInState && invalidRefreshToken === refreshTokenInState) {
    throw createMlReauthError({ response: { data: { error: 'invalid_grant' } } });
  }

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const clientId = process.env.ML_CLIENT_ID;
    const clientSecret = process.env.ML_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Faltan ML_CLIENT_ID o ML_CLIENT_SECRET en el .env');
    }

    const runRefresh = async (refreshToken) => {
      if (!refreshToken) {
        throw new Error('Falta ML_REFRESH_TOKEN. Tenés que reautorizar la app y volver a cargar tokens válidos.');
      }

      console.log('[ML auth] intentando refresh con token disponible:', {
        source: refreshToken === currentRefreshToken ? 'memory_or_store' : 'fallback',
        tokenStorePath,
        hasRefreshToken: !!refreshToken,
      });

      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);
      params.append('refresh_token', refreshToken);

      const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
      });

      setCurrentTokens(data.access_token, data.refresh_token, {
        persistStore: true,
        persistEnvFile: process.env.ML_PERSIST_TO_ENV_FILE === 'true',
      });

      console.log('[ML auth] Token renovado correctamente.', {
        tokenStorePath,
        persistedToStore: true,
        persistedToEnvFile: process.env.ML_PERSIST_TO_ENV_FILE === 'true',
      });

      return data.access_token;
    };

    const firstRefreshToken = currentRefreshToken || process.env.ML_REFRESH_TOKEN || null;

    try {
      return await runRefresh(firstRefreshToken);
    } catch (error) {
      if (!isInvalidGrantError(error)) throw error;

      const previousRefreshToken = firstRefreshToken;
      const stored = loadTokensFromStore({ preferStore: true, silent: true });
      const fallbackRefreshToken = stored?.refreshToken || currentRefreshToken || process.env.ML_REFRESH_TOKEN || null;

      if (fallbackRefreshToken && fallbackRefreshToken !== previousRefreshToken) {
        console.warn('[ML auth] El refresh token actual fue rechazado. Se reintenta con el último token persistido en el store.', {
          tokenStorePath,
        });
        return await runRefresh(fallbackRefreshToken);
      }

      invalidRefreshToken = previousRefreshToken;
      throw createMlReauthError(error);
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

async function getOrderById(orderId) {
  if (!orderId) {
    throw new Error('No se recibió orderId para getOrderById');
  }

  const { data } = await mlRequest({
    method: 'GET',
    url: `/orders/${orderId}`
  });

  return data;
}

async function getOrderBillingInfo(orderId) {
  if (!orderId) {
    throw new Error('No se recibió orderId para getOrderBillingInfo');
  }

  const { data } = await mlRequest({
    method: 'GET',
    url: `/orders/${orderId}/billing_info`
  });

  return data;
}

function normalizeOrderItemForInvoice(orderItem) {
  const quantity = Number(orderItem?.quantity || 0);
  const unitPrice = Number(orderItem?.unit_price || 0);

  return {
    itemId: orderItem?.item?.id || null,
    title: orderItem?.item?.title || 'Producto sin título',
    sku:
      orderItem?.item?.seller_sku ||
      orderItem?.item?.seller_custom_field ||
      null,
    quantity,
    unitPrice,
    total: quantity * unitPrice,
    raw: orderItem
  };
}

function normalizeMercadoLibreOrderForInvoice(order, billingInfo = null) {
  const parsedBillingInfo = parseBillingInfo(billingInfo);

  const items = Array.isArray(order?.order_items)
    ? order.order_items.map(normalizeOrderItemForInvoice)
    : [];

  const totalFromItems = items.reduce((acc, item) => acc + item.total, 0);

  return {
    orderId: order?.id ? String(order.id) : null,
    packId: order?.pack_id ? String(order.pack_id) : null,
    status: order?.status || null,
    dateCreated: order?.date_created || null,
    dateClosed: order?.date_closed || null,
    currency: order?.currency_id || 'ARS',

    total: Number(order?.total_amount || totalFromItems || 0),
    paidAmount: Number(order?.paid_amount || 0),

    buyerName:
      parsedBillingInfo.fullName ||
      [order?.buyer?.first_name, order?.buyer?.last_name]
        .filter(Boolean)
        .join(' ') ||
      'Consumidor final',

    buyerDocumentType: parsedBillingInfo.documentType,
    buyerDocumentNumber: parsedBillingInfo.documentNumber,
    buyerTaxTypeCode: parsedBillingInfo.taxTypeCode,
    buyerTaxpayerType: parsedBillingInfo.taxpayerType,
    buyerTaxContributor: parsedBillingInfo.taxContributor,

    buyerAddress: {
      streetName: parsedBillingInfo.streetName,
      streetNumber: parsedBillingInfo.streetNumber,
      city: parsedBillingInfo.city,
      stateCode: parsedBillingInfo.stateCode,
      stateName: parsedBillingInfo.stateName,
      zipCode: parsedBillingInfo.zipCode,
      countryId: parsedBillingInfo.countryId,
      comment: parsedBillingInfo.comment
    },

    buyerId: order?.buyer?.id || null,
    buyerNickname: order?.buyer?.nickname || null,

    billingInfo,
    parsedBillingInfo,
    items,
    raw: order
  };
}

async function getOrderForInvoice(orderId) {
  const order = await getOrderById(orderId);

  let billingInfo = null;

  try {
    billingInfo = await getOrderBillingInfo(orderId);
  } catch (error) {
    console.warn('[ML invoice] No se pudo obtener billing_info de la orden.', {
      orderId,
      message: error?.response?.data || error?.message || error
    });
  }

  return normalizeMercadoLibreOrderForInvoice(order, billingInfo);
}

function parseBillingInfo(billingInfo) {
  const additionalInfo =
    billingInfo?.billing_info?.additional_info ||
    billingInfo?.additional_info ||
    [];

  const byType = {};

  for (const item of additionalInfo) {
    if (item?.type) {
      byType[item.type] = item.value || null;
    }
  }

  const firstName = byType.FIRST_NAME || null;
  const lastName = byType.LAST_NAME || null;

  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' ') || null,

    documentType:
      billingInfo?.billing_info?.doc_type ||
      billingInfo?.doc_type ||
      byType.DOC_TYPE ||
      null,

    documentNumber:
      billingInfo?.billing_info?.doc_number ||
      billingInfo?.doc_number ||
      byType.DOC_NUMBER ||
      null,

    taxTypeCode: byType.TAX_TYPE || null,
    taxpayerType: byType.TAXPAYER_TYPE_ID || null,
    taxContributor: byType.TAX_CONTRIBUTOR || null,

    city: byType.CITY_NAME || null,
    streetName: byType.STREET_NAME || null,
    streetNumber: byType.STREET_NUMBER || null,
    stateCode: byType.STATE_CODE || null,
    stateName: byType.STATE_NAME || null,
    zipCode: byType.ZIP_CODE || null,
    countryId: byType.COUNTRY_ID || null,
    comment: byType.COMMENT || null
  };
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


function resolveUserProductIdFromItem(item, targetSku = null) {
  if (!item || typeof item !== 'object') return null;

  if (item.user_product_id) return item.user_product_id;

  const cleanTarget = cleanSku(targetSku);
  const variations = Array.isArray(item.variations) ? item.variations : [];

  if (cleanTarget && variations.length) {
    for (const variation of variations) {
      const variationSku = extractSkuFromAnyKnownShape(variation);
      if (variationSku && variationSku === cleanTarget && variation.user_product_id) {
        return variation.user_product_id;
      }
    }
  }

  for (const variation of variations) {
    if (variation?.user_product_id) return variation.user_product_id;
  }

  return null;
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

async function updateUserProductStockTarget(userProductId, stockResponse, target, newStock) {
  if (!userProductId) {
    throw new Error('No se recibió userProductId para updateUserProductStockTarget');
  }

  const xVersion = stockResponse?.xVersion;
  if (!xVersion) {
    throw new Error(`No se recibió x-version para actualizar stock del user product ${userProductId}`);
  }

  const payload = { quantity: toInt(newStock, 0) };

  if (target?.type === 'seller_warehouse') {
    if (target?.network_node_id) payload.network_node_id = target.network_node_id;
    if (target?.store_id) payload.store_id = target.store_id;
  }

  await mlRequest({
    method: 'PUT',
    url: `/user-products/${userProductId}/stock/type/${target.type}`,
    headers: {
      'x-version': xVersion,
      'Content-Type': 'application/json',
    },
    data: payload,
  });
}

async function updateMLStockViaNewModel(target, newStock) {
  let userProductId = target?.userProductId || null;

  if (!userProductId) {
    const item = await getItem(target?.itemId || target);

    if (target?.variationId && Array.isArray(item?.variations)) {
      const variation = item.variations.find((row) => row?.id === target.variationId);
      userProductId = variation?.user_product_id || null;
    }

    if (!userProductId) {
      userProductId = resolveUserProductIdFromItem(item, target?.sku || null);
    }

    if (!userProductId && item?.id) {
      console.error('[ML stock] No se pudo determinar user_product_id desde /items.', {
        itemId: item.id,
        targetSku: target?.sku || null,
        hasRootUserProductId: !!item?.user_product_id,
        variationsCount: Array.isArray(item?.variations) ? item.variations.length : 0,
        variationHints: Array.isArray(item?.variations)
          ? item.variations.slice(0, 20).map((variation) => ({
              id: variation?.id || null,
              sku: extractSkuFromAnyKnownShape(variation),
              user_product_id: variation?.user_product_id || null,
            }))
          : [],
      });
    }
  }

  if (!userProductId) {
    throw new Error('No se pudo determinar user_product_id para actualizar stock con el modelo nuevo de Mercado Libre');
  }

  const stockResponse = await getUserProductStock(userProductId);
  const targets = pickUserProductStockTargets(stockResponse);

  if (!targets.length) {
    throw new Error(`El user product ${userProductId} no devolvió stock_locations compatibles para actualizar stock por el modelo nuevo`);
  }

  const orderedTargets = [
    ...targets.filter((target) => target.type === 'seller_warehouse'),
    ...targets.filter((target) => target.type === 'selling_address'),
  ];

  const errors = [];

  for (const stockTarget of orderedTargets) {
    try {
      await updateUserProductStockTarget(userProductId, stockResponse, stockTarget, newStock);
      console.warn('[ML stock] stock actualizado por el modelo nuevo de User Products.', {
        userProductId,
        type: stockTarget.type,
        network_node_id: stockTarget.network_node_id || null,
        store_id: stockTarget.store_id || null,
        newStock: toInt(newStock, 0),
      });
      return;
    } catch (error) {
      errors.push({
        type: stockTarget.type,
        network_node_id: stockTarget.network_node_id || null,
        store_id: stockTarget.store_id || null,
        message: error?.response?.data || error?.message || error,
      });
    }
  }

  const details = {
    userProductId,
    stockLocations: orderedTargets,
    errors,
  };

  const err = new Error(`No se pudo actualizar el stock del user product ${userProductId} con la ruta nueva de Mercado Libre`);
  err.details = details;
  throw err;
}

async function updateMLStock(target, newStock) {
  if (!target) throw new Error('No se recibió target para updateMLStock');

  try {
    if (typeof target === 'string') {
      return await updateItemStock(target, newStock);
    }

    if (target.variationId) {
      return await updateVariationStock(target.itemId, target.variationId, newStock);
    }

    if (target.itemId) {
      return await updateItemStock(target.itemId, newStock);
    }
  } catch (error) {
    if (!isAvailableQuantityNotModifiableError(error)) {
      throw error;
    }

    console.warn('[ML stock] available_quantity no es modificable por /items. Se intenta fallback con User Products.', {
      itemId: typeof target === 'string' ? target : target?.itemId || null,
      variationId: typeof target === 'string' ? null : target?.variationId || null,
      userProductId: typeof target === 'string' ? null : target?.userProductId || null,
      message: error?.response?.data || error?.message || error,
    });

    return updateMLStockViaNewModel(target, newStock);
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

async function getMLData(id) {
  if (!id) return null;

  if (typeof getStockEntriesFromResource === 'function') {
    const entries = await getStockEntriesFromResource(id);
    return Array.isArray(entries) && entries.length ? entries[0] : null;
  }

  if (typeof executeRequest === 'function') {
    return await executeRequest(id, process.env.ML_ACCESS_TOKEN);
  }

  throw new Error('No hay ninguna implementación compatible para getMLData');
}

function resolveFiscalDocumentTargetId(order) {
  if (!order) {
    return null;
  }

  return order.packId || order.orderId || null;
}

async function uploadFiscalDocumentToPack(packId, filePath) {
  if (!packId) {
    throw new Error('No se recibió packId/orderId para uploadFiscalDocumentToPack');
  }

  if (!filePath) {
    throw new Error('No se recibió filePath para uploadFiscalDocumentToPack');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`No existe el PDF a subir: ${filePath}`);
  }

  const form = new FormData();

  form.append('fiscal_document', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'application/pdf'
  });

  const { data } = await mlRequest({
    method: 'POST',
    url: `/packs/${packId}/fiscal_documents`,
    data: form,
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return data;
}

async function getFiscalDocumentsFromPack(packId) {
  if (!packId) {
    throw new Error('No se recibió packId/orderId para getFiscalDocumentsFromPack');
  }

  const { data } = await mlRequest({
    method: 'GET',
    url: `/packs/${packId}/fiscal_documents`
  });

  return data;
}

async function getMLAuthenticatedUserDebug() {
  const { data } = await mlRequest({
    method: 'GET',
    url: '/users/me'
  });

  return {
    id: data?.id,
    nickname: data?.nickname,
    site_id: data?.site_id,
    status: data?.status
  };
}

module.exports = {
  refreshMLToken,

  getOrderById,
  getOrderBillingInfo,
  getOrderForInvoice,

  uploadFiscalDocumentToPack,
  getFiscalDocumentsFromPack,
  resolveFiscalDocumentTargetId,

  getStockEntriesFromResource,
  getStockEntriesFromItemId,
  getStockEntriesFromUserProductId,
  findMLPublicationBySKU,
  updateMLStock,
  updateMLStockViaNewModel,
  executeRequest,
  findMLItemBySKU,
  getMLData,
  getMLAuthenticatedUserDebug
  };
