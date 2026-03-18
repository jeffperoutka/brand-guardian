/**
 * Brand Context Manager — Enrichment Edition (Google Docs)
 *
 * ONE LIVING DOC — all research appends to the existing Client Info Doc in Google Docs.
 * No separate pages. The doc grows over time as a master brand reference.
 *
 * Flow:
 * 1. Find the Client Info Doc in Google Drive
 * 2. Read its content — check if Brand Guardian research section already exists
 * 3. If research exists AND not forceRefresh — parse it into a structured profile, done
 * 4. If no research OR forceRefresh — run deep research (website crawl + doc analysis)
 *    — APPEND findings to the same doc (below existing content)
 * 5. Return structured brand profile
 */

const { askClaudeLong } = require('./connectors/claude');
const github = require('./connectors/github');
const gdrive = require('./connectors/gdrive');

const MAX_DOC_CHARS = 30000;

/**
 * Safely extract JSON from Claude response that may contain markdown fences or extra text.
 */
function extractJSON(text) {
  try { return JSON.parse(text); } catch(e) {}
  // Strip markdown fences (```json ... ```)
  const stripped = text.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();
  try { return JSON.parse(stripped); } catch(e) {}
  // Extract everything between first { and last }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const jsonStr = text.substring(first, last + 1);
    try { return JSON.parse(jsonStr); } catch(e) {}
    // Fix trailing commas
    const noTrailing = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(noTrailing); } catch(e) {}
    // Fix literal newlines/control chars inside string values
    // Walk through char by char, escape control chars only when inside a string
    let fixed = '', inString = false, escaped = false;
    for (let i = 0; i < noTrailing.length; i++) {
      const ch = noTrailing[i];
      if (escaped) { fixed += ch; escaped = false; continue; }
      if (ch === '\\') { fixed += ch; escaped = true; continue; }
      if (ch === '"') { inString = !inString; fixed += ch; continue; }
      if (inString && ch === '\n') { fixed += '\\n'; continue; }
      if (inString && ch === '\r') { fixed += '\\r'; continue; }
      if (inString && ch === '\t') { fixed += '\\t'; continue; }
      fixed += ch;
    }
    try { return JSON.parse(fixed); } catch(e) {
      // Log the actual parse error and the area around where it fails
      const pos = e.message.match(/position\s+(\d+)/i)?.[1];
      const context = pos ? fixed.substring(Math.max(0, +pos - 50), +pos + 50) : '';
      throw new Error('JSON parse failed after all fixups: ' + e.message + (context ? ' | near: ...' + context + '...' : '') + ' (length=' + fixed.length + ')');
    }
  }
  throw new Error('Could not extract JSON from response (length=' + text.length + ', preview=' + text.substring(0, 100) + ')');
}

const BRAND_CACHE_PREFIX = 'brand-cache';
const RESEARCH_MARKER_CHECK = 'BRAND GUARDIAN RESEARCH';

// ── GOOGLE DOCS HELPERS ──

/**
 * Find a Client Info Doc by checking:
 * 1. GitHub-cached index (fast)
 * 2. Google Drive search (fallback)
 */
async function findClientInfoDoc(clientName) {
  const clientLower = clientName.toLowerCase().trim();
  console.log(`[findClientInfoDoc] Looking for Info Doc for client: "${clientName}"`);

  // 1. Check GitHub index first
  try {
    const cached = await github.readFile(`${BRAND_CACHE_PREFIX}/info-docs-index.json`);
    if (cached?.docs) {
      const match = cached.docs.find(d => {
        const nameLower = d.name.toLowerCase();
        return nameLower === clientLower || nameLower.includes(clientLower) || clientLower.includes(nameLower);
      });
      if (match) {
        console.log(`[findClientInfoDoc] Found in index: "${match.docName}" (ID: ${match.docId})`);
        return { docId: match.docId, docName: match.docName, docUrl: match.docUrl, folderId: match.folderId, source: match.source || 'index' };
      }
    }
  } catch (err) {
    console.error('[findClientInfoDoc] Index lookup failed:', err.message);
  }

  // 2. Search Google Drive
  try {
    const doc = await gdrive.findDoc(`${clientName} Client Info`, null);
    if (doc) {
      console.log(`[findClientInfoDoc] Found in Google Drive: "${doc.docName}" (ID: ${doc.docId})`);
      return { docId: doc.docId, docName: doc.docName, docUrl: doc.docUrl, source: 'google-drive' };
    }
  } catch (err) {
    console.error('[findClientInfoDoc] Google Drive search failed:', err.message);
  }

  console.log(`[findClientInfoDoc] No Info Doc found for "${clientName}"`);
  return null;
}

