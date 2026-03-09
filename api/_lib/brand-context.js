/**
 * Brand Context Manager — Enrichment Edition
 *
 * ONE LIVING DOC — all research appends to the existing Client Info Doc page.
 * No separate pages. The doc grows over time as a master brand reference.
 *
 * Flow:
 * 1. Find the Client Info Doc in ClickUp
 * 2. Read its content — check if Brand Guardian research section already exists
 * 3. If research exists AND not forceRefresh — parse it into a structured profile, done
 * 4. If no research OR forceRefresh — run deep research (website crawl + doc analysis)
 *    — APPEND findings to the same page (below existing content)
 * 5. Return structured brand profile
 *
 * The enrichment skill always runs with forceRefresh=true to ensure
 * the latest research is compiled on every trigger.
 */

const { askClaudeLong } = require('./connectors/claude');
const github = require('./connectors/github');

const MAX_DOC_CHARS = 30000;

/**
 * Safely extract JSON from Claude response that may contain markdown fences or extra text.
 */
function extractJSON(text) {
  try { return JSON.parse(text); } catch(e) {}
  const stripped = text.replace(/^```(?:json)?\n?/gm, '').replace(/```$/gm, '').trim();
  try { return JSON.parse(stripped); } catch(e) {}
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.substring(first, last + 1)); } catch(e) {}
  }
  throw new Error('Could not extract JSON from response (length=' + text.length + ', preview=' + text.substring(0, 100) + ')');
}

const BRAND_CACHE_PREFIX = 'brand-cache';
const RESEARCH_SECTION_MARKER = '---\n\n## 🛡️ Brand Guardian Research';
const RESEARCH_MARKER_CHECK = '## 🛡️ Brand Guardian Research';

// ── CLICKUP API HELPERS ──

async function findClientInfoDoc(clientName) {
  const workspaceId = (process.env.CLICKUP_WORKSPACE_ID || '').trim();
  const token = (process.env.CLICKUP_API_TOKEN || '').trim();

  if (!workspaceId || !token) {
    console.error('[findClientInfoDoc] Missing CLICKUP_WORKSPACE_ID or CLICKUP_API_TOKEN');
    return null;
  }

  const clientLower = clientName.toLowerCase().trim();
  console.log(`[findClientInfoDoc] Looking for Info Doc for client: "${clientName}"`);

  function namesMatch(docNameLower, searchLower) {
    if (docNameLower.includes(searchLower)) return true;
    const docNoSpaces = docNameLower.replace(/\s+/g, '');
    const searchNoSpaces = searchLower.replace(/\s+/g, '');
    if (docNoSpaces.includes(searchNoSpaces)) return true;
    if (searchNoSpaces.includes(docNoSpaces)) return true;
    return false;
  }

  try {
    // Use search API — confirmed to return correct doc IDs
    const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/search`, {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `${clientName} Info Doc`, types: ['doc'], limit: 20 }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown');
      console.error(`[findClientInfoDoc] Search API HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const docs = data.results || [];
    console.log(`[findClientInfoDoc] Search returned ${docs.length} results`);

    for (const doc of docs) {
      if (doc.type !== 'doc') continue;
      const docName = (doc.name || '').toLowerCase();
      if (!/(info|client info)/i.test(docName)) continue;
      if (namesMatch(docName, clientLower)) {
        console.log(`[findClientInfoDoc] Match: "${doc.name}" (ID: ${doc.id})`);
        return { docId: doc.id, docName: doc.name };
      }
    }

    // Also try partial match on extracted name
    for (const doc of docs) {
      if (doc.type !== 'doc') continue;
      const docName = (doc.name || '').toLowerCase();
      if (!/(info|client info)/i.test(docName)) continue;
      const extractedName = docName.replace(/\s*(client\s+)?info(\s+doc)?s?$/i, '').trim();
      if (namesMatch(extractedName, clientLower)) {
        console.log(`[findClientInfoDoc] Partial match: "${doc.name}" (ID: ${doc.id})`);
        return { docId: doc.id, docName: doc.name };
      }
    }

    console.log(`[findClientInfoDoc] No Info Doc found for "${clientName}"`);
    return null;
  } catch (err) {
    console.error(`[findClientInfoDoc] Error:`, err.message);
    return null;
  }
}

