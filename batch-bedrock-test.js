const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT_DIR = __dirname;

function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');

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

function stripBom(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/^\uFEFF/, '');
}

function isPlaceholderCredential(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.startsWith('PUT_') || normalized.startsWith('YOUR_');
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

function loadCredentialsFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    return parseIni(stripBom(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    return {};
  }
}

function resolveAwsCredentials() {
  const envAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const envSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const envSessionToken = process.env.AWS_SESSION_TOKEN;

  const envLooksPlaceholder =
    isPlaceholderCredential(envAccessKeyId) ||
    isPlaceholderCredential(envSecretAccessKey);

  if (envAccessKeyId && envSecretAccessKey && !envLooksPlaceholder) {
    return {
      accessKeyId: envAccessKeyId,
      secretAccessKey: envSecretAccessKey,
      sessionToken: envSessionToken || ''
    };
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

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken
  };
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
    host,
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
    host,
    path: requestPath,
    bodyText,
    headers
  };
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
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            signingService
          });
        });
      }
    );

    request.on('error', reject);
    request.write(signedRequest.bodyText);
    request.end();
  });
}

async function invokeBedrock(regionName, modelId, payload, defaultSigningService) {
  const primaryService = defaultSigningService;
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    if (char !== '\r') {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function toCsvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, rows) {
  const content = rows.map((row) => row.map(toCsvCell).join(',')).join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
}

function loadKeywordMap(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')));
    if (!Array.isArray(parsed)) {
      return {};
    }

    const map = {};
    parsed.forEach((item) => {
      if (!item || typeof item.k !== 'string') {
        return;
      }
      map[item.k.trim()] = typeof item.v === 'string' ? item.v.trim() : '';
    });
    return map;
  } catch (error) {
    return {};
  }
}

function getUsageFromResponse(parsedResponse) {
  const usage = parsedResponse && parsedResponse.usage ? parsedResponse.usage : {};
  const inputTokens = Number(
    usage.inputTokens || usage.input_tokens || usage.promptTokens || usage.prompt_tokens || 0
  ) || 0;
  const outputTokens = Number(
    usage.outputTokens || usage.output_tokens || usage.completionTokens || usage.completion_tokens || 0
  ) || 0;
  const totalTokens = Number(
    usage.totalTokens || usage.total_tokens || inputTokens + outputTokens
  ) || (inputTokens + outputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function calculateCost(usage, modelId) {
  const pricing = {
    'openai.gpt-oss-20b-1:0': {
      input: 0.07 / 1000000,
      output: 0.30 / 1000000
    },
    'openai.gpt-oss-120b-1:0': {
      input:  0.1545 / 1000000,
      output: 0.6180 / 1000000
    },
    'us.anthropic.claude-haiku-4-5-20251001-v1:0': {
      input: 1.0/ 1000000,
      output: 5.0/ 1000000
    },
    'us.anthropic.claude-sonnet-5': {
      input: 2.00 / 1000000,
      output: 10.00/ 1000000  
    },

    'us.amazon.nova-2-lite-v1:0': {
      input: 0.30 / 1000000,
      output: 2.50/ 1000000
    },
    'us.amazon.nova-pro-v1:0': {
      input: 1.25 / 1000000,
      output: 10.0 / 1000000
    },
    'us.amazon.nova-micro-v1:0': {
      input: 0.035 / 1000000,
      output: 0.14/ 1000000
    },
    'us.amazon.nova-premier-v1:0': {
      input: 2.50 / 1000000,
      output: 12.50 / 1000000
    },
    'google.gemma-3-12b-it': {
      input: 0.09 / 1000000,
      output: 0.29 / 1000000
    },
    'google.gemma-3-27b-it': {
      input: 0.23 / 1000000,
      output: 0.38 / 1000000
    }

  };

  const modelPricing = pricing[modelId] || {
    input: 0,
    output: 0
  };

  const inputCost = usage.inputTokens * modelPricing.input;
  const outputCost = usage.outputTokens * modelPricing.output;
  const totalCost = inputCost + outputCost;

  return {
    inputCost,
    outputCost,
    totalCost
  };
}

function mapOutputToFriendlyText(outputText, keywordMap) {
  if (!outputText || typeof outputText !== 'string') {
    return '';
  }

  const cleaned = outputText
    .replace(/<output>/ig, '')
    .replace(/<\/output>/ig, '')
    .trim();

  let keywords = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      keywords = parsed;
    } else if (parsed && Array.isArray(parsed.keywords)) {
      keywords = parsed.keywords;
    }
  } catch (error) {
    keywords = [];
  }

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return '';
  }

  const mapped = keywords
    .map((keyword) => {
      if (typeof keyword !== 'string') {
        return '';
      }

      const code = keyword.trim();
      if (!code) {
        return '';
      }

      return keywordMap[code] || code;
    })
    .filter(Boolean);

  return mapped.join('; ');
}

