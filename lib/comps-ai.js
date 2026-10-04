export function aiStatus(options = {}) {
  const key = configuredKey(options);
  if (!key) return { available: false };
  return { available: true, model: configuredModel(options) };
}

export async function explainComps(subject, comps, options = {}) {
  const key = configuredKey(options);
  if (!key) {
    return {
      available: false,
      text: 'AI comparison is off. Set AI_API_KEY to an OpenAI-compatible key and run the comparison again. Size, zoning, and assessed value are already ranked without it.',
    };
  }
  const base = (options.baseUrl || process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = configuredModel(options);
  const fetchImpl = options.fetchImpl || fetch;
  const question = cleanQuestion(options.question);
  const payload = {
    question: question || undefined,
    subject: compact(subject),
    comps: (comps || []).slice(0, 8).map((comp) => ({ ...compact(comp), match: comp.comp })),
  };
  const tried = [];
  let response;
  for (const candidate of keyCandidates(options)) {
    try {
      response = await ask(fetchImpl, base, candidate.key, model, payload, options.signal);
    } catch {
      return { available: true, text: 'The AI service did not answer. The ranked comps are still on this page.' };
    }
    if (response.ok || (response.status !== 401 && response.status !== 403)) break;
    tried.push({ ...candidate, code: await errorCode(response) });
  }
  if (!response.ok) {
    const text = response.status === 401 || response.status === 403
      ? rejectedText(response.status, base, tried)
      : failureText(response.status, base, model);
    return { available: true, status: response.status, text: `${text} The ranked comps are still on this page.` };
  }
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content?.trim();
  return { available: true, text: text || 'The AI service returned an empty comparison.' };
}

function ask(fetchImpl, base, key, model, payload, signal) {
  return fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      signal: signal || AbortSignal.timeout(20000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: 'You compare borough parcel records for someone deciding which property to pursue. When a question is present, answer it from these records. A sale field is a price the user typed. Mention it when it is present, and keep the assessed value labeled as assessed. Appraised is the appraisal. Taxable can be 0 when the parcel is exempt. A sale year older than five years is not a current price. Waterfront is yes or absent, never a length. Deed date is the text in the record. valueHistory lists earlier appraised amounts. neighbor.below means the per-acre rate is under the nearby median. Do not invent sale prices, sale years, motivation, or ownership percentages that are not in the data. propertyTown and location describe the land. mailingCity is only where the owner gets mail. Do not treat the mailing city as the property town. Repeat exemption codes and zoning codes exactly as written, and do not spell those codes out. Write plain sentences. Say what is similar, what is different, and which comps are weak.',
          },
          {
            role: 'user',
            content: JSON.stringify(payload),
          },
        ],
      }),
    });
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

async function errorCode(response) {
  try {
    const body = await response.json();
    const code = body?.error?.code || body?.error?.type;
    return typeof code === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(code) ? code : '';
  } catch {
    return '';
  }
}

function rejectedText(status, base, tried) {
  const host = hostOf(base);
  const keys = tried.map((item) => `${item.name} (ends in ${item.key.slice(-4)}${item.code ? `, ${item.code}` : ''})`).join(' and ');
  const hint = tried.some((item) => /permission/i.test(item.code))
    ? ' The key is restricted. Give it Model capabilities, or use a key with All permissions.'
    : '';
  return `${host} turned down ${keys} (HTTP ${status}).${hint} In the provider's API keys page, find a live key with those last four characters, or create a new one. Paste it into AI_API_KEY on Railway with no quotes, and redeploy. If the key is from another provider, set AI_BASE_URL to that provider.`;
}

function failureText(status, base, model) {
  const host = hostOf(base);
  if (status === 404) return `${host} has no model named ${model} (HTTP 404). Set AI_MODEL to a model that key can use.`;
  if (status === 429) return `${host} is out of quota or rate-limited for this key (HTTP 429). Check billing on that account, or wait a minute.`;
  return `The AI service returned HTTP ${status}.`;
}

function cleanKey(value) {
  return String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').replace(/^Bearer\s+/i, '').trim();
}

function keyCandidates(options) {
  if (options.apiKey !== undefined) return [{ name: 'the key', key: cleanKey(options.apiKey) }];
  const list = [];
  for (const name of ['AI_API_KEY', 'OPENAI_API_KEY']) {
    const key = cleanKey(process.env[name]);
    if (key && !list.some((item) => item.key === key)) list.push({ name, key });
  }
  return list;
}

function configuredKey(options) {
  return keyCandidates(options)[0]?.key || '';
}

function configuredModel(options) {
  return options.model || process.env.AI_MODEL || 'gpt-4o-mini';
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
