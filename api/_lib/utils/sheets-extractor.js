/**
 * Intelligent Google Sheets Content Extractor v2
 *
 * Parses CSV from Google Sheets and returns structured per-row data
 * so the analysis engine can evaluate each piece of content individually.
 *
 * Returns rows with: content text, metadata (URLs, subreddit, status), row number.
 */

const { askClaude } = require('../connectors/claude');

// Content-type-specific guidance for extraction
const EXTRACTION_HINTS = {
  reddit_review: {
    label: 'Reddit comment/post',
    contentColumns: 'comment, post, body, text, reddit_content, review, comment_text, draft, copy, content',
    metaColumns: 'thread_url, url, subreddit, thread_title, status, client, link, notes',
    instructions: `Find the column containing the ACTUAL Reddit comment or post text.
Also capture metadata columns: thread URL, subreddit, status, any links.
Extract each row as a separate item — these are individual Reddit comments to review.`,
  },
  guest_post: {
    label: 'guest post article',
    contentColumns: 'article, body, content, draft, copy, post_content, text',
    metaColumns: 'target_site, url, author_bio, cta, brand_mention, status, publish_date',
    instructions: `Find the article body/content column plus any brand mention or CTA columns.
Also capture: target site URL, author bio, status.
Each row is a separate guest post to review.`,
  },
  on_site: {
    label: 'website content',
    contentColumns: 'content, body, page_content, copy, text, article, description, draft',
    metaColumns: 'title, h1, heading, page_title, slug, url, meta_description, status',
    instructions: `Find the main content/body column and any title/heading columns.
Also capture: page URL/slug, meta description, status.
Each row is a separate page or content piece.`,
  },
  social_media: {
    label: 'social media post',
    contentColumns: 'caption, post, content, message, tweet, copy, text, post_text',
    metaColumns: 'platform, posting_date, hashtags, url, link, status',
    instructions: `Find the caption/post text column. Include hashtags if in the same column.
Also capture: platform, posting date, any links.
Each row is a separate social post.`,
  },
};

/**
 * Parse CSV text into array of objects with headers.
 * Handles quoted fields with commas and newlines.
 */
function parseCSV(csvText) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  const lines = csvText.split('\n');

  // Simple CSV parser that handles quoted fields
  const parseLine = (line) => {
    const fields = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === ',' && !inQ) {
        fields.push(field.trim());
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  // Merge lines that are part of quoted fields
  const mergedLines = [];
  let buffer = '';
  let quoteCount = 0;
  for (const line of lines) {
    buffer += (buffer ? '\n' : '') + line;
    quoteCount += (line.match(/"/g) || []).length;
    if (quoteCount % 2 === 0) {
      mergedLines.push(buffer);
      buffer = '';
      quoteCount = 0;
    }
  }
  if (buffer) mergedLines.push(buffer);

  if (mergedLines.length < 2) return { headers: [], rows: [] };

  const headers = parseLine(mergedLines[0]);
  for (let i = 1; i < mergedLines.length; i++) {
    if (!mergedLines[i].trim()) continue;
    const fields = parseLine(mergedLines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = fields[idx] || '';
    });
    row.__rowNum = i + 1; // 1-indexed, header is row 1
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Use Claude to identify which columns are content vs metadata.
 */
async function identifyColumns(headers, sampleRows, contentType) {
  const hint = EXTRACTION_HINTS[contentType] || EXTRACTION_HINTS.on_site;

  const systemPrompt = `You identify spreadsheet column roles. Respond ONLY with valid JSON, no markdown.`;

  const sampleData = sampleRows.slice(0, 2).map(r => {
    const obj = {};
    headers.forEach(h => { if (r[h]) obj[h] = r[h].slice(0, 150); });
    return obj;
  });

  const userPrompt = `Content type: ${contentType} (${hint.label})

Headers: ${JSON.stringify(headers)}

Sample rows:
${JSON.stringify(sampleData, null, 2)}

${hint.instructions}

Likely content columns: ${hint.contentColumns}
Likely metadata columns: ${hint.metaColumns}

Respond with:
{
  "contentColumns": ["header names containing the actual text to review"],
  "metaColumns": {"thread_url": "header name", "subreddit": "header name", "status": "header name", "link": "header name", "title": "header name"},
  "confidence": 0.95
}

Map metaColumns keys to actual header names found. Only include keys where a matching header exists.`;

  try {
    const result = await askClaude(systemPrompt, userPrompt, { maxTokens: 1000, timeout: 45000, model: 'claude-haiku-4-5-20251001' });
    const jsonStr = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[sheets-extractor] Column identification failed:', err.message);
    return null;
  }
}

/**
 * Extract structured per-row data from Google Sheets CSV.
 *
 * @param {string} csvData    - Raw CSV text from Google Sheets export
 * @param {string} contentType - One of: reddit_review, guest_post, on_site, social_media
 * @param {string} sheetUrl   - Original Google Sheets URL
 * @returns {Promise<{rows: Array, summary: string, fallback: boolean}>}
 */
async function extractSheetContent(csvData, contentType, sheetUrl) {
  try {
    const { headers, rows } = parseCSV(csvData);

    if (headers.length === 0 || rows.length === 0) {
      console.log('[sheets-extractor] No parseable data in CSV');
      return { rows: [], summary: 'Empty or unparseable spreadsheet', fallback: true, rawCSV: csvData.slice(0, 15000) };
    }

    console.log(`[sheets-extractor] Parsed ${rows.length} rows, ${headers.length} columns: ${headers.join(', ')}`);

    // Use Claude to identify content vs metadata columns
    const columnMap = await identifyColumns(headers, rows, contentType);

    if (!columnMap || !columnMap.contentColumns?.length || columnMap.confidence < 0.5) {
      console.log('[sheets-extractor] Column identification failed or low confidence');
      return { rows: [], summary: 'Could not identify content columns', fallback: true, rawCSV: csvData.slice(0, 15000) };
    }

    console.log(`[sheets-extractor] Content columns: ${columnMap.contentColumns.join(', ')} | Meta: ${JSON.stringify(columnMap.metaColumns)}`);

    // Extract structured rows
    const extractedRows = [];
    for (const row of rows) {
      // Get content from identified content columns
      const contentParts = columnMap.contentColumns
        .map(col => row[col]?.trim())
        .filter(Boolean);

      if (contentParts.length === 0) continue; // Skip empty rows

      const content = contentParts.join('\n\n');

      // Get metadata
      const meta = {};
      if (columnMap.metaColumns) {
        for (const [key, headerName] of Object.entries(columnMap.metaColumns)) {
          if (headerName && row[headerName]) {
            meta[key] = row[headerName].trim();
          }
        }
      }

      extractedRows.push({
        rowNum: row.__rowNum,
        content,
        meta,
        contentColumns: columnMap.contentColumns,
      });
    }

    if (extractedRows.length === 0) {
      return { rows: [], summary: 'No content found in identified columns', fallback: true, rawCSV: csvData.slice(0, 15000) };
    }

    const summary = `Found ${extractedRows.length} content row(s) from columns: ${columnMap.contentColumns.join(', ')}`;
    console.log(`[sheets-extractor] ${summary}`);

    return {
      rows: extractedRows,
      summary,
      fallback: false,
      headers,
      columnMap,
    };
  } catch (err) {
    console.error(`[sheets-extractor] Extraction failed:`, err.message);
    return { rows: [], summary: `Extraction error: ${err.message}`, fallback: true, rawCSV: csvData.slice(0, 15000) };
  }
}

module.exports = { extractSheetContent, parseCSV };
