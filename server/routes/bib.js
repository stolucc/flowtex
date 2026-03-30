import { Router } from 'express';

const router = Router();

// Strip braces from BibTeX field values for search queries
function stripBraces(val) {
  if (!val) return '';
  return val
    .replace(/^\{|\}$/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

// Query CrossRef API to find metadata for a single entry
async function lookupCrossRef(title, author) {
  const params = new URLSearchParams();
  if (title) params.set('query.bibliographic', title);
  if (author) params.set('query.author', author.split(/\s+and\s+/i)[0]);
  params.set('rows', '3');
  params.set(
    'select',
    'DOI,title,author,container-title,volume,issue,page,publisher,published-print,published-online,ISSN,ISBN,URL,type',
  );

  try {
    const res = await fetch(`https://api.crossref.org/works?${params}`, {
      headers: {
        'User-Agent': 'FlowTex/1.0 (mailto:flowtex@example.com)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data?.message?.items;
    if (!items?.length) return null;

    // Find best match by comparing titles
    const titleLower = (title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let best = items[0];
    let bestScore = 0;
    for (const item of items) {
      const itemTitle = (item.title?.[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      // Simple similarity: length of common prefix ratio
      let common = 0;
      const minLen = Math.min(titleLower.length, itemTitle.length);
      for (let i = 0; i < minLen; i++) {
        if (titleLower[i] === itemTitle[i]) common++;
        else break;
      }
      const score = minLen > 0 ? common / Math.max(titleLower.length, itemTitle.length) : 0;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    // Only use if reasonable match (> 50% prefix match)
    if (bestScore < 0.5 && items.length > 0) {
      // Fall back to checking if the CrossRef title contains our title or vice versa
      const bestTitle = (best.title?.[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!bestTitle.includes(titleLower.slice(0, 20)) && !titleLower.includes(bestTitle.slice(0, 20))) {
        return null;
      }
    }

    return best;
  } catch {
    return null;
  }
}

// Extract fields from a CrossRef work item
function extractFields(item) {
  const fields = {};

  if (item.DOI) fields.doi = item.DOI;
  if (item.page) fields.pages = item.page;
  if (item.publisher) fields.publisher = item.publisher;
  if (item.volume) fields.volume = String(item.volume);
  if (item.issue) fields.number = String(item.issue);
  if (item.URL) fields.url = item.URL;

  const published = item['published-print'] || item['published-online'];
  if (published?.['date-parts']?.[0]) {
    const parts = published['date-parts'][0];
    if (parts[0]) fields.year = String(parts[0]);
    if (parts[1]) fields.month = String(parts[1]);
  }

  if (item['container-title']?.[0]) {
    // Could be journal or booktitle depending on entry type
    fields.journal = item['container-title'][0];
    fields.booktitle = item['container-title'][0];
  }

  if (item.ISSN?.[0]) fields.issn = item.ISSN[0];
  if (item.ISBN?.[0]) fields.isbn = item.ISBN[0];

  if (item.author?.length) {
    fields.author = item.author.map((a) => [a.family, a.given].filter(Boolean).join(', ')).join(' and ');
  }

  if (item.title?.[0]) fields.title = item.title[0];

  return fields;
}

// POST /api/bib/enrich
// Body: { entries: [{ key, title, author, existingFields: {field: value} }], fields: ['doi', 'pages', ...] }
// Returns: { results: [{ key, found: bool, added: {field: value}, source: 'crossref' }] }
router.post('/enrich', async (req, res) => {
  const { entries, fields } = req.body;
  if (!Array.isArray(entries) || !Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ error: 'entries and fields arrays required' });
  }
  if (entries.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 entries per request' });
  }

  const results = [];

  // Process entries in parallel with concurrency limit
  const batchSize = 5;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const title = stripBraces(entry.title);
        const author = stripBraces(entry.author);

        if (!title) {
          return { key: entry.key, found: false, added: {} };
        }

        const item = await lookupCrossRef(title, author);
        if (!item) {
          return { key: entry.key, found: false, added: {} };
        }

        const available = extractFields(item);
        const added = {};

        for (const field of fields) {
          // Only add if the entry doesn't already have this field
          const existing = entry.existingFields || {};
          if (existing[field]) continue;

          // Map requested field to available data
          if (available[field]) {
            added[field] = available[field];
          }
        }

        return { key: entry.key, found: true, added, source: 'crossref' };
      }),
    );

    results.push(...batchResults);
  }

  res.json({ results });
});

export default router;
