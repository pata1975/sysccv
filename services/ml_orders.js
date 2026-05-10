const axios = require('axios');
const mlService = require('./mlibre');

const BASE_URL = 'https://api.mercadolibre.com';

async function getAccessToken() {
  if (typeof mlService.getAccessToken === 'function') {
    return await mlService.getAccessToken();
  }

  return process.env.ML_ACCESS_TOKEN;
}

async function mlGet(path, { params = {}, headers = {} } = {}) {
  const accessToken = await getAccessToken();

  const { data } = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
    params,
    timeout: 30000,
  });

  return data;
}

function safeString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getOrder(orderId) {
  if (!orderId) throw new Error('orderId es obligatorio');
  return await mlGet(`/orders/${orderId}`);
}

async function getBillingInfo(orderId) {
  if (!orderId) throw new Error('orderId es obligatorio');

  return await mlGet(`/orders/${orderId}/billing_info`, {
    headers: {
      'x-version': '2',
    },
  });
}

function buildInvoiceSeed(order, billingInfo) {
  const buyer = order?.buyer || {};
  const billing = billingInfo?.buyer?.billing_info || billingInfo?.billing_info || {};

  const taxpayerName =
    safeString(billing?.business_name) ||
    [safeString(billing?.name), safeString(billing?.last_name)].filter(Boolean).join(' ') ||
    [safeString(buyer?.first_name), safeString(buyer?.last_name)].filter(Boolean).join(' ') ||
    null;

  const docType =
    safeString(billing?.identification?.type) ||
    safeString(billing?.doc_type) ||
    null;

  const docNumber =
    safeString(billing?.identification?.number) ||
    safeString(billing?.doc_number) ||
    null;

  const ivaConditionId =
    safeString(billing?.taxes?.taxpayer_type?.id) ||
    safeString(billing?.taxpayer_type_id) ||
    null;

  const address = {
    street_name: safeString(billing?.address?.street_name),
    street_number: safeString(billing?.address?.street_number),
    city_name: safeString(billing?.address?.city_name),
    state_code: safeString(billing?.address?.state?.code),
    state_name: safeString(billing?.address?.state?.name),
    zip_code: safeString(billing?.address?.zip_code),
    country_id: safeString(billing?.address?.country_id),
  };

  const totalAmount = toNumber(order?.total_amount) || 0;
  const currencyId = safeString(order?.currency_id) || 'ARS';

  return {
    orderId: order?.id || null,
    packId: order?.pack_id || null,
    sellerId: order?.seller?.id || null,
    buyerId: buyer?.id || null,
    totalAmount,
    currencyId,
    orderSnapshot: order,
    billingInfoSnapshot: billingInfo,
    customerTax: {
      taxpayerName,
      docType,
      docNumber,
      ivaConditionId,
      address,
    },
    invoiceRequest: {
      cuitEmisor: safeString(process.env.ARCA_CUIT),
      ptoVta: toNumber(process.env.ARCA_PTO_VTA),
      cbteTipo: toNumber(process.env.ARCA_CBTE_TIPO),
      concepto: toNumber(process.env.ARCA_CONCEPTO) || 1,
      moneda: currencyId === 'ARS' ? 'PES' : currencyId,
      cotizacion: 1,
      impTotal: totalAmount,
      impNeto: totalAmount,
      impIva: 0,
    },
  };
}

async function loadOrderInvoiceData(orderId) {
  const [order, billingInfo] = await Promise.all([
    getOrder(orderId),
    getBillingInfo(orderId),
  ]);

  return buildInvoiceSeed(order, billingInfo);
}

module.exports = {
  getOrder,
  getBillingInfo,
  buildInvoiceSeed,
  loadOrderInvoiceData,
};