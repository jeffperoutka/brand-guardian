/**
 * Intelligent Google Sheets Content Extractor
 *
 * When a user submits a Google Sheets URL for brand checking, the raw CSV
 * isn't useful — we need to identify and extract the actual content column(s)
 * (e.g., the Reddit comment in column C) for analysis.
 *
 * Uses a lightweight Claude call to parse CSV structure and pull out the
 * content that matters based on the content type being checked.
 */

const { askClaude } = require('../connectors/claude');

// Content-type-specific guidance for extraction
const EXTRACTION_HINTS = {
  reddit_review: {
    label: 'Reddit comment/post',
    instructions: `This spreadsheet tracks Reddit comments or posts for brand influence.
Find the column(s) containing the ACTUAL Reddit comment or post text that will be submitted publicly.
Common header names: "comment", "post", "body", "text", "reddit_content", "review", "comment_text", "draft", "copy", "content".
IGNORE columns like: "status", "posted", "date", "url", "thread_url", "client", "tracking", "schedule", "subreddit", "thread_title", "upvotes", "link", "notes".
Extract the comment/post text EXACTLY as written — preserve all punctuation, line breaks, and formatting.
If there are multiple rows with content, extract each one separated by "---ROW BREAK---".`,
  },

  guest_post: {
    label: 'guest post article',
    instructions: `This spreadsheet contains guest post content for off-site publication.
Find the column(s) with the article body, content, or draft text.
Common headers: "article", "body", "content", "draft", "copy", "post_content", "text".
Also look for brand mention sections in separate columns: "brand_mention", "author_bio", "cta".
IGNORE: "target_site", "status", "editor", "publish_date", "word_count", "da_score", "outreach_email".
Extract the full article text. If brand mention is in a separate column, append it clearly labeled.`,
  },

  on_site: {
    label: 'website content',
    instructions: `This spreadsheet contains content destined for the client's website.
Find the main content/body column — the actual page text being created.
Common headers: "content", "body", "page_content", "copy", "text", "article", "description", "draft".
Also grab title/heading columns if present: "title", "h1", "heading", "page_title".
IGNORE: "slug", "url", "seo_notes", "template", "status", "assigned_to", "meta_description", "word_count".
Extract all content columns in logical order (title first, then body).`,
  },

  social_media: {
    label: 'social media post',
    instructions: `This spreadsheet contains social media content.
Find the column with the actual caption or post text.
Common headers: "caption", "post", "content", "message", "tweet", "copy", "text", "post_text".
Include hashtags if they're part of the caption column.
IGNORE: "platform", "posting_date", "schedule_time", "status", "engagement", "impressions", "likes", "posted_by".
Extract each post/caption exactly as written.`,
  },
};

/**
 * Extract relevant content from Google Sheets CSV data using Claude.
 *
 * @param {string} csvData   - Raw CSV text from Google Sheets export
 * @param {string} contentType - One of: reddit_review, guest_post, on_site, social_media
 * @param {string} sheetUrl  - Original Google Sheets URL (for logging)
 * @returns {Promise<{extractedContent: string, contextData: object|null, extractionMethod: string, fallback: boolean}>}
 */
async function extractSheetContent(csvData, contentType, sheetUrl) {
  const hint = EXTRACTION_HINTS[contentType] || EXTRACTION_HINTS.on_site;

  // Truncate CSV to keep extraction call efficient (first 10K chars is plenty)
  const csvSample = csvData.slice(0, 10000);

  const systemPrompt = `You are an expert at reading Google Sheets CSV exports and extracting the relevant content for brand review.
Your job: identify which column(s) contain the actual ${hint.label} text, then extract that text cleanly.
Do NOT summarize or modify the content — extract it VERBATIM.
Respond ONLY with valid JSON, no markdown fences.`;

  const userPrompt = `Content type being reviewed: ${contentType}

${hint.instructions}

Here is the CSV data from the spreadsheet:

${csvSample}

Respond with this exact JSON structure:
{
  "extractedContent": "The verbatim text from the content column(s), each row separated by ---ROW BREAK--- if multiple",
  "contextData": {
    "clientOrBrand": "client/brand name if visible in the sheet",
    "threadUrl": "Reddit thread URL or target URL if found",
    "additionalContext": "any other useful context from surrounding columns (subreddit, target site, etc.)"
  },
  "columnsUsed": "Which column header(s) the content came from",
  "confidence": 0.95,
  "rowCount": 1
}`;

  try {
    console.log(`[sheets-extractor] Extracting ${hint.label} from sheet (${csvData.length} chars CSV)`);

    const result = await askClaude(systemPrompt, userPrompt, {
      maxTokens: 3000,
      timeout: 15000, // 15s max for extraction
    });

    // Parse JSON response — Claude sometimes wraps in markdown fences
    const jsonStr = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);

    const confidence = parsed.confidence || 0;
    const extractedContent = (parsed.extractedContent || '').trim();

    if (!extractedContent || confidence < 0.5) {
      console.log(`[sheets-extractor] Low confidence (${confidence}) or empty extraction — falling back`);
      return {
        extractedContent: csvData.slice(0, 15000),
        contextData: null,
        extractionMethod: `Fallback: low confidence (${confidence})`,
        fallback: true,
      };
    }

    console.log(`[sheets-extractor] Extracted ${extractedContent.length} chars from columns: ${parsed.columnsUsed} (confidence: ${confidence}, rows: ${parsed.rowCount})`);

    return {
      extractedContent,
      contextData: parsed.contextData || null,
      extractionMethod: `Extracted from columns: ${parsed.columnsUsed || 'auto-detected'}`,
      fallback: false,
    };
  } catch (err) {
    console.error(`[sheets-extractor] Extraction failed:`, err.message);
    return {
      extractedContent: csvData.slice(0, 15000),
      contextData: null,
      extractionMethod: `Fallback: extraction error (${err.message})`,
      fallback: true,
    };
  }
}

module.exports = { extractSheetContent };
