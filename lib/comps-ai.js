export async function explainComps(subject, comps, options = {}) {
  const key = options.apiKey !== undefined
    ? options.apiKey
    : (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '');
  if (!key) {
    return {
      available: false,
      text: 'AI comparison is off. Set AI_API_KEY to an OpenAI-compatible key and run the comparison again. Size, zoning, and assessed value are already ranked without it.',
    };
  }
  const base = (options.baseUrl || process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = options.model || process.env.AI_MODEL || 'gpt-4o-mini';
  const fetchImpl = options.fetchImpl || fetch;
  const payload = {
    subject: compact(subject),
    comps: comps.slice(0, 8).map((comp) => ({ ...compact(comp), match: comp.comp })),
  };
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You compare borough parcel records for someone deciding which property to pursue. A sale field is a price the user typed. Mention it when it is present, and keep the assessed value labeled as assessed. A sale year older than five years is not a current price. Do not invent sale prices, sale years, motivation, or ownership percentages that are not in the data. propertyTown and location describe the land. mailingCity is only where the owner gets mail. Do not treat the mailing city as the property town, and do not expand abbreviations that the data does not spell out. Write plain sentences. Say what is similar, what is different, and which comps are weak.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    }),
  });
  if (!response.ok) {
    return { available: true, text: `The AI service returned HTTP ${response.status}. The ranked comps are still saved in the database.` };
  }
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content?.trim();
  return { available: true, text: text || 'The AI service returned an empty comparison.' };
}

function compact(parcel) {
  return {
    parcelno: parcel.parcelno,
    owner: parcel.ownerName || parcel.owner_name,
    acres: parcel.acres,
    assessed: parcel.totalValue || parcel.total_value,
    sale: parcel.salePrice || parcel.sale_price || undefined,
    saleYear: parcel.saleYear || parcel.sale_year || undefined,
    assessedPerAcre: parcel.assessedPerAcre || undefined,
    yearBuilt: parcel.yearBuilt || parcel.year_built || undefined,
    landValue: parcel.landValue || parcel.land_value || undefined,
    improvementValue: parcel.improvementValue || parcel.improvement_value || undefined,
    zoning: parcel.zoning,
    location: parcel.location,
    propertyTown: parcel.locCity || parcel.loc_city,
    subdivision: parcel.subdivision,
    mailingCity: parcel.mailingCity || parcel.mailing_city,
  };
}
