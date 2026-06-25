const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      return;
    }

    let value = trimmed.slice(equalIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

loadDotEnv();

const PORT = Number(process.env.PORT || 8000);
const ROOT_DIR = __dirname;
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const DEFAULT_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'openai.gpt-oss-20b-1:0';
const DEFAULT_SIGNING_SERVICE = process.env.BEDROCK_SIGNING_SERVICE || 'bedrock-runtime';

let promptCache;
let keywordsCache;
let credentialCache;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });

  if (body === undefined || body === null) {
    res.end();
    return;
  }

  res.end(body);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function isWithinRoot(filePath) {
  const resolvedRoot = path.resolve(ROOT_DIR);
  const resolvedFile = path.resolve(filePath);

  return resolvedFile === resolvedRoot || resolvedFile.indexOf(resolvedRoot + path.sep) === 0;
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;

      if (size > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

function stripBom(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/^\uFEFF/, '');
}

function readTextFile(filePath) {
  return stripBom(fs.readFileSync(filePath, 'utf8'));
}

function loadPromptText() {
  if (typeof promptCache === 'string') {
    return promptCache;
  }

  promptCache = readTextFile(path.join(ROOT_DIR, 'PromptNoReasoning.txt'));
  return promptCache;
}

function loadKeywords() {
  if (Array.isArray(keywordsCache)) {
    return keywordsCache;
  }

  keywordsCache = JSON.parse(readTextFile(path.join(ROOT_DIR, 'serviceCategories_kvd.json')));
  return keywordsCache;
}

function parseIni(content) {
  const result = {};
  let currentSection = null;

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      return;
    }

    const sectionMatch = trimmed.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].replace(/^profile\s+/, '');
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      return;
    }

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1 || !currentSection) {
      return;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim();
    result[currentSection][key] = value;
  });

  return result;
}

function isPlaceholderCredential(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.startsWith('PUT_') || normalized.startsWith('YOUR_');
}

function loadCredentialsFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    return parseIni(readTextFile(filePath));
  } catch (error) {
    return {};
  }
}

function resolveAwsCredentials() {
  if (credentialCache) {
    return credentialCache;
  }

  const envAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const envSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const envSessionToken = process.env.AWS_SESSION_TOKEN;

  const envLooksPlaceholder =
    isPlaceholderCredential(envAccessKeyId) ||
    isPlaceholderCredential(envSecretAccessKey);

  if (envAccessKeyId && envSecretAccessKey && !envLooksPlaceholder) {
    credentialCache = {
      accessKeyId: envAccessKeyId,
      secretAccessKey: envSecretAccessKey,
      sessionToken: envSessionToken || ''
    };
    return credentialCache;
  }

  const profileName = process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || 'default';
  const sharedCredentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
  const sharedConfigFile = process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
  const credentials = Object.assign(
    {},
    loadCredentialsFromFile(sharedCredentialsFile)[profileName] || {},
    loadCredentialsFromFile(sharedConfigFile)[profileName] || {}
  );

  const accessKeyId = credentials.aws_access_key_id || '';
  const secretAccessKey = credentials.aws_secret_access_key || '';
  const sessionToken = credentials.aws_session_token || '';

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials not found. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure an AWS profile.');
  }

  credentialCache = {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    sessionToken: sessionToken
  };

  return credentialCache;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function getSignatureKey(secretAccessKey, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = crypto.createHmac('sha256', kDate).update(regionName, 'utf8').digest();
  const kService = crypto.createHmac('sha256', kRegion).update(serviceName, 'utf8').digest();
  return crypto.createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}

function getIsoDateParts(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return {
    amzDate: `${year}${month}${day}T${hours}${minutes}${seconds}Z`,
    dateStamp: `${year}${month}${day}`
  };
}

