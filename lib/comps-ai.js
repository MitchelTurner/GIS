const SYSTEM_PROMPT = 'You compare borough parcel records for someone deciding which property to pursue. When a question is present, answer it from these records. A sale field is a price the user typed. Mention it when it is present, and keep the assessed value labeled as assessed. Appraised is the appraisal. Taxable can be 0 when the parcel is exempt. A sale year older than five years is not a current price. Waterfront is yes or absent, never a length. Deed date is the text in the record. valueHistory lists earlier appraised amounts. neighbor.below means the per-acre rate is under the nearby median. Do not invent sale prices, sale years, motivation, or ownership percentages that are not in the data. propertyTown and location describe the land. mailingCity is only where the owner gets mail. Do not treat the mailing city as the property town. Repeat exemption codes and zoning codes exactly as written, and do not spell those codes out. Write plain sentences. Say what is similar, what is different, and which comps are weak.';
const OPENAI_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_MODEL = 'gpt-4o-mini';
const discoveredModels = new Map();

export function aiStatus(options = {}) {
  const candidate = keyCandidates(options)[0];
  if (!candidate) return { available: false };
  const target = targetFor(candidate, options);
  return { available: true, provider: target.provider, model: target.model || 'newest Claude Sonnet' };
}

export async function explainComps(subject, comps, options = {}) {
  const candidates = keyCandidates(options);
  if (!candidates.length) {
    return {
      available: false,
      text: 'AI comparison is off. Set AI_API_KEY to a Claude or OpenAI key and run the comparison again. Size, zoning, and assessed value are already ranked without it.',
    };
  }
  const fetchImpl = options.fetchImpl || fetch;
  const question = cleanQuestion(options.question);
  const payload = {
    question: question || undefined,
    subject: compact(subject),
    comps: (comps || []).slice(0, 8).map((comp) => ({ ...compact(comp), match: comp.comp })),
  };
  const tried = [];
  let response;
  let target;
  let detail = { code: '', message: '' };
  for (const candidate of candidates) {
    target = targetFor(candidate, options);
    try {
      if (!target.model) target.model = await newestClaude(fetchImpl, target, options.signal);
      response = await ask(fetchImpl, target, payload, options.signal);
      if (response.status === 400) {
        detail = await readError(response);
        // Some models take no sampling settings; ask once more without temperature.
        if (/temperature|top_p|sampling/i.test(detail.message)) {
          target.sampling = false;
          response = await ask(fetchImpl, target, payload, options.signal);
          if (!response.ok) detail = await readError(response);
        }
      }
    } catch {
      return { available: true, text: 'The AI service did not answer. The ranked comps are still on this page.' };
    }
    if (response.ok || (response.status !== 401 && response.status !== 403)) break;
    tried.push({ ...candidate, host: hostOf(target.base), code: (await readError(response)).code });
  }
  if (!response.ok) {
    if (response.status !== 400) detail = await readError(response);
    const text = response.status === 401 || response.status === 403
      ? rejectedText(response.status, tried)
      : failureText(response.status, target, detail);
    return { available: true, status: response.status, text: `${text} The ranked comps are still on this page.` };
  }
  const body = await response.json();
  const text = target.provider === 'anthropic'
    ? (body.content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
    : body.choices?.[0]?.message?.content?.trim();
  return { available: true, text: text || 'The AI service returned an empty comparison.' };
}

function ask(fetchImpl, target, payload, signal) {
  const content = JSON.stringify(payload);
  if (target.provider === 'anthropic') {
    return fetchImpl(`${target.base}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': target.key,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      signal: signal || AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: target.model,
        max_tokens: 700,
        ...(target.sampling === false ? {} : { temperature: 0.2 }),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });
  }
  return fetchImpl(`${target.base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
    },
    signal: signal || AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: target.model,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }),
  });
}

// Anthropic lists models newest first, so the first Sonnet is the current one.
async function newestClaude(fetchImpl, target, signal) {
  const cached = discoveredModels.get(target.key);
  if (cached) return cached;
  let chosen = '';
  try {
    const res = await fetchImpl(`${target.base}/models?limit=100`, {
      headers: { 'x-api-key': target.key, 'anthropic-version': ANTHROPIC_VERSION },
      signal: signal || AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const ids = ((await res.json())?.data || []).map((model) => String(model?.id || '')).filter(Boolean);
      chosen = ids.find((id) => /sonnet/i.test(id)) || ids[0] || '';
    }
  } catch {
    chosen = '';
  }
  if (chosen) discoveredModels.set(target.key, chosen);
  return chosen || 'claude-sonnet-4-5';
}

function normalizeBase(value, fallback) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (url.pathname === '' || url.pathname === '/') return `${url.origin}/v1`;
  } catch {
    return fallback;
  }
  return text;
}

function isAnthropicUrl(value) {
  return /(^|\.)anthropic\.com$/i.test(hostOf(String(value || '')));
}

function targetFor(candidate, options) {
  const configuredBase = options.baseUrl || process.env.AI_BASE_URL || '';
  const named = String(options.provider || process.env.AI_PROVIDER || '').trim().toLowerCase();
  const anthropic = named
    ? /anthropic|claude/.test(named)
    : candidate.anthropic || candidate.key.startsWith('sk-ant-') || isAnthropicUrl(configuredBase);
  const model = String(options.model || process.env.AI_MODEL || '').trim();
  if (anthropic) {
    const base = configuredBase && (isAnthropicUrl(configuredBase) || named)
      ? configuredBase
      : process.env.ANTHROPIC_BASE_URL;
    return {
      provider: 'anthropic',
      key: candidate.key,
      base: normalizeBase(base, ANTHROPIC_BASE),
      model: /^claude/i.test(model) ? model : '',
    };
  }
  return {
    provider: 'openai',
    key: candidate.key,
    base: normalizeBase(isAnthropicUrl(configuredBase) ? '' : configuredBase, OPENAI_BASE),
    model: model && !/^claude/i.test(model) ? model : OPENAI_MODEL,
  };
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return String(base || '');
  }
}