/**
 * Read the content of a Google Doc.
 * Returns { content, docId } or { content: '', error: '...' }
 */
async function readDocContent(docId) {
  console.log(`[readDocContent] Reading Google Doc ${docId}`);

  try {
    const content = await gdrive.readDoc(docId);
    return { content: content || '', docId };
  } catch (err) {
    console.error(`[readDocContent] Google Docs API error:`, err.message);
    return { content: '', docId, error: err.message };
  }
}

/**
 * Append brand research to a Google Doc.
 */
async function appendResearchToDoc(docId, clientName, research) {
  console.log(`[appendResearchToDoc] Appending to Google Doc ${docId}`);

  const researchText = formatResearchText(clientName, research);

  try {
    await gdrive.appendToDoc(docId, researchText);
    console.log(`[appendResearchToDoc] Success`);
    return { ok: true };
  } catch (err) {
    console.error('[appendResearchToDoc] error:', err.message);
    return null;
  }
}

/**
 * Format research as plain text for Google Docs.
 */
function formatResearchText(clientName, research) {
  const date = new Date().toISOString().split('T')[0];
  let text = '';

  text += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  text += '🛡️ BRAND GUARDIAN RESEARCH\n\n';
  text += `Auto-generated on ${date} — updated by Brand Guardian\n`;
  text += 'This section is used for brand alignment checks, content creation, and brand-consistent output.\n\n';
  text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  text += 'BRAND OVERVIEW\n';
  text += `${research.brandOverview || 'N/A'}\n\n`;

  text += 'TARGET AUDIENCE\n';
  text += `Primary: ${research.targetAudience?.primary || 'Unknown'}\n`;
  text += `Secondary: ${research.targetAudience?.secondary || 'N/A'}\n`;
  text += `Demographics: ${research.targetAudience?.demographics || 'Unknown'}\n`;
  text += `Psychographics: ${research.targetAudience?.psychographics || 'Unknown'}\n\n`;

  text += 'BRAND VOICE & TONE\n';
  text += `Tone: ${research.brandVoice?.tone || 'Unknown'}\n`;
  text += `Personality: ${research.brandVoice?.personality || 'Unknown'}\n`;
  text += `Do Not Say: ${(research.brandVoice?.doNotSay || []).join(', ') || 'None specified'}\n`;
  text += `Preferred Terms: ${(research.brandVoice?.preferredTerms || []).join(', ') || 'None specified'}\n\n`;

  text += 'PRODUCTS & SERVICES\n';
  text += `${(research.coreOfferings?.products || []).map(p => `• ${p}`).join('\n') || 'Not specified'}\n\n`;
  text += `Value Proposition: ${research.coreOfferings?.valueProposition || 'Unknown'}\n`;
  text += `Key Benefits: ${(research.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}\n`;
  text += `Pricing Tier: ${research.coreOfferings?.pricingTier || 'Unknown'}\n\n`;

  text += 'COMPETITIVE LANDSCAPE\n';
  text += `${(research.competitors || []).map(c => {
    if (typeof c === 'string') return `• ${c}`;
    return `• ${c.name}: ${c.differentiator || ''}`;
  }).join('\n') || 'No competitors identified'}\n\n`;
  text += `Key Differentiators: ${research.competitiveDifferentiators || 'Not specified'}\n\n`;

  text += 'CONTENT THEMES\n';
  text += `On-Brand Topics: ${(research.contentThemes?.onBrandTopics || []).join(', ') || 'Unknown'}\n`;
  text += `Adjacent Topics (guest posts): ${(research.contentThemes?.adjacentTopics || []).join(', ') || 'Unknown'}\n`;
  text += `Off-Limit Topics: ${(research.contentThemes?.offLimitTopics || []).join(', ') || 'None specified'}\n\n`;

  text += 'KEY MESSAGES\n';
  text += `${(research.keyMessages || []).map(m => `• ${m}`).join('\n') || 'Not specified'}\n\n`;

  text += 'WEBSITE INSIGHTS\n';
  text += `Content Style: ${research.websiteInsights?.contentStyle || 'Unknown'}\n`;
  text += `CTA Patterns: ${research.websiteInsights?.ctaPatterns || 'Unknown'}\n`;
  text += `Social Proof: ${research.websiteInsights?.socialProof || 'Unknown'}\n`;
  text += `Pages Analyzed: ${(research.websiteInsights?.mainPages || []).join(', ') || 'Unknown'}\n\n`;

  text += 'INDUSTRY CONTEXT\n';
  text += `${research.industryContext || 'Not available'}\n`;

  return text;
}