function extractComparableOutputKeys(outputText) {
  if (!outputText || typeof outputText !== 'string') {
    return [];
  }

  const cleaned = outputText
    .replace(/<output>/ig, '')
    .replace(/<\/output>/ig, '')
    .trim();

  if (!cleaned) {
    return [];
  }

  let values = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      values = parsed;
    } else if (parsed && Array.isArray(parsed.keywords)) {
      values = parsed.keywords;
    }
  } catch (error) {
    values = cleaned.split(/[;,\n\r]+/);
  }

  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    )
  ).sort();
}

function calculateOutputSimilarityPercent(leftOutputText, rightOutputText) {
  const leftKeys = extractComparableOutputKeys(leftOutputText);
  const rightKeys = extractComparableOutputKeys(rightOutputText);

  if (leftKeys.length === 0 && rightKeys.length === 0) {
    return null;
  }

  const leftSet = new Set(leftKeys);
  const rightSet = new Set(rightKeys);

  let intersectionCount = 0;
  leftSet.forEach((key) => {
    if (rightSet.has(key)) {
      intersectionCount += 1;
    }
  });

  const unionCount = new Set([...leftKeys, ...rightKeys]).size;
  if (unionCount === 0) {
    return null;
  }

  return Number(((intersectionCount / unionCount) * 100).toFixed(2));
}

function formatSimilarityMap(similarityByModel) {
  const modelIds = Object.keys(similarityByModel).sort();
  if (modelIds.length === 0) {
    return '';
  }

  return modelIds
    .map((modelId) => `${modelId}: ${similarityByModel[modelId].toFixed(2)}%`)
    .join('; ');
}

function addSimilarityComparisons(resultRows) {
  const rowsByQuestion = {};

  resultRows.forEach((row) => {
    const questionKey = `${row.question_id}::${row.question_row}`;
    if (!rowsByQuestion[questionKey]) {
      rowsByQuestion[questionKey] = [];
    }
    rowsByQuestion[questionKey].push(row);
  });

  Object.values(rowsByQuestion).forEach((rows) => {
    rows.forEach((row, rowIndex) => {
      const similarityByModel = {};

      rows.forEach((otherRow, otherIndex) => {
        if (rowIndex === otherIndex) {
          return;
        }

        const similarityPercent = calculateOutputSimilarityPercent(row.output, otherRow.output);
        if (similarityPercent === null) {
          return;
        }

        similarityByModel[otherRow.model_id] = similarityPercent;
      });

      row.output_similarity_by_model = similarityByModel;
      row.output_similarity_summary = formatSimilarityMap(similarityByModel);
    });
  });
}