async function readError(response) {
  try {
    const body = await response.json();
    const code = body?.error?.code || body?.error?.type;
    return {
      code: typeof code === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(code) ? code : '',
      message: cleanMessage(body?.error?.message),
    };
  } catch {
    return { code: '', message: '' };
  }
}

function cleanMessage(value) {
  return String(value || '')
    .replace(/\b(sk|key)-[A-Za-z0-9_*.-]+/g, '$1-…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function rejectedText(status, tried) {
  const keys = tried.map((item) => `${item.name} at ${item.host} (ends in ${item.key.slice(-4)}${item.code ? `, ${item.code}` : ''})`).join(' and ');
  const hint = tried.some((item) => /permission/i.test(item.code))
    ? ' The key is restricted. Give it Model capabilities, or use a key with All permissions.'
    : '';
  return `The AI service turned down ${keys} (HTTP ${status}).${hint} In that provider's API keys page, find a live key with those last four characters, or create a new one. Paste it into AI_API_KEY on Railway with no quotes, and redeploy.`;
}

function failureText(status, target, detail = {}) {
  const host = hostOf(target.base);
  const said = detail.message ? ` ${host} said: "${detail.message}"` : '';
  if (/credit balance|billing|insufficient.*(funds|credit)/i.test(detail.message || '')) {
    return `The ${host} account is out of credit. Add credit under Billing in that provider's console, then try again.${said}`;
  }
  if (status === 404) return `${host} has no model named ${target.model} (HTTP 404). Set AI_MODEL to a model that key can use, or delete AI_MODEL.${said}`;
  if (status === 429) return `${host} is out of quota or rate-limited for this key (HTTP 429). Check billing on that account, or wait a minute.${said}`;
  if (status === 400) return `${host} refused the request (HTTP 400) for model ${target.model}.${said || ' Check that the account has credit and that AI_MODEL, if set, is a model this key can use.'}`;
  if (status === 529) return `${host} is overloaded right now (HTTP 529). Try again in a minute.`;
  return `The AI service returned HTTP ${status}.${said}`;
}

function cleanKey(value) {
  return String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').replace(/^Bearer\s+/i, '').trim();
}

function keyCandidates(options) {
  if (options.apiKey !== undefined) {
    const key = cleanKey(options.apiKey);
    return key ? [{ name: 'the key', key }] : [];
  }
  const list = [];
  for (const name of ['AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const key = cleanKey(process.env[name]);
    if (key && !list.some((item) => item.key === key)) list.push({ name, key, anthropic: name === 'ANTHROPIC_API_KEY' });
  }
  return list;
}

function cleanQuestion(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function compact(parcel = {}) {
  const taxable = parcel.taxableValue ?? parcel.taxable_value;
  return {
    parcelno: parcel.parcelno,
    owner: parcel.ownerName || parcel.owner_name,
    acres: parcel.acres,
    assessed: parcel.totalValue || parcel.total_value,
    appraised: positive(parcel.appraisedValue ?? parcel.appraised_value),
    taxable: taxable == null || taxable === '' ? undefined : Number(taxable),
    exemption: textOrUndefined(parcel.exemption),
    exemptionValue: positive(parcel.exemptionValue ?? parcel.exemption_value),
    waterfront: waterfrontLabel(parcel.waterfront),
    deedDate: textOrUndefined(parcel.deedDate || parcel.deed_date),
    valueHistory: historyRows(parcel.valueHistory || parcel.value_history),
    neighbor: neighborFact(parcel.neighbor),
    sale: parcel.salePrice || parcel.sale_price || undefined,
    saleYear: parcel.saleYear || parcel.sale_year || undefined,
    assessedPerAcre: parcel.assessedPerAcre || undefined,
    yearBuilt: parcel.yearBuilt || parcel.year_built || undefined,
    landValue: parcel.landValue || parcel.land_value || undefined,
    improvementValue: parcel.improvementValue || parcel.improvement_value || undefined,
    propUse: textOrUndefined(parcel.propUse || parcel.prop_use),
    zoning: parcel.zoning,
    location: parcel.location,
    propertyTown: parcel.locCity || parcel.loc_city,
    subdivision: parcel.subdivision,
    mailingCity: parcel.mailingCity || parcel.mailing_city,
  };
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function textOrUndefined(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function waterfrontLabel(value) {
  if (value === true || /^yes$/i.test(String(value || ''))) return 'Yes';
  return Number(value) > 0 ? 'Yes' : undefined;
}

function historyRows(value) {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter((row) => row && row.year && Number(row.amount) > 0)
    .slice(0, 5)
    .map((row) => ({ year: row.year, amount: Number(row.amount) }));
  return rows.length ? rows : undefined;
}

function neighborFact(value) {
  if (!value || !Number.isFinite(Number(value.median))) return undefined;
  return {
    perAcre: Number(value.rate),
    nearbyMedian: Number(value.median),
    below: Boolean(value.below),
  };
}