// ── WEBSITE CRAWLING ──

async function deepCrawlWebsite(url) {
  if (!url.startsWith('http')) url = `https://${url}`;
  const baseUrl = new URL(url).origin;

  // Core pages only — must finish crawl in ~10s to leave ~50s for Claude
  const pagePaths = [
    '/', '/about', '/about-us',
    '/services', '/products', '/solutions',
    '/pricing',
    '/features', '/how-it-works',
    '/testimonials',
    '/why-us',
  ];

  const pages = [];
  const crawled = new Set();

  async function crawlPage(path) {
    if (crawled.has(path)) return null;
    crawled.add(path);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'BrandGuardian/1.0 (brand-enrichment-bot)' },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (resp.ok && resp.headers.get('content-type')?.includes('text/html')) {
        const html = await resp.text();
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

        if (text.length > 100) {
          pages.push({
            path,
            title: titleMatch?.[1]?.trim() || '',
            metaDescription: metaMatch?.[1]?.trim() || '',
            text,
          });
        }

        return html;
      }
    } catch (err) { /* skip — timeout or network error */ }
    return null;
  }

  // Crawl in parallel batches of 5 for speed
  for (let i = 0; i < pagePaths.length; i += 5) {
    const batch = pagePaths.slice(i, i + 5);
    await Promise.all(batch.map(path => crawlPage(path)));
  }

  return pages;
}

function formatCrawledPages(pages) {
  return pages.map(p =>
    `--- PAGE: ${p.path} ---\nTitle: ${p.title || 'N/A'}\nMeta: ${p.metaDescription || 'N/A'}\n${p.text}`
  ).join('\n\n').slice(0, 15000);
}

// ── RESEARCH & PROFILE BUILDING ──

function hasExistingResearch(docContent) {
  return docContent.includes(RESEARCH_MARKER_CHECK);
}

/**
 * Run deep research — website crawl + Claude analysis.
 * This is the core enrichment engine.
 */