function buildSignedRequestOptions(regionName, modelId, payload, credentials, serviceName) {
  const host = `bedrock-runtime.${regionName}.amazonaws.com`;
  const encodedModelId = encodeURIComponent(modelId);
  const requestPath = `/model/${encodedModelId}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(encodedModelId)}/invoke`;
  const bodyText = JSON.stringify(payload);
  const dateParts = getIsoDateParts(new Date());
  const payloadHash = sha256Hex(bodyText);

  const headers = {
    host: host,
    'content-type': 'application/json',
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': dateParts.amzDate
  };

  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name.toLowerCase()}:${String(headers[name]).trim()}\n`)
    .join('');
  const signedHeaders = Object.keys(headers)
    .sort()
    .map((name) => name.toLowerCase())
    .join(';');

  const canonicalRequest = [
    'POST',
    canonicalPath,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateParts.dateStamp}/${regionName}/${serviceName}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateParts.amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');

  const signingKey = getSignatureKey(credentials.secretAccessKey, dateParts.dateStamp, regionName, serviceName);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers.Authorization = [
    'AWS4-HMAC-SHA256',
    `Credential=${credentials.accessKeyId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`
  ].join(' ');

  return {
    host: host,
    path: requestPath,
    bodyText: bodyText,
    headers: headers
  };
}

function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname, path }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        bodyText: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => { request.destroy(); reject(new Error('timeout')); });
  });
}

function parseAwsErrorMessage(bodyText) {
  try {
    const parsed = JSON.parse(stripBom(bodyText));
    return parsed.message || parsed.Message || bodyText;
  } catch (error) {
    return bodyText;
  }
}

function invokeBedrockWithSigningService(regionName, modelId, payload, signingService) {
  const credentials = resolveAwsCredentials();
  const signedRequest = buildSignedRequestOptions(regionName, modelId, payload, credentials, signingService);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: signedRequest.host,
        method: 'POST',
        path: signedRequest.path,
        headers: signedRequest.headers
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => {
          chunks.push(chunk);
        });

        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            signingService: signingService
          });
        });
      }
    );

    request.on('error', reject);
    request.write(signedRequest.bodyText);
    request.end();
  });
}

async function invokeBedrock(regionName, modelId, payload) {
  const primaryService = DEFAULT_SIGNING_SERVICE;
  const alternateService = primaryService === 'bedrock' ? 'bedrock-runtime' : 'bedrock';

  const firstAttempt = await invokeBedrockWithSigningService(regionName, modelId, payload, primaryService);
  if (firstAttempt.statusCode === 403) {
    const errorMessage = parseAwsErrorMessage(firstAttempt.bodyText);
    if (errorMessage.includes('scoped to correct service')) {
      return invokeBedrockWithSigningService(regionName, modelId, payload, alternateService);
    }
  }

  return firstAttempt;
}

async function handleDiagnostic(res) {
  const result = {
    region: DEFAULT_REGION,
    modelId: DEFAULT_MODEL_ID,
    signingServiceDefault: DEFAULT_SIGNING_SERVICE,
    bedrockEndpoint: `bedrock-runtime.${DEFAULT_REGION}.amazonaws.com`,
    credentials: { loaded: false, source: 'none', accessKeyIdPrefix: null },
    envFile: fs.existsSync(path.join(ROOT_DIR, '.env')) ? 'found' : 'not found',
    endpointReachable: false,
    endpointError: null,
    issues: []
  };

  // Check credentials
  try {
    const creds = resolveAwsCredentials();
    const prefix = creds.accessKeyId ? creds.accessKeyId.slice(0, 4) + '...' : null;
    const isTemporaryKey = creds.accessKeyId && creds.accessKeyId.startsWith('ASIA');
    const envHasAccess = Boolean(process.env.AWS_ACCESS_KEY_ID);
    const envHasSecret = Boolean(process.env.AWS_SECRET_ACCESS_KEY);
    const envLooksPlaceholder =
      isPlaceholderCredential(process.env.AWS_ACCESS_KEY_ID || '') ||
      isPlaceholderCredential(process.env.AWS_SECRET_ACCESS_KEY || '');
    const source = envHasAccess && envHasSecret && !envLooksPlaceholder
      ? '.env / environment variable'
      : '~/.aws/credentials profile';
    result.credentials = {
      loaded: true,
      source,
      accessKeyIdPrefix: prefix,
      hasSessionToken: Boolean(creds.sessionToken),
      isTemporaryKey: Boolean(isTemporaryKey)
    };

    if (envLooksPlaceholder) {
      result.issues.push('CREDENTIALS: .env still contains placeholder values (PUT_...). Replace with real keys.');
    }

    if (isTemporaryKey && !creds.sessionToken) {
      result.issues.push('CREDENTIALS: Access key looks temporary (ASIA...) but AWS_SESSION_TOKEN is missing.');
    }
  } catch (error) {
    result.credentials.loaded = false;
    result.credentials.error = error.message;
    result.issues.push('CREDENTIALS: ' + error.message);
  }

  // Check endpoint reachability
  try {
    const probe = await httpGet(result.bedrockEndpoint, '/');
    // Any HTTP response (even 4xx) means the host is reachable
    result.endpointReachable = true;
  } catch (error) {
    result.endpointReachable = false;
    result.endpointError = error.message;
    result.issues.push('NETWORK: Cannot reach ' + result.bedrockEndpoint + ' — check VPN / firewall');
  }

  // Check for common region mismatch indicator
  if (DEFAULT_REGION === 'us-east-1') {
    result.issues.push(
      'HINT: openai.gpt-oss-20b-1:0 may require a specific region (e.g. us-west-2). ' +
      'If you see a 403 "Credential should be scoped to" error, change AWS_REGION in .env to match.'
    );
  }

  sendJson(res, 200, result);
}

function stripCodeFences(text) {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines.length <= 2) {
    return trimmed.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  }

  if (lines[lines.length - 1].trim() === '```') {
    lines.shift();
    lines.pop();
  }

  if (lines[0] && lines[0].trim().match(/^[a-zA-Z]+$/)) {
    lines.shift();
  }

  return lines.join('\n').trim();
}

