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
  let response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      signal: options.signal || AbortSignal.timeout(20000),
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
  } catch {
    return { available: true, text: 'The AI service did not answer. The ranked comps are still on this page.' };
  }
  if (!response.ok) {
    return { available: true, text: `The AI service returned HTTP ${response.status}. The ranked comps are still on this page.` };
  }
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content?.trim();
  return { available: true, text: text || 'The AI service returned an empty comparison.' };
}

function configuredKey(options) {
  if (options.apiKey !== undefined) return options.apiKey;
  return process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
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