async function runDeepResearch(clientName, existingDocContent, websiteUrl, progressCallback, options = {}) {
  if (existingDocContent && existingDocContent.length > MAX_DOC_CHARS) {
    console.log('[runDeepResearch] Truncating existingDocContent from ' + existingDocContent.length + ' to ' + MAX_DOC_CHARS);
    existingDocContent = existingDocContent.substring(0, MAX_DOC_CHARS);
  }

  if (progressCallback) await progressCallback('Crawling website pages...');
  let crawledPages = [];
  let websiteData = '';
  const crawlStart = Date.now();
  if (websiteUrl) {
    crawledPages = await deepCrawlWebsite(websiteUrl);
    websiteData = formatCrawledPages(crawledPages);
  }
  const crawlMs = Date.now() - crawlStart;

  console.log(`[runDeepResearch] Crawled ${crawledPages.length} pages in ${crawlMs}ms, websiteData=${websiteData.length} chars, docContent=${(existingDocContent||'').length} chars`);
  if (progressCallback) await progressCallback(`Analyzing ${crawledPages.length} pages + Client Info Doc...`);

  const hasNotes = !!(options.enrichmentNotes && options.enrichmentNotes.trim());

  const directivesBlock = hasNotes
    ? `

━━━ TEAM DIRECTIVES (MANDATORY — OVERRIDE EVERYTHING) ━━━
${options.enrichmentNotes}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL: The directives above are HARD CONSTRAINTS from the team. They represent the client's CURRENT strategic direction.
- If the directives say to FOCUS on certain topics → the entire profile must be framed around those topics.
- If the directives say to AVOID or NOT MENTION certain topics → those topics must be COMPLETELY EXCLUDED from every section of the profile. Do not list them in products, do not mention them in brand overview, do not include them in content themes, do not reference them in key messages. Act as if those topics DO NOT EXIST for this brand.
- The website may contain content about avoided topics — IGNORE IT. The team knows the brand better than the website reflects.
- This is not a suggestion. Violating these directives makes the entire profile useless.`
    : '';

  const systemPrompt = `You are a Brand Research Specialist at AEO Labs (AI SEO agency). Your job is to conduct deep brand research and compile a comprehensive client profile.
${directivesBlock}

This profile will be THE source of truth for:
- Future content creation bots (so they write in the right voice)
- Brand alignment checkers (so they can verify content matches the brand)
- Link building teams (so outreach and guest posts are on-brand)
- Reddit/social teams (so comments and posts sound authentic)

You must be THOROUGH and OPINIONATED. A vague profile is useless.

Data sources:
1. Client Info Doc — their answers about their business (onboarding questionnaire)
2. Website content — crawled pages from their actual site

OUTPUT — valid JSON only, no markdown fences, no literal newlines inside string values (use \\n instead):
{
  "brandOverview": "3-5 sentence overview of who they are, what they do, and how they position themselves in the market",
  "website": "main URL",
  "industry": "specific industry/niche (not just 'technology' — be precise)",
  "targetAudience": {
    "primary": "detailed primary audience — who buys from them",
    "secondary": "secondary audience if any",
    "demographics": "age, location, income, job titles, company size",
    "psychographics": "interests, values, pain points, motivations"
  },
  "brandVoice": {
    "tone": "detailed tone analysis — not just 'professional'. HOW do they write? Are they formal or casual? Data-driven or story-driven? Aspirational or practical? Give examples.",
    "personality": "brand personality traits with evidence from their content",
    "doNotSay": ["specific phrases, topics, or approaches they avoid or should avoid based on their positioning"],
    "preferredTerms": ["terminology they consistently use — their vocabulary"]
  },
  "coreOfferings": {
    "products": ["each product/service with a brief description of what it actually does"],
    "valueProposition": "their unique value prop — why choose them over alternatives",
    "keyBenefits": ["specific benefits they emphasize, not generic ones"],
    "pricingTier": "budget/mid-range/premium/enterprise — with evidence for why"
  },
  "competitors": [{"name": "Competitor Name", "differentiator": "How the client differs from this competitor"}],
  "competitiveDifferentiators": "what makes them genuinely stand out — be specific, not 'great customer service'",
  "contentThemes": {
    "onBrandTopics": ["topics they'd publish on their own blog — things that showcase their expertise"],
    "adjacentTopics": ["loosely related topics suitable for guest posts and link building"],
    "offLimitTopics": ["topics that would damage their brand, confuse their audience, or misrepresent them"]
  },
  "keyMessages": ["core marketing messages, taglines, and value statements they repeat"],
  "websiteInsights": {
    "contentStyle": "how they write — sentence length, complexity, use of data/stats, storytelling approach, formatting preferences",
    "ctaPatterns": "what their calls-to-action look like — language, placement, urgency level",
    "socialProof": "how they use testimonials, case studies, logos, numbers",
    "mainPages": ["key page types found on the site"]
  },
  "industryContext": "2-3 sentences about the competitive landscape and market trends relevant to this brand"
}

RULES:
1. Be specific and opinionated. "Professional tone" = useless. Say exactly HOW they sound with examples.
2. For doNotSay — what would make their audience cringe? What's off-brand? ALSO include any topics from team directives.
3. Only list competitors you can actually identify from the content.
4. Adjacent topics = what industry publications cover that overlaps with this brand's audience.
5. Off-limit topics = what would damage their credibility or confuse their positioning. ALWAYS include avoided topics from team directives here.
6. TEAM DIRECTIVES OVERRIDE WEBSITE DATA. If the team says "do not mention X" but the website talks about X extensively, you EXCLUDE X from the profile entirely. The team's word is final.
7. Cross-reference the Info Doc answers with the website — note any discrepancies.
8. The profile should be detailed enough that someone who has NEVER heard of this brand can write content for them.
9. Before finalizing, re-read the team directives (if any) and verify EVERY section of your output complies. If an avoided topic appears anywhere, remove it.`;

  const userContent = `Research this client thoroughly:

CLIENT: ${clientName}

CLIENT INFO DOC (onboarding answers):
${existingDocContent || '(No client info doc content available)'}

WEBSITE (${crawledPages.length} pages crawled):
${websiteData || '(No website data — could not crawl or no URL provided)'}

Build the most thorough, opinionated profile possible. This will be used by content creators and AI bots to ensure everything produced is perfectly on-brand.`;

  // Vercel Pro allows up to 300s per function invocation.
  // Use Sonnet for higher quality output now that we have the time budget.
  // Dynamic timeout: 240s total budget minus crawl time, with a floor of 60s.
  const claudeTimeout = Math.max(60000, 240000 - crawlMs);
  console.log(`[runDeepResearch] Claude timeout: ${claudeTimeout}ms (crawl took ${crawlMs}ms)`);
  const result = await askClaudeLong(systemPrompt, userContent, {
    maxTokens: 8000,
    timeout: claudeTimeout,
  });

  try {
    return extractJSON(result);
  } catch (err) {
    console.error('Failed to parse research:', err.message, 'Response length:', result?.length);
    return { _parseError: err.message, _rawPreview: result?.substring(0, 300) };
  }
}

