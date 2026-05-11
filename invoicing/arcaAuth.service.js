const fs = require('fs/promises');
const path = require('path');
const forge = require('node-forge');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const WSAA_URLS = {
  testing: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
};

function getArcaEnv() {
  return process.env.ARCA_ENV === 'production' ? 'production' : 'testing';
}

function getWsaaUrl() {
  return WSAA_URLS[getArcaEnv()];
}

function getTicketStoreDir() {
  return path.resolve(process.env.ARCA_TA_STORE_DIR || '.arca_tickets');
}

function getTicketStorePath(service) {
  return path.join(getTicketStoreDir(), `${getArcaEnv()}-${service}.json`);
}

function formatXmlDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

function createLoginTicketRequestXml(service) {
  const now = new Date();
  const generationTime = new Date(now.getTime() - 10 * 60 * 1000);
  const expirationTime = new Date(now.getTime() + 10 * 60 * 60 * 1000);
  const uniqueId = Math.floor(now.getTime() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${formatXmlDate(generationTime)}</generationTime>
    <expirationTime>${formatXmlDate(expirationTime)}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

async function readTextFile(filePath, label) {
  if (!filePath) {
    throw new Error(`Falta configurar ${label}`);
  }

  return fs.readFile(path.resolve(filePath), 'utf8');
}

async function signLoginTicketRequest(loginTicketRequestXml) {
  const certPem = await readTextFile(process.env.ARCA_CERT_PATH, 'ARCA_CERT_PATH');
  const keyPem = await readTextFile(process.env.ARCA_KEY_PATH, 'ARCA_KEY_PATH');

  const certificate = forge.pki.certificateFromPem(certPem);
  const privateKey = forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(loginTicketRequestXml, 'utf8');
  p7.addCertificate(certificate);

  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data
      },
      {
        type: forge.pki.oids.messageDigest
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date()
      }
    ]
  });

  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();

  return forge.util.encode64(der);
}

async function callWsaaLoginCms(cmsBase64) {
  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsBase64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await axios.post(getWsaaUrl(), soapEnvelope, {
    timeout: 30000,
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: ''
    }
  });

  return response.data;
}

function pickFirst(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function parseWsaaResponse(soapXml) {
  const parsedSoap = await parseStringPromise(soapXml, {
    explicitArray: false,
    trim: true
  });

  const envelope =
    parsedSoap['soapenv:Envelope'] ||
    parsedSoap['soap:Envelope'] ||
    parsedSoap.Envelope;

  const body =
    envelope?.['soapenv:Body'] ||
    envelope?.['soap:Body'] ||
    envelope?.Body;

  const loginCmsResponse =
    body?.loginCmsResponse ||
    body?.['ns1:loginCmsResponse'] ||
    body?.['soapenv:loginCmsResponse'];

  const loginCmsReturn = pickFirst(
    loginCmsResponse?.loginCmsReturn ||
    loginCmsResponse?.['ns1:loginCmsReturn']
  );

  if (!loginCmsReturn) {
    throw new Error('WSAA no devolvió loginCmsReturn');
  }

  const parsedTa = await parseStringPromise(loginCmsReturn, {
    explicitArray: false,
    trim: true
  });

  const credentials = parsedTa?.loginTicketResponse?.credentials;
  const header = parsedTa?.loginTicketResponse?.header;

  if (!credentials?.token || !credentials?.sign) {
    throw new Error('WSAA no devolvió token/sign');
  }

  return {
    token: credentials.token,
    sign: credentials.sign,
    expirationTime: header?.expirationTime || null,
    generationTime: header?.generationTime || null,
    raw: loginCmsReturn
  };
}

function isTicketStillValid(ticket) {
  if (!ticket?.token || !ticket?.sign || !ticket?.expirationTime) {
    return false;
  }

  const expiration = new Date(ticket.expirationTime).getTime();
  const nowWithMargin = Date.now() + 5 * 60 * 1000;

  return Number.isFinite(expiration) && expiration > nowWithMargin;
}

async function readStoredTicket(service) {
  try {
    const filePath = getTicketStorePath(service);
    const raw = await fs.readFile(filePath, 'utf8');
    const ticket = JSON.parse(raw);

    if (isTicketStillValid(ticket)) {
      return ticket;
    }

    return null;
  } catch {
    return null;
  }
}

async function persistTicket(service, ticket) {
  const dir = getTicketStoreDir();
  await fs.mkdir(dir, { recursive: true });

  const filePath = getTicketStorePath(service);
  await fs.writeFile(filePath, JSON.stringify(ticket, null, 2), 'utf8');
}

async function getAccessTicket(service = 'wsfe') {
  const stored = await readStoredTicket(service);

  if (stored) {
    return stored;
  }

  const loginTicketRequestXml = createLoginTicketRequestXml(service);
  const cmsBase64 = await signLoginTicketRequest(loginTicketRequestXml);
  const soapXml = await callWsaaLoginCms(cmsBase64);
  const ticket = await parseWsaaResponse(soapXml);

  await persistTicket(service, ticket);

  return ticket;
}

module.exports = {
  getAccessTicket
};