function loadQuestions(filePath, questionColumn) {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const rows = parseCsv(raw);

  if (rows.length < 1) {
    throw new Error('Questions file is empty.');
  }

  const headers = rows[0].map((x) => x.trim());
  const headerQuestionIndex = headers.indexOf(questionColumn);
  const hasHeader = headerQuestionIndex !== -1;
  const questionIndex = hasHeader ? headerQuestionIndex : 0;
  const idIndex = hasHeader ? headers.indexOf('id') : -1;
  const startRow = hasHeader ? 1 : 0;

  const questions = [];
  for (let i = startRow; i < rows.length; i += 1) {
    const row = rows[i];
    const question = (row[questionIndex] || '').trim();
    if (!question) {
      continue;
    }

    const questionId = idIndex >= 0 ? (row[idIndex] || String(i)).trim() : String(i);
    questions.push({
      rowNumber: i + 1,
      id: questionId || String(i),
      question
    });
  }

  if (questions.length === 0) {
    throw new Error('No non-empty questions found in CSV.');
  }

  return questions;
}

function extractModelText(parsedResponse) {
  if (!parsedResponse) {
    return '';
  }

  const outputContent =
    parsedResponse.output &&
    parsedResponse.output.message &&
    parsedResponse.output.message.content;
  if (Array.isArray(outputContent)) {
    const fromOutput = outputContent
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('');

    if (fromOutput) {
      return fromOutput;
    }
  }

  // Anthropic Bedrock response: { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(parsedResponse.content)) {
    const fromAnthropic = parsedResponse.content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('');

    if (fromAnthropic) {
      return fromAnthropic;
    }
  }

  const choice = Array.isArray(parsedResponse.choices) ? parsedResponse.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message ? message.content : choice && choice.content ? choice.content : null;

  let fullText = '';
  if (typeof content === 'string') {
    fullText = content;
  } else if (Array.isArray(content)) {
    fullText = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  } else if (choice && typeof choice.text === 'string') {
    fullText = choice.text;
  } else if (typeof parsedResponse.output_text === 'string') {
    fullText = parsedResponse.output_text;
  }

  return fullText;
}

function parseReasoningAndOutput(fullText) {
  const result = {
    reasoning: '',
    output: fullText
  };

  const reasoningMatch = fullText.match(/<reasoning>(.*?)<\/reasoning>/is);
  if (reasoningMatch) {
    result.reasoning = reasoningMatch[1].trim();
    result.output = fullText.replace(/<reasoning>.*?<\/reasoning>/is, '').trim();
  }

  const outputMatch = result.output.match(/<output>(.*?)<\/output>/is);
  if (outputMatch) {
    result.output = outputMatch[1].trim();
  }

  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    args[key] = value;
    if (value !== 'true') {
      i += 1;
    }
  }
  return args;
}