/**
 * Parse existing research from the doc into structured profile.
 */
async function parseExistingResearch(docContent, clientName) {
  if (docContent && docContent.length > MAX_DOC_CHARS) {
    console.log('[parseExisting] Truncating docContent from ' + docContent.length + ' to ' + MAX_DOC_CHARS);
    docContent = docContent.substring(0, MAX_DOC_CHARS);
  }

  const result = await askClaudeLong(
    `Parse this client's brand document into a structured profile. The doc contains their original info answers AND brand research findings. Extract everything into a single comprehensive profile.

OUTPUT — valid JSON only, no markdown fences, no literal newlines inside string values (use \\n instead):
{
  "brandOverview": "string",
  "website": "string",
  "industry": "string",
  "targetAudience": { "primary": "", "secondary": "", "demographics": "", "psychographics": "" },
  "brandVoice": { "tone": "", "personality": "", "doNotSay": [], "preferredTerms": [] },
  "coreOfferings": { "products": [], "valueProposition": "", "keyBenefits": [], "pricingTier": "" },
  "competitors": [{"name": "", "differentiator": ""}],
  "competitiveDifferentiators": "",
  "contentThemes": { "onBrandTopics": [], "adjacentTopics": [], "offLimitTopics": [] },
  "keyMessages": [],
  "websiteInsights": { "contentStyle": "", "ctaPatterns": "", "socialProof": "", "mainPages": [] },
  "industryContext": ""
}

Prioritize the MOST RECENT information if there are conflicts.`,
    `CLIENT: ${clientName}\n\nFULL DOCUMENT:\n${docContent}`,
    { maxTokens: 5000, timeout: 90000 }
  );

  try {
    return extractJSON(result);
  } catch (err) {
    console.error('Failed to parse existing research:', err.message);
    return null;
  }
}