function extractModelText(parsedResponse) {
  if (!parsedResponse) {
    return '';
  }

  const choice = Array.isArray(parsedResponse.choices) ? parsedResponse.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message ? message.content : choice && choice.content ? choice.content : null;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }

  if (choice && typeof choice.text === 'string') {
    return choice.text;
  }

  if (typeof parsedResponse.output_text === 'string') {
    return parsedResponse.output_text;
  }

  return '';
}

async function handleMapQuestion(req, res) {
  try {
    const requestBody = await getRequestBody(req);
    const payload = requestBody ? JSON.parse(stripBom(requestBody)) : {};
    const location = typeof payload.location === 'string' ? payload.location.trim() : '';
    const searchTerm = typeof payload.searchTerm === 'string' ? payload.searchTerm.trim() : '';
    const filters = Array.isArray(payload.filters) ? payload.filters : [];

    const promptText = loadPromptText();
    const availableKeywords = loadKeywords();

    const userPrompt = [
   //   `Location: ${location || 'Not provided'}`,
      `Customer Question: ${searchTerm || 'Not provided'}`,
    //  `Selected Filters: ${JSON.stringify(filters)}`,
     // `Available Keywords: ${JSON.stringify(availableKeywords)}`
    ].join('\n');

    const modelRequest = {
      model: DEFAULT_MODEL_ID,
      messages: [
        {
          role: 'system',
          content: promptText
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      max_tokens: 2000
    };

    const response = await invokeBedrock(DEFAULT_REGION, DEFAULT_MODEL_ID, modelRequest);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let detail = response.bodyText;
      try {
        const parsed = JSON.parse(stripBom(response.bodyText));
        detail = parsed.message || parsed.Message || JSON.stringify(parsed);
      } catch (e) { /* leave as raw text */ }

      let hint = '';
      if (response.statusCode === 403) {
        if (detail.includes('The security token included in the request is invalid')) {
          const creds = resolveAwsCredentials();
          const looksTemporary = creds.accessKeyId && creds.accessKeyId.startsWith('ASIA');
          const looksPlaceholder = creds.accessKeyId && creds.accessKeyId.startsWith('PUT_');

          hint = ' | FIX: credentials are invalid for this request.';
          if (looksPlaceholder) {
            hint += ' .env still contains placeholder values (PUT_...).';
          }
          if (looksTemporary && !creds.sessionToken) {
            hint += ' Access key is temporary (ASIA...) and requires AWS_SESSION_TOKEN.';
          }
          hint += ' Also confirm region/model access and run GET /api/diagnostic.';
        } else
        if (detail.includes('scoped to')) {
          const match = detail.match(/scoped to a valid region, not '([^']+)'/) ||
                        detail.match(/not '([^']+)'/); 
          const wrongRegion = match ? match[1] : 'unknown';
          hint = ` | FIX: the signing region "${DEFAULT_REGION}" is wrong for this model. ` +
                 `Check which region the model is enabled in (AWS Console > Bedrock > Model access) ` +
                 `and update AWS_REGION in your .env file. Wrong region detected: "${wrongRegion}".`;
        } else if (detail.includes('not authorized') || detail.includes('AccessDenied')) {
          hint = ` | FIX: the IAM user has no bedrock:InvokeModel permission for model "${DEFAULT_MODEL_ID}". ` +
                 `Add a policy: { Effect:Allow, Action:[bedrock:InvokeModel], Resource:* }`;
        } else {
          hint = ` | Run GET /api/diagnostic for full credential/region/network status.`;
        }
      }
      throw new Error(`Bedrock HTTP ${response.statusCode}: ${detail}${hint}`);
    }

    const parsedResponse = JSON.parse(stripBom(response.bodyText));
    const rawText = stripCodeFences(extractModelText(parsedResponse));

    let keywords = [];
    let parseError = null;

    try {
      const parsedText = JSON.parse(stripBom(rawText));
      keywords = Array.isArray(parsedText) ? parsedText : [];
    } catch (error) {
      parseError = error.message;
    }

    sendJson(res, 200, {
      modelId: DEFAULT_MODEL_ID,
      region: DEFAULT_REGION,
      signingService: response.signingService,
      keywords: keywords,
      rawText: rawText,
      parseError: parseError,
      request: {
        location: location,
        searchTerm: searchTerm,
        filters: filters
      }
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message || 'Failed to invoke Bedrock'
    });
  }
}

function serveStaticFile(req, res, pathname) {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT_DIR, relativePath.replace(/^\//, ''));

  if (!isWithinRoot(filePath)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const content = fs.readFileSync(filePath);

    if (req.method === 'HEAD') {
      sendText(res, 200, getContentType(filePath));
      return;
    }

    sendText(res, 200, getContentType(filePath), content);
  } catch (error) {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && requestUrl.pathname === '/api/bedrock/map-question') {
    await handleMapQuestion(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/diagnostic') {
    await handleDiagnostic(res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStaticFile(req, res, requestUrl.pathname);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

const MAX_PORT_ATTEMPTS = 20;
let currentPort = PORT;

server.on('listening', () => {
  const address = server.address();
  const boundPort = address && address.port ? address.port : currentPort;
  currentPort = boundPort;
  console.log(`FindTreatmentPrototype server running at http://localhost:${boundPort}`);
});

function startServerOnPort(port, attemptsLeft) {
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Retrying on port ${nextPort}...`);
      startServerOnPort(nextPort, attemptsLeft - 1);
      return;
    }

    console.error(error);
    process.exit(1);
  });

  currentPort = port;
  server.listen(port);
}

startServerOnPort(PORT, MAX_PORT_ATTEMPTS);