function toModelOutputNameSegment(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) {
    return 'model';
  }

  const withoutNamespace = normalized.includes('.')
    ? normalized.split('.').slice(1).join('.')
    : normalized;
  const withoutVersion = withoutNamespace.replace(/-v\d+(?::\d+)?$/i, '');
  const baseName = withoutVersion.split('.').pop() || withoutVersion;
  const tokens = baseName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

  if (tokens.length === 0) {
    return 'model';
  }

  return tokens
    .map((token, index) => {
      if (index === 0) {
        return token;
      }
      if (/^\d+$/.test(tokens[index - 1])) {
        return token;
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join('');
}

function toPromptOutputNameSegment(promptFilePath) {
  const promptName = path.parse(String(promptFilePath || '')).name;
  const normalizedPromptName = promptName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
  const tokens = normalizedPromptName
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

  if (tokens.length === 0) {
    return 'prompt';
  }

  return tokens
    .map((token, index) => {
      if (index === 0) {
        return token;
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join('');
}

function buildDefaultOutputPath(models, promptFilePath) {
  const resultsDir = path.join(ROOT_DIR, 'results');
  const modelSegment = models.map(toModelOutputNameSegment).join('-');
  const promptSegment = toPromptOutputNameSegment(promptFilePath);
  const fileName = `results-${modelSegment}-${promptSegment}.csv`;
  return path.join(resultsDir, fileName);
}

function usage() {
  console.log('Usage:');
  console.log('node batch-bedrock-test.js --questions questions.csv --models model1,model2 [options]');
  console.log('');
  console.log('Options:');
  console.log('--questions        Required. Path to CSV file with questions');
  console.log('--models           Required. Comma-separated model ids');
  console.log('--out              Optional. Output CSV path (default: results/results-<models>-<prompt>.csv)');
  console.log('--region           Optional. AWS region (default: AWS_REGION or us-east-1)');
  console.log('--promptFile       Optional. Prompt file path (default: PromptNoReasoning.txt)');
  console.log('--questionColumn   Optional. CSV column name for question text (default: question)');
  console.log('--maxTokens        Optional. max_tokens for request (default: 2000)');
  console.log('--signingService   Optional. bedrock-runtime or bedrock (default: BEDROCK_SIGNING_SERVICE or bedrock-runtime)');
  console.log('--limit            Optional. Process only first N questions (e.g., --limit 10)');
  console.log('--json             Optional. Also write JSON results alongside CSV');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === 'true' || !args.questions || !args.models) {
    usage();
    process.exit(args.help === 'true' ? 0 : 1);
  }

  const questionsPath = path.resolve(ROOT_DIR, args.questions);
  const promptPath = path.resolve(ROOT_DIR, args.promptFile || 'PromptNoReasoning.txt');
  const keywordMapPath = path.resolve(ROOT_DIR, 'serviceCategories_kvd.json');
  const questionColumn = args.questionColumn || 'question';
  const region = args.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const maxTokens = Number(args.maxTokens || 2000);
  const signingService = args.signingService || process.env.BEDROCK_SIGNING_SERVICE || 'bedrock-runtime';
  const limit = args.limit ? Number(args.limit) : null;
  const writeJsonOutput = args.json === 'true';
  const models = args.models.split(',').map((x) => x.trim()).filter(Boolean);

  const outputPath = path.resolve(ROOT_DIR, args.out || buildDefaultOutputPath(models, promptPath));
  const outputJsonPath = outputPath.replace(/\.csv$/i, '.json');

  if (!fs.existsSync(questionsPath)) {
    throw new Error(`Questions file not found: ${questionsPath}`);
  }

  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }

  if (models.length === 0) {
    throw new Error('No models provided.');
  }

  let questions = loadQuestions(questionsPath, questionColumn);
  const promptText = stripBom(fs.readFileSync(promptPath, 'utf8'));
  const keywordMap = loadKeywordMap(keywordMapPath);

  if (limit && limit > 0 && limit < questions.length) {
    questions = questions.slice(0, limit);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log(`Questions: ${questions.length}`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Region: ${region}`);
  console.log(`Signing service default: ${signingService}`);
  if (limit) {
    console.log(`Limit: ${limit}`);
  }

  const resultRows = [];

  for (let qIndex = 0; qIndex < questions.length; qIndex += 1) {
    const q = questions[qIndex];

    for (let mIndex = 0; mIndex < models.length; mIndex += 1) {
      const modelId = models[mIndex];
      const startedAt = Date.now();
      const startedHr = process.hrtime.bigint();

      let status = 'ok';
      let outputText = '';
      let userFriendlyOutput = '';
      let errorText = '';
      let usedSigningService = signingService;
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      };
      let totalCost = 0;

      let reasoning = '';
      try {
        const isAnthropicModel = /anthropic/i.test(modelId);
        const usesDeprecatedAnthropicTemperature = /anthropic\.claude-sonnet-5/i.test(modelId);
        const isAmazonNovaModel = /^us.amazon\.nova-/i.test(modelId);
        const requestPayload = isAnthropicModel
          ? {
              system: promptText,
              messages: [
                { role: 'user', content: q.question }
              ],
              max_tokens: maxTokens,
              ...(usesDeprecatedAnthropicTemperature ? {} : { temperature: 0 }),
              anthropic_version: 'bedrock-2023-05-31'
            }
          : isAmazonNovaModel
            ? {
                system: [
                  { text: promptText }
                ],
                messages: [
                  {
                    role: 'user',
                    content: [
                      { text: q.question }
                    ]
                  }
                ],
                inferenceConfig: {
                  maxTokens: maxTokens,
                  temperature: 0,
                  topP: 0.1,
                }
              }
          : {
              model: modelId,
              messages: [
                { role: 'system', content: promptText },
                { role: 'user', content: q.question }
              ],
              max_tokens: maxTokens,
              temperature: 0,
              top_p: 0.1,
            };

        const response = await invokeBedrock(region, modelId, requestPayload, signingService);
        usedSigningService = response.signingService || signingService;

        if (response.statusCode < 200 || response.statusCode >= 300) {
          status = 'error';
          errorText = `HTTP ${response.statusCode}: ${parseAwsErrorMessage(response.bodyText)}`;
        } else {
          const parsed = JSON.parse(stripBom(response.bodyText));
          const fullText = extractModelText(parsed);
          const parsed_text = parseReasoningAndOutput(fullText);
          usage = getUsageFromResponse(parsed);
          totalCost = calculateCost(usage, modelId).totalCost;
          reasoning = parsed_text.reasoning;
          outputText = parsed_text.output;
          userFriendlyOutput = mapOutputToFriendlyText(outputText, keywordMap);
        }
      } catch (error) {
        status = 'error';
        errorText = error && error.message ? error.message : String(error);
      }

      const latencyMs = Number((process.hrtime.bigint() - startedHr) / 1000000n);

      const result = {
        timestamp_utc: new Date(startedAt).toISOString(),
        question_id: q.id,
        question_row: q.rowNumber,
        question: q.question,
        model_id: modelId,
        status,
        latency_ms: latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        totalCost: Number(totalCost.toFixed(8)),
        reasoning: reasoning,
        output: outputText,
        user_friendly_output: userFriendlyOutput,
        error: errorText
      };

      resultRows.push(result);

      const label = `[Q${qIndex + 1}/${questions.length}] [M${mIndex + 1}/${models.length}]`;
      if (status === 'ok') {
        console.log(`${label} OK ${modelId} ${latencyMs}ms`);
      } else {
        console.log(`${label} ERROR ${modelId} ${latencyMs}ms -> ${errorText}`);
      }
    }
  }

  addSimilarityComparisons(resultRows);

  const csvRows = [
    [
      'timestamp_utc',
      'question_id',
      'question_row',
      'question',
      'model_id',
      'status',
      'latency_ms',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'totalCost',
      'output',
      'output_similarity_by_model',
      'user_friendly_output',
      'error',
      'reasoning',
    ]
  ];

  resultRows.forEach((row) => {
    csvRows.push([
      row.timestamp_utc,
      row.question_id,
      row.question_row,
      row.question,
      row.model_id,
      row.status,
      row.latency_ms,
      row.inputTokens,
      row.outputTokens,
      row.totalTokens,
      row.totalCost,
      row.output,
      row.output_similarity_summary,
      row.user_friendly_output,
      row.error,
      row.reasoning
    ]);
  });

  writeCsv(outputPath, csvRows);
  if (writeJsonOutput) {
    fs.writeFileSync(outputJsonPath, JSON.stringify(resultRows, null, 2), 'utf8');
  }

  const summaryByModel = {};
  resultRows.forEach((row) => {
    if (!summaryByModel[row.model_id]) {
      summaryByModel[row.model_id] = { total: 0, ok: 0, error: 0, totalLatency: 0 };
    }
    const s = summaryByModel[row.model_id];
    s.total += 1;
    s.totalLatency += row.latency_ms;
    if (row.status === 'ok') {
      s.ok += 1;
    } else {
      s.error += 1;
    }
  });

  console.log('');
  console.log('Summary:');
  Object.keys(summaryByModel).forEach((modelId) => {
    const s = summaryByModel[modelId];
    const avg = s.total > 0 ? (s.totalLatency / s.total).toFixed(2) : '0.00';
    console.log(`${modelId} -> total=${s.total}, ok=${s.ok}, error=${s.error}, avg_latency_ms=${avg}`);
  });

  console.log('');
  console.log(`Results CSV: ${outputPath}`);
  if (writeJsonOutput) {
    console.log(`Results JSON: ${outputJsonPath}`);
  }
}

run().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