// ── MAIN ORCHESTRATOR ──

/**
 * Get or build brand profile.
 *
 * Options:
 * - forceRefresh: true — always re-run research (used by enrichment skill)
 * - enrichmentNotes: string — focus areas for the research
 * - docId: string — Google Doc ID (from dropdown selection or Typeform pipeline)
 */
async function getOrBuildBrandProfile(clientName, websiteUrl, progressCallback, options = {}) {
  const cacheKey = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const forceRefresh = options.forceRefresh || false;

  // Check GitHub cache (skip if forceRefresh)
  if (!forceRefresh) {
    const cached = await github.readFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`);
    const cacheAge = cached?.cachedAt ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;
    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

    if (cached && cacheAge < CACHE_TTL) {
      if (progressCallback) await progressCallback('Brand profile loaded from cache.');
      return { profile: cached, source: 'cache', researchNeeded: false };
    }
  }

  // Find the Client Info Doc
  let docInfo = null;
  if (options.docId) {
    if (progressCallback) await progressCallback('Loading Client Info Doc...');
    docInfo = { docId: options.docId, docName: `${clientName} Client Info Doc` };
    console.log(`[getOrBuildBrandProfile] Using provided docId: ${options.docId} for "${clientName}"`);
  } else {
    if (progressCallback) await progressCallback('Searching for Client Info Doc...');
    docInfo = await findClientInfoDoc(clientName);
  }

  let fullContent = '';

  if (docInfo) {
    if (progressCallback) await progressCallback(`Found "${docInfo.docName}". Reading...`);
    const docData = await readDocContent(docInfo.docId);
    fullContent = docData.content || '';

    if (docData.error) {
      console.error(`[getOrBuildBrandProfile] Error reading doc: ${docData.error}`);
    }

    // If existing research and NOT force refresh, parse and return
    if (fullContent && hasExistingResearch(fullContent) && !forceRefresh) {
      if (progressCallback) await progressCallback('Existing research found. Building profile...');
      const profile = await parseExistingResearch(fullContent, clientName);
      if (profile) {
        const profileWithMeta = { ...profile, clientName, cachedAt: new Date().toISOString(), cacheKey, googleDocId: docInfo.docId };
        await github.writeFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);
        return { profile: profileWithMeta, source: 'existing_research', researchNeeded: false };
      }
    }
  } else {
    console.log(`No Info Doc found for "${clientName}" — will attempt website-only research`);
  }

  // Extract website URL from doc if not provided
  if (!websiteUrl && fullContent) {
    const urlMatch = fullContent.match(/https?:\/\/(?:www\.)?[a-zA-Z0-9\-]+\.[a-zA-Z]{2,}(?:\/[^\s)]*)?/);
    if (urlMatch) websiteUrl = urlMatch[0];
  }

  if (!websiteUrl && !fullContent) {
    const errorDetail = options.docId
      ? `Found the Info Doc (ID: ${options.docId}) but could not read its content. Try again or provide a website URL.`
      : `Could not find a Client Info Doc for "${clientName}" and no website URL was provided.`;
    return { profile: null, source: 'none', error: errorDetail };
  }

  // Run deep research
  if (progressCallback) {
    const label = forceRefresh
      ? 'Running fresh brand enrichment research...'
      : docInfo
        ? 'No existing research. Running deep brand research...'
        : 'No Info Doc found — running brand research from website...';
    await progressCallback(label);
  }

  const research = await runDeepResearch(clientName, fullContent, websiteUrl, progressCallback, {
    enrichmentNotes: options.enrichmentNotes,
  });

  if (!research) {
    return { profile: null, source: 'none', error: 'Deep research failed. Check logs.' };
  }

  // Append research to the Google Doc
  let savedToDoc = false;
  if (docInfo) {
    if (progressCallback) await progressCallback('Saving research to Google Doc...');
    const appendResult = await appendResearchToDoc(docInfo.docId, clientName, research);
    savedToDoc = !!appendResult;

    if (savedToDoc) {
      console.log(`[getOrBuildBrandProfile] Successfully saved research to Google Doc`);
    } else {
      console.error(`[getOrBuildBrandProfile] Failed to save research to Google Doc ${docInfo.docId}`);
      if (progressCallback) await progressCallback('⚠️ Research complete but failed to save to Google Doc. Caching in GitHub...');
    }
  }

  // Cache in GitHub
  const profileWithMeta = { ...research, clientName, cachedAt: new Date().toISOString(), cacheKey, googleDocId: docInfo?.docId };
  await github.writeFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);

  return { profile: profileWithMeta, source: 'new_research', researchNeeded: true, savedToDoc };
}

const INFO_DOCS_INDEX_PATH = `${BRAND_CACHE_PREFIX}/info-docs-index.json`;
const INFO_DOCS_INDEX_TTL = 6 * 60 * 60 * 1000; // 6 hours

/**
 * List all Client Info Docs — GitHub-cached, refreshed from Google Drive.
 */
async function listInfoDocs() {
  // 1. Try GitHub cache first (single fast API call)
  try {
    const cached = await github.readFile(INFO_DOCS_INDEX_PATH);
    if (cached && cached.docs && Array.isArray(cached.docs)) {
      const age = cached.updatedAt ? Date.now() - new Date(cached.updatedAt).getTime() : Infinity;
      if (age < INFO_DOCS_INDEX_TTL) {
        console.log(`[listInfoDocs] Serving ${cached.docs.length} docs from GitHub cache (age: ${Math.round(age / 60000)}m)`);
        return cached.docs;
      }
      console.log(`[listInfoDocs] GitHub cache stale (age: ${Math.round(age / 60000)}m), refreshing from Google Drive`);
    }
  } catch (err) {
    console.error('[listInfoDocs] GitHub cache read failed:', err.message);
  }

  // 2. Refresh from Google Drive
  const results = await fetchInfoDocsFromGoogleDrive();

  // 3. Save to GitHub cache
  if (results.length > 0) {
    try {
      await github.writeFile(INFO_DOCS_INDEX_PATH, {
        docs: results,
        updatedAt: new Date().toISOString(),
        count: results.length,
      }, 'auto: refresh info docs index');
      console.log(`[listInfoDocs] Saved ${results.length} docs to GitHub cache`);
    } catch (err) {
      console.error('[listInfoDocs] GitHub cache write failed:', err.message);
    }
  }

  return results;
}

/**
 * Force-refresh the info docs index from Google Drive and save to GitHub.
 */
async function refreshInfoDocsIndex() {
  const results = await fetchInfoDocsFromGoogleDrive();
  if (results.length > 0) {
    try {
      await github.writeFile(INFO_DOCS_INDEX_PATH, {
        docs: results,
        updatedAt: new Date().toISOString(),
        count: results.length,
      }, 'auto: refresh info docs index');
    } catch (err) {
      console.error('[refreshInfoDocsIndex] GitHub write failed:', err.message);
    }
  }
  return results;
}

/**
 * List all client docs from Google Drive (Brand Guardian Clients folder).
 */
async function fetchInfoDocsFromGoogleDrive() {
  try {
    const docs = await gdrive.listClientDocs();
    console.log(`[fetchInfoDocsFromGoogleDrive] Found ${docs.length} client docs`);
    return docs;
  } catch (err) {
    console.error('[fetchInfoDocsFromGoogleDrive] error:', err.message);
    return [];
  }
}

module.exports = {
  getOrBuildBrandProfile,
  listInfoDocs,
  refreshInfoDocsIndex,
  findClientInfoDoc,
  readDocContent,
  appendResearchToDoc,
  deepCrawlWebsite,
  runDeepResearch,
  hasExistingResearch,
};
