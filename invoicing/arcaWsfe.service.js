const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const arcaAuthService = require('./arcaAuth.service');

const WSFE_URLS = {
  testing: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  production: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
};

function getArcaEnv() {
  return process.env.ARCA_ENV === 'production' ? 'production' : 'testing';
}

function getWsfeUrl() {
  return WSFE_URLS[getArcaEnv()];
}

function getCuit() {
  const cuit = String(process.env.ARCA_CUIT || '').replace(/\D/g, '');

  if (!cuit) {
    throw new Error('Falta configurar ARCA_CUIT');
  }

  return cuit;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

async function getAuthXml() {
  const ticket = await arcaAuthService.getAccessTicket('wsfe');

  return `
<Auth>
  <Token>${escapeXml(ticket.token)}</Token>
  <Sign>${escapeXml(ticket.sign)}</Sign>
  <Cuit>${getCuit()}</Cuit>
</Auth>`;
}

async function callWsfeSoap(action, bodyXml) {
  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

  const response = await axios.post(getWsfeUrl(), soapEnvelope, {
    timeout: 30000,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `http://ar.gov.afip.dif.FEV1/${action}`
    }
  });

  return response.data;
}

function findDeep(obj, key) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return obj[key];
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findDeep(value, key);
      if (found) return found;
    }
  }

  return null;
}

async function parseSoapResponse(soapXml, resultKey) {
  const parsed = await parseStringPromise(soapXml, {
    explicitArray: false,
    trim: true
  });

  const result = findDeep(parsed, resultKey);

  if (!result) {
    throw new Error(`No se encontró ${resultKey} en la respuesta de WSFE`);
  }

  return result;
}

async function feCompUltimoAutorizado({ pointOfSale, invoiceType }) {
  const authXml = await getAuthXml();

  const bodyXml = `<FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">
  ${authXml}
  <PtoVta>${Number(pointOfSale)}</PtoVta>
  <CbteTipo>${Number(invoiceType)}</CbteTipo>
</FECompUltimoAutorizado>`;

  const soapXml = await callWsfeSoap('FECompUltimoAutorizado', bodyXml);
  return parseSoapResponse(soapXml, 'FECompUltimoAutorizadoResult');
}

function buildFeDetRequestXml(fiscalInvoice, nextNumber) {
  const detail = fiscalInvoice?.arcaRequest?.FeCAEReq?.FeDetReq?.FECAEDetRequest;

  if (!detail) {
    throw new Error('El fiscalInvoice no tiene FECAEDetRequest');
  }

  return `<FECAEDetRequest>
  <Concepto>${Number(detail.Concepto)}</Concepto>
  <DocTipo>${Number(detail.DocTipo)}</DocTipo>
  <DocNro>${Number(detail.DocNro)}</DocNro>
  <CbteDesde>${Number(nextNumber)}</CbteDesde>
  <CbteHasta>${Number(nextNumber)}</CbteHasta>
  <CbteFch>${escapeXml(detail.CbteFch)}</CbteFch>
  <ImpTotal>${money(detail.ImpTotal)}</ImpTotal>
  <ImpTotConc>${money(detail.ImpTotConc)}</ImpTotConc>
  <ImpNeto>${money(detail.ImpNeto)}</ImpNeto>
  <ImpOpEx>${money(detail.ImpOpEx)}</ImpOpEx>
  <ImpTrib>${money(detail.ImpTrib)}</ImpTrib>
  <ImpIVA>${money(detail.ImpIVA)}</ImpIVA>
  <MonId>${escapeXml(detail.MonId)}</MonId>
  <MonCotiz>${money(detail.MonCotiz || 1)}</MonCotiz>
  <CondicionIVAReceptorId>${Number(detail.CondicionIVAReceptorId)}</CondicionIVAReceptorId>
</FECAEDetRequest>`;
}

function getApprovedDetail(result) {
  const detail =
    result?.FeDetResp?.FECAEDetResponse ||
    result?.FeDetResp?.FECAEDetResponse?.[0] ||
    null;

  if (Array.isArray(detail)) {
    return detail[0] || null;
  }

  return detail;
}

async function feCaeSolicitar(fiscalInvoice) {
  const pointOfSale = fiscalInvoice?.comprobante?.puntoVenta;
  const invoiceType = fiscalInvoice?.comprobante?.tipo;

  if (!pointOfSale || !invoiceType) {
    throw new Error('fiscalInvoice no tiene punto de venta o tipo de comprobante');
  }

  const last = await feCompUltimoAutorizado({
    pointOfSale,
    invoiceType
  });

  const lastNumber = Number(last?.CbteNro || 0);
  const nextNumber = lastNumber + 1;

  const authXml = await getAuthXml();
  const detailXml = buildFeDetRequestXml(fiscalInvoice, nextNumber);

  const bodyXml = `<FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
  ${authXml}
  <FeCAEReq>
    <FeCabReq>
      <CantReg>1</CantReg>
      <PtoVta>${Number(pointOfSale)}</PtoVta>
      <CbteTipo>${Number(invoiceType)}</CbteTipo>
    </FeCabReq>
    <FeDetReq>
      ${detailXml}
    </FeDetReq>
  </FeCAEReq>
</FECAESolicitar>`;

  const soapXml = await callWsfeSoap('FECAESolicitar', bodyXml);
  const result = await parseSoapResponse(soapXml, 'FECAESolicitarResult');

  const headerResult = result?.FeCabResp?.Resultado || null;
  const detail = getApprovedDetail(result);

  if (headerResult !== 'A' && detail?.Resultado !== 'A') {
    const error = new Error('ARCA no aprobó el comprobante');
    error.details = result;
    throw error;
  }

  return {
    result,
    invoiceNumber: Number(detail?.CbteDesde || nextNumber),
    cae: detail?.CAE || null,
    caeDueDate: detail?.CAEFchVto || null,
    pointOfSale,
    invoiceType
  };
}

async function feParamGetPtosVenta() {
  const authXml = await getAuthXml();

  const bodyXml = `<FEParamGetPtosVenta xmlns="http://ar.gov.afip.dif.FEV1/">
  ${authXml}
</FEParamGetPtosVenta>`;

  const soapXml = await callWsfeSoap('FEParamGetPtosVenta', bodyXml);
  return parseSoapResponse(soapXml, 'FEParamGetPtosVentaResult');
}

module.exports = {
  feCompUltimoAutorizado,
  feCaeSolicitar,
  feParamGetPtosVenta
};