async function readDocContent(docId) {
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;
  console.log(`[readDocContent] Reading doc ${docId} in workspace ${workspaceId}`);

  const pagesResp = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`,
    { headers: { 'Authorization': process.env.CLICKUP_API_TOKEN } }
  );

  if (!pagesResp.ok) {
    const errText = await pagesResp.text().catch(() => '');
    console.error(`[readDocContent] ClickUp pages HTTP ${pagesResp.status}: ${errText.slice(0, 300)}`);
    return { content: '', pageId: null, pages: [] };
  }

  const pagesData = await pagesResp.json();
  if (!pagesData.pages?.length) return { content: '', pageId: null, pages: [] };

  const mainPage = pagesData.pages[0];
  let mainContent = '';
  let allContent = '';

  for (const page of pagesData.pages.slice(0, 15)) {
    try {
      const pageResp = await fetch(
        `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${page.id}?content_format=text/md`,
        { headers: { 'Authorization': process.env.CLICKUP_API_TOKEN } }
      );
      if (!pageResp.ok) continue;
      const pageData = await pageResp.json();
      const content = pageData.content || '';
      if (page.id === mainPage.id) mainContent = content;
      allContent += `\n\n${content}`;
    } catch (err) {
      console.error(`Error reading page ${page.id}:`, err.message);
    }
  }

  return {
    content: allContent.trim(),
    mainContent: mainContent.trim(),
    mainPageId: mainPage.id,
    pages: pagesData.pages,
  };
}

async function appendResearchToDoc(docId, pageId, clientName, research) {
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;

  const researchMarkdown = `

${RESEARCH_SECTION_MARKER}

*Auto-generated on ${new Date().toISOString().split('T')[0]} — updated by Brand Guardian*
*This section is used for brand alignment checks, content creation, and brand-consistent output.*

---

### Brand Overview
${research.brandOverview || ''}

### Target Audience
**Primary:** ${research.targetAudience?.primary || 'Unknown'}
**Secondary:** ${research.targetAudience?.secondary || 'N/A'}
**Demographics:** ${research.targetAudience?.demographics || 'Unknown'}
**Psychographics:** ${research.targetAudience?.psychographics || 'Unknown'}

### Brand Voice & Tone
**Tone:** ${research.brandVoice?.tone || 'Unknown'}
**Personality:** ${research.brandVoice?.personality || 'Unknown'}
**Do Not Say:** ${(research.brandVoice?.doNotSay || []).join(', ') || 'None specified'}
**Preferred Terms:** ${(research.brandVoice?.preferredTerms || []).join(', ') || 'None specified'}

### Products & Services
${(research.coreOfferings?.products || []).map(p => `- ${p}`).join('\n') || 'Not specified'}

**Value Proposition:** ${research.coreOfferings?.valueProposition || 'Unknown'}
**Key Benefits:** ${(research.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}
**Pricing Tier:** ${research.coreOfferings?.pricingTier || 'Unknown'}

### Competitive Landscape
${(research.competitors || []).map(c => {
    if (typeof c === 'string') return `- ${c}`;
    return `- **${c.name}:** ${c.differentiator || ''}`;
  }).join('\n') || 'No competitors identified'}

**Key Differentiators:** ${research.competitiveDifferentiators || 'Not specified'}

### Content Themes
**On-Brand Topics:** ${(research.contentThemes?.onBrandTopics || []).join(', ') || 'Unknown'}
**Adjacent Topics (guest posts):** ${(research.contentThemes?.adjacentTopics || []).join(', ') || 'Unknown'}
**Off-Limit Topics:** ${(research.contentThemes?.offLimitTopics || []).join(', ') || 'None specified'}

### Key Messages
${(research.keyMessages || []).map(m => `- ${m}`).join('\n') || 'Not specified'}

### Website Insights
**Content Style:** ${research.websiteInsights?.contentStyle || 'Unknown'}
**CTA Patterns:** ${research.websiteInsights?.ctaPatterns || 'Unknown'}
**Social Proof:** ${research.websiteInsights?.socialProof || 'Unknown'}
**Pages Analyzed:** ${(research.websiteInsights?.mainPages || []).join(', ') || 'Unknown'}

### Industry Context
${research.industryContext || 'Not available'}`;

  const token = (process.env.CLICKUP_API_TOKEN || '').trim();
  console.log(`[appendResearchToDoc] Appending to doc ${docId}, page ${pageId}`);

  try {
    const url = `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`;

    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: researchMarkdown,
        content_format: 'text/md',
        content_edit_mode: 'append',
      }),
    });

    const respText = await resp.text();
    console.log(`[appendResearchToDoc] Response ${resp.status}: ${respText.slice(0, 300)}`);

    if (!resp.ok) {
      console.log('[appendResearchToDoc] Trying fallback: create new page...');
      const newPageUrl = `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`;
      const newPageResp = await fetch(newPageUrl, {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `🛡️ Brand Guardian Research — ${clientName}`,
          content: researchMarkdown,
          content_format: 'text/md',
        }),
      });

      const newPageText = await newPageResp.text();
      console.log(`[appendResearchToDoc] New page response ${newPageResp.status}: ${newPageText.slice(0, 300)}`);

      if (newPageResp.ok) {
        try { return JSON.parse(newPageText); } catch { return { ok: true }; }
      }
      return null;
    }

    try { return JSON.parse(respText); } catch { return { ok: true }; }
  } catch (err) {
    console.error('[appendResearchToDoc] error:', err.message);
    return null;
  }
}

// ── WEBSITE CRAWLING ──

async function deepCrawlWebsite(url) {
  if (!url.startsWith('http')) url = `https://${url}`;
  const baseUrl = new URL(url).origin;

  const pagePaths = [
    '/', '/about', '/about-us', '/our-story', '/who-we-are',
    '/services', '/products', '/solutions', '/what-we-do', '/offerings',
    '/pricing', '/plans',
    '/features', '/how-it-works', '/platform',
    '/blog', '/resources', '/insights',
    '/case-studies', '/testimonials', '/reviews', '/success-stories',
    '/team', '/leadership', '/our-team',
    '/contact', '/get-started', '/demo', '/free-trial',
    '/faq', '/help', '/support',
    '/industries', '/customers', '/partners',
    '/why-us', '/why-choose-us', '/comparison',
    '/careers', '/press', '/news', '/media',
  ];

  const pages = [];
  const crawled = new Set();

  async function crawlPage(path) {
    if (crawled.has(path)) return;
    crawled.add(path);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
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
          .slice(0, 4000);

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
    } catch (err) { /* skip */ }
    return null;
  }

  for (const path of pagePaths) {
    await crawlPage(path);
    await new Promise(r => setTimeout(r, 300));
  }

  // Discover additional internal links from homepage
  if (pages.length > 0) {
    try {
      const homepageHtml = pages[0]?.text ? null : await (await fetch(baseUrl)).text();
      const html = homepageHtml || '';
      const linkRegex = /href=["'](\/[a-z0-9\-\/]+)["']/gi;
      let match;
      const discovered = [];
      while ((match = linkRegex.exec(html)) !== null) {
        const p = match[1];
        if (!crawled.has(p) && p.split('/').length <= 3 && !p.includes('.')) {
          discovered.push(p);
        }
      }
      for (const dp of discovered.slice(0, 10)) {
        await crawlPage(dp);
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err) { /* skip */ }
  }

  return pages;
}

function formatCrawledPages(pages) {
  return pages.map(p =>
    `--- PAGE: ${p.path} ---\nTitle: ${p.title || 'N/A'}\nMeta: ${p.metaDescription || 'N/A'}\n${p.text}`
  ).join('\n\n').slice(0, 25000);
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
  if (websiteUrl) {
    crawledPages = await deepCrawlWebsite(websiteUrl);
    websiteData = formatCrawledPages(crawledPages);
  }

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

OUTPUT — valid JSON only, no markdown fences:
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

  const result = await askClaudeLong(systemPrompt, userContent, { maxTokens: 6000, timeout: 150000 });

  try {
    return extractJSON(result);
  } catch (err) {
    console.error('Failed to parse research:', err.message);
    return null;
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

OUTPUT — valid JSON only, no markdown fences:
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

  // Find the Client Info Doc — use provided docId if available (from dropdown selection)
  let docInfo = null;
  if (options.docId) {
    if (progressCallback) await progressCallback('Loading Client Info Doc...');
    docInfo = { docId: options.docId, docName: `${clientName} Info Doc` };
    console.log(`[getOrBuildBrandProfile] Using provided docId: ${options.docId} for "${clientName}"`);
  } else {
    if (progressCallback) await progressCallback('Searching ClickUp for Client Info Doc...');
    docInfo = await findClientInfoDoc(clientName);
  }

  let fullContent = '';
  let mainPageId = null;

  if (docInfo) {
    if (progressCallback) await progressCallback(`Found "${docInfo.docName}". Reading...`);
    const docData = await readDocContent(docInfo.docId);
    fullContent = docData.content || '';
    mainPageId = docData.mainPageId;

    // If existing research and NOT force refresh, parse and return
    if (fullContent && hasExistingResearch(fullContent) && !forceRefresh) {
      if (progressCallback) await progressCallback('Existing research found. Building profile...');
      const profile = await parseExistingResearch(fullContent, clientName);
      if (profile) {
        const profileWithMeta = { ...profile, clientName, cachedAt: new Date().toISOString(), cacheKey };
        await github.writeFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);
        return { profile: profileWithMeta, source: 'existing_research', researchNeeded: false };
      }
    }
  } else {
    console.log(`No ClickUp doc found for "${clientName}" — will attempt website-only research`);
  }

  // Extract website URL from doc if not provided
  if (!websiteUrl && fullContent) {
    const urlMatch = fullContent.match(/https?:\/\/(?:www\.)?[a-zA-Z0-9\-]+\.[a-zA-Z]{2,}(?:\/[^\s)]*)?/);
    if (urlMatch) websiteUrl = urlMatch[0];
  }

  if (!websiteUrl && !fullContent) {
    const debugInfo = options.docId ? ` (docId=${options.docId}, readDocContent returned empty)` : ' (no docId provided, findClientInfoDoc returned null)';
    console.error(`[getOrBuildBrandProfile] No content and no URL for "${clientName}"${debugInfo}`);
    return {
      profile: null, source: 'none',
      error: `Could not find a Client Info Doc for "${clientName}" in ClickUp and no website URL was provided.`,
    };
  }

  // Run deep research
  if (progressCallback) {
    const label = forceRefresh
      ? 'Running fresh brand enrichment research...'
      : docInfo
        ? 'No existing research. Running deep brand research...'
        : `No ClickUp doc found — running brand research from website...`;
    await progressCallback(label);
  }

  const research = await runDeepResearch(clientName, fullContent, websiteUrl, progressCallback, {
    enrichmentNotes: options.enrichmentNotes,
  });

  if (!research) {
    return { profile: null, source: 'none', error: 'Deep research failed. Check logs.' };
  }

  // Append research to the existing doc page
  let savedToDoc = false;
  if (docInfo && mainPageId) {
    console.log(`[getOrBuildBrandProfile] Saving research to ClickUp doc ${docInfo.docId}, page ${mainPageId}`);
    if (progressCallback) await progressCallback('Saving research to Client Info Doc...');
    const appendResult = await appendResearchToDoc(docInfo.docId, mainPageId, clientName, research);
    savedToDoc = !!appendResult;
    if (savedToDoc) {
      console.log(`[getOrBuildBrandProfile] Successfully saved research to ClickUp`);
    } else {
      console.error(`[getOrBuildBrandProfile] Failed to append research to doc ${docInfo.docId}`);
      if (progressCallback) await progressCallback('⚠️ Research complete but failed to save to ClickUp. Caching in GitHub...');
    }
  } else {
    console.log(`[getOrBuildBrandProfile] No ClickUp doc to save to (docInfo: ${!!docInfo}, mainPageId: ${mainPageId})`);
  }

  // Cache in GitHub
  const profileWithMeta = { ...research, clientName, cachedAt: new Date().toISOString(), cacheKey };
  await github.writeFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);

  return { profile: profileWithMeta, source: 'new_research', researchNeeded: true, savedToDoc };
}

/**
 * List all Client Info Docs from ClickUp (for the dropdown).
 */
async function listInfoDocs() {
  const workspaceId = (process.env.CLICKUP_WORKSPACE_ID || '').trim();
  const token = (process.env.CLICKUP_API_TOKEN || '').trim();

  if (!workspaceId || !token) {
    console.error('[listInfoDocs] Missing CLICKUP_WORKSPACE_ID or CLICKUP_API_TOKEN');
    return [];
  }

  const headers = { 'Authorization': token, 'Content-Type': 'application/json' };

  // Search API first — confirmed to return correct doc IDs that work with pages endpoint
  const approaches = [
    {
      name: 'v3-search',
      url: `https://api.clickup.com/api/v3/workspaces/${workspaceId}/search`,
      method: 'POST',
      body: JSON.stringify({ query: 'Client Info Doc', types: ['doc'], limit: 50 }),
      extractDocs: (data) => data.results || [],
    },
    {
      name: 'v3-docs-list',
      url: `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs`,
      method: 'GET',
      extractDocs: (data) => data.docs || data.results || data.data || [],
    },
  ];

  for (const approach of approaches) {
    try {
      console.log(`[listInfoDocs] Trying ${approach.name}: ${approach.method} ${approach.url}`);

      const fetchOpts = { method: approach.method, headers };
      if (approach.body) fetchOpts.body = approach.body;

      const resp = await fetch(approach.url, fetchOpts);

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => 'unknown');
        console.log(`[listInfoDocs] ${approach.name} — HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
        continue;
      }

      const data = await resp.json();
      const docs = approach.extractDocs(data);
      console.log(`[listInfoDocs] ${approach.name} — ${docs.length} docs found`);

      if (docs.length === 0) continue;

      const results = [];
      const seen = new Set();

      for (const doc of docs) {
        const docId = doc.id || doc.doc_id;
        if (!docId || seen.has(docId)) continue;
        // Skip non-doc results from search API
        if (doc.type && doc.type !== 'doc') continue;
        seen.add(docId);

        const docName = doc.name || doc.title || '';
        if (!/(info|client info)/i.test(docName)) continue;
        if (/template/i.test(docName)) continue;
        if (/definitions/i.test(docName)) continue;
        if (/^sprint\s+\d/i.test(docName)) continue;

        const name = docName.replace(/\s*(client\s+)?info(\s+doc)?s?$/i, '').trim();
        if (name) {
          results.push({ name, docId, docName });
        }
      }

      results.sort((a, b) => a.name.localeCompare(b.name));
      console.log(`[listInfoDocs] Returning ${results.length} clients:`, results.map(r => `${r.name}(${r.docId})`).join(', '));
      return results;
    } catch (err) {
      console.error(`[listInfoDocs] ${approach.name} error:`, err.message);
    }
  }

  console.error('[listInfoDocs] All approaches failed');
  return [];
}

module.exports = {
  getOrBuildBrandProfile,
  listInfoDocs,
  findClientInfoDoc,
  readDocContent,
  appendResearchToDoc,
  deepCrawlWebsite,
  runDeepResearch,
  hasExistingResearch,
};
