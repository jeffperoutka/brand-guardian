/**
 * Brand Context Manager v3
 *
 * ONE LIVING DOC — all research appends to the existing Client Info Doc page.
 * No separate pages. The doc grows over time as a master brand reference.
 *
 * Flow:
 * 1. Find the Client Info Doc in ClickUp
 * 2. Read its content — check if Brand Guardian research section already exists
 * 3. If research exists → parse it into a structured profile, done
 * 4. If no research → run deep research (website crawl + doc analysis)
 *    → APPEND findings to the same page (below existing content)
 * 5. Return structured brand profile for alignment checking
 *
 * Future: call recordings, client meeting notes, priority updates all get
 * appended to this same doc with timestamps, building a living brand record.
 */

const { askClaudeLong } = require('./connectors/claude');
const github = require('./connectors/github');

const BRAND_CACHE_PREFIX = 'brand-cache';
const RESEARCH_SECTION_MARKER = '---\n\n## 🛡️ Brand Guardian Research';
const RESEARCH_MARKER_CHECK = '## 🛡️ Brand Guardian Research';

// ─── CLICKUP API HELPERS ───

/**
 * Search ClickUp for a client's Info Doc
 */
async function findClientInfoDoc(clientName) {
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;

  const queries = [
    `${clientName} Info Doc`,
    `${clientName} Client Info`,
    `${clientName} info`,
  ];

  for (const query of queries) {
    try {
      const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/search`, {
        method: 'POST',
        headers: {
          'Authorization': process.env.CLICKUP_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, types: ['doc'], limit: 5 }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown');
        console.error(`ClickUp search HTTP ${resp.status} for "${query}":`, errText.slice(0, 200));
        continue;
      }

      const data = await resp.json();

      if (data.results?.length > 0) {
        const match = data.results.find(r =>
          r.name?.toLowerCase().includes(clientName.toLowerCase())
        ) || data.results[0];
        return { docId: match.id, docName: match.name };
      }
    } catch (err) {
      console.error(`Search failed for "${query}":`, err.message);
    }
  }
  return null;
}

/**
 * Read the Client Info Doc — returns the FIRST page's content and ID.
 * We treat page 0 as the master page where everything lives.
 */
async function readDocContent(docId) {
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;

  // Get page list
  const pagesResp = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`,
    { headers: { 'Authorization': process.env.CLICKUP_API_TOKEN } }
  );

  if (!pagesResp.ok) {
    console.error(`ClickUp pages HTTP ${pagesResp.status}:`, await pagesResp.text().catch(() => ''));
    return { content: '', pageId: null, pages: [] };
  }

  const pagesData = await pagesResp.json();

  if (!pagesData.pages?.length) return { content: '', pageId: null, pages: [] };

  // Read ALL pages to get the full picture, but track the main page
  const mainPage = pagesData.pages[0];
  let mainContent = '';
  let allContent = '';

  for (const page of pagesData.pages.slice(0, 15)) {
    try {
      const pageResp = await fetch(
        `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${page.id}?content_format=text/md`,
        { headers: { 'Authorization': process.env.CLICKUP_API_TOKEN } }
      );
      if (!pageResp.ok) {
        console.error(`ClickUp page ${page.id} HTTP ${pageResp.status}`);
        continue;
      }
      const pageData = await pageResp.json();
      const content = pageData.content || '';

      if (page.id === mainPage.id) {
        mainContent = content;
      }

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

/**
 * Append research to the existing Client Info Doc page.
 * Uses ClickUp's page update API with content_edit_mode: "append"
 * so we ADD to the existing content rather than replacing it.
 */
async function appendResearchToDoc(docId, pageId, clientName, research) {
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;

  const researchMarkdown = `

${RESEARCH_SECTION_MARKER}

*Auto-generated on ${new Date().toISOString().split('T')[0]} — updated by Brand Guardian*
*This section is used for ongoing brand alignment checks. New insights are appended over time.*

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

  try {
    const resp = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': process.env.CLICKUP_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: researchMarkdown,
          content_format: 'text/md',
          content_edit_mode: 'append',
        }),
      }
    );
    if (!resp.ok) {
      console.error(`ClickUp append HTTP ${resp.status}:`, await resp.text().catch(() => ''));
      return null;
    }
    const result = await resp.json();
    console.log('appendResearchToDoc result:', JSON.stringify(result).slice(0, 200));
    return result;
  } catch (err) {
    console.error('appendResearchToDoc error:', err.message);
    return null;
  }
}

// ─── WEBSITE CRAWLING ───

/**
 * Deep crawl — hits 30+ paths plus discovers internal links
 */
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
        headers: { 'User-Agent': 'BrandGuardian/1.0 (brand-alignment-bot)' },
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

        return html; // Return for link discovery
      }
    } catch (err) { /* skip */ }
    return null;
  }

  // Crawl predefined paths
  for (const path of pagePaths) {
    await crawlPage(path);
    await new Promise(r => setTimeout(r, 300));
  }

  // Discover + crawl additional internal links from homepage
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

// ─── RESEARCH & PROFILE BUILDING ───

function hasExistingResearch(docContent) {
  return docContent.includes(RESEARCH_MARKER_CHECK);
}

function extractResearchSection(docContent) {
  const idx = docContent.indexOf(RESEARCH_MARKER_CHECK);
  if (idx === -1) return null;
  return docContent.slice(idx);
}

/**
 * Run deep research — website crawl + Claude analysis
 */
async function runDeepResearch(clientName, existingDocContent, websiteUrl, progressCallback, directives = {}) {
  if (progressCallback) await progressCallback('Crawling website pages...');
  let crawledPages = [];
  let websiteData = '';
  if (websiteUrl) {
    crawledPages = await deepCrawlWebsite(websiteUrl);
    websiteData = formatCrawledPages(crawledPages);
  }

  if (progressCallback) await progressCallback(`Analyzing ${crawledPages.length} pages + Client Info Doc...`);

  const systemPrompt = `You are a Brand Research Specialist at AEO Labs (AI SEO agency). Conduct deep brand research to build a comprehensive client profile.

Data sources:
1. Client Info Doc — their answers about their business
2. Website content — crawled pages

Synthesize into a thorough, opinionated brand profile. Don't just summarize — analyze patterns, positioning, voice nuances, and themes.

OUTPUT — valid JSON only, no markdown fences:
{
  "brandOverview": "3-5 sentence overview of who they are and how they position themselves",
  "website": "main URL",
  "industry": "specific industry/niche",
  "targetAudience": {
    "primary": "detailed primary audience",
    "secondary": "secondary audience if any",
    "demographics": "age, location, income, job titles, company size",
    "psychographics": "interests, values, pain points, motivations"
  },
  "brandVoice": {
    "tone": "detailed tone (not just 'professional' — be specific about HOW they write)",
    "personality": "brand personality traits with examples",
    "doNotSay": ["specific phrases/topics/approaches they avoid"],
    "preferredTerms": ["terminology they consistently use"]
  },
  "coreOfferings": {
    "products": ["each product/service with brief description"],
    "valueProposition": "unique value prop",
    "keyBenefits": ["specific emphasized benefits"],
    "pricingTier": "budget/mid-range/premium/enterprise with evidence"
  },
  "competitors": [{"name": "Name", "differentiator": "How client differs"}],
  "competitiveDifferentiators": "what makes them stand out — be specific",
  "contentThemes": {
    "onBrandTopics": ["topics they'd publish on their own blog"],
    "adjacentTopics": ["loosely related topics for guest posts"],
    "offLimitTopics": ["inappropriate or irrelevant topics"]
  },
  "keyMessages": ["core marketing messages and taglines"],
  "websiteInsights": {
    "contentStyle": "how they write — length, complexity, data usage, storytelling",
    "ctaPatterns": "what their CTAs look like",
    "socialProof": "how they use testimonials/case studies",
    "mainPages": ["key page types found"]
  },
  "industryContext": "2-3 sentences about the industry landscape"
}

RULES:
1. Be specific and opinionated. "Professional tone" = useless. Say exactly HOW they sound.
2. For doNotSay — what would make their audience cringe?
3. Only list competitors you can identify from the content.
4. Adjacent topics = what industry publications cover.
5. Off-limit topics = what would damage their brand.
6. If CLIENT DIRECTIVES are provided below, they OVERRIDE what you find on the website. The client is actively pivoting/repositioning — their website may not reflect their current direction. Treat the directives as the source of truth for brand positioning.

${directives.priorities || directives.avoid ? `\n━━━ CLIENT DIRECTIVES ━━━\n${directives.priorities ? `PRIORITIZE (focus research on these topics): ${directives.priorities}` : ''}${directives.avoid ? `\nAVOID (do NOT include these in the brand profile): ${directives.avoid}` : ''}\n━━━━━━━━━━━━━━━━━━━━\nIMPORTANT: These directives reflect the client's CURRENT strategic direction. Even if the website mentions avoided topics, exclude them from the profile. Build the profile around the priority topics instead.` : ''}`;

  const userContent = `Research this client:

CLIENT: ${clientName}

CLIENT INFO DOC:
${existingDocContent || '(No client info doc content)'}

WEBSITE (${crawledPages.length} pages):
${websiteData || '(No website data)'}

Build the most thorough profile possible.`;

  const result = await askClaudeLong(systemPrompt, userContent, { maxTokens: 6000, timeout: 150000 });

  try {
    return JSON.parse(result.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim());
  } catch (err) {
    console.error('Failed to parse research:', err.message);
    return null;
  }
}

/**
 * Parse existing research from the doc into structured profile.
 * Reads the ENTIRE doc (original answers + research section) to build the profile.
 */
async function parseExistingResearch(docContent, clientName, directives = {}) {
  const directivesBlock = (directives.priorities || directives.avoid)
    ? `\n\nCLIENT DIRECTIVES — THESE OVERRIDE WHAT THE DOC SAYS:\n${directives.priorities ? `PRIORITIZE: ${directives.priorities}\n` : ''}${directives.avoid ? `AVOID (exclude from profile): ${directives.avoid}\n` : ''}The client is repositioning. Build the profile around the priority topics and EXCLUDE avoided topics entirely, even if the doc mentions them.`
    : '';

  const result = await askClaudeLong(
    `Parse this client's brand document into a structured profile. The doc contains their original info answers AND brand research findings. Extract everything into a single comprehensive profile.${directivesBlock}

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

Prioritize the MOST RECENT information if there are conflicts (newer entries at the bottom of the doc are more current).`,
    `CLIENT: ${clientName}\n\nFULL DOCUMENT:\n${docContent}`,
    { maxTokens: 5000, timeout: 90000 }
  );

  try {
    return JSON.parse(result.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim());
  } catch (err) {
    console.error('Failed to parse existing research:', err.message);
    return null;
  }
}

// ─── MAIN ORCHESTRATOR ───

/**
 * Get or build brand profile. Single flow:
 * 1. Check GitHub cache (7 day TTL)
 * 2. Find + read Client Info Doc from ClickUp
 * 3. If doc has research section → parse it
 * 4. If not → run deep research → append to same doc page
 * 5. Cache in GitHub for fast lookups
 */
async function getOrBuildBrandProfile(clientName, websiteUrl, progressCallback, directives = {}) {
  const cacheKey = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Quick check GitHub cache — skip cache if directives are provided (priorities change the profile)
  const hasDirectives = !!(directives.priorities || directives.avoid);
  const cached = await github.readFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`);
  const cacheAge = cached?.cachedAt ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

  if (cached && cacheAge < CACHE_TTL && !hasDirectives) {
    if (progressCallback) await progressCallback('Brand profile loaded from cache.');
    return { profile: cached, source: 'cache', researchNeeded: false };
  }
  if (hasDirectives && cached) {
    if (progressCallback) await progressCallback('Directives provided — rebuilding profile with custom focus...');
  }

  // Find the Client Info Doc
  if (progressCallback) await progressCallback('Searching ClickUp for Client Info Doc...');
  const docInfo = await findClientInfoDoc(clientName);

  let fullContent = '';
  let mainPageId = null;

  if (docInfo) {
    // Read the doc
    if (progressCallback) await progressCallback(`Found "${docInfo.docName}". Reading...`);
    const docData = await readDocContent(docInfo.docId);
    fullContent = docData.content || '';
    mainPageId = docData.mainPageId;

    if (fullContent) {
      // Check if research already exists in the doc
      if (hasExistingResearch(fullContent)) {
        if (progressCallback) await progressCallback('Existing research found. Building profile...');
        const profile = await parseExistingResearch(fullContent, clientName, directives);

        if (profile) {
          const profileWithMeta = { ...profile, clientName, cachedAt: new Date().toISOString(), cacheKey };
          await github.writeFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);
          return { profile: profileWithMeta, source: 'existing_research', researchNeeded: false };
        }
      }
    }
  } else {
    console.log(`No ClickUp doc found for "${clientName}" — will attempt website-only research`);
  }

  // No research exists (or no doc at all) — need website URL to proceed
  if (!websiteUrl && fullContent) {
    const urlMatch = fullContent.match(/https?:\/\/(?:www\.)?[a-zA-Z0-9\-]+\.[a-zA-Z]{2,}(?:\/[^\s)]*)?/);
    if (urlMatch) websiteUrl = urlMatch[0];
  }

  if (!websiteUrl && !fullContent) {
    return {
      profile: null, source: 'none',
      error: `Could not find a Client Info Doc for "${clientName}" in ClickUp and no website URL was provided. Either add an Info Doc to ClickUp or provide a website URL.`,
    };
  }

  // Run deep research — works with just website, just doc content, or both
  const researchLabel = docInfo
    ? 'No existing research. Running deep brand research...'
    : `No ClickUp doc found — running brand research from website${websiteUrl ? ` (${websiteUrl})` : ''}...`;
  if (progressCallback) await progressCallback(researchLabel);

  const research = await runDeepResearch(clientName, fullContent, websiteUrl, progressCallback, directives);

  if (!research) {
    return { profile: null, source: 'none', error: 'Deep research failed. Check logs.' };
  }

  // APPEND research to the existing doc page if we have one
  if (docInfo && mainPageId) {
    if (progressCallback) await progressCallback('Appending research to Client Info Doc...');
    await appendResearchToDoc(docInfo.docId, mainPageId, clientName, research);
  }

  // Cache
  const profileWithMeta = { ...research, clientName, cachedAt: new Date().toISOString(), cacheKey };
  await github.writeFile(`${BRAND_CACHE_PREFIX}/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);

  return { profile: profileWithMeta, source: 'new_research', researchNeeded: true };
}

/**
 * List cached brand profiles (for the dropdown)
 */
async function listCachedBrands() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return [];
  try {
    const resp = await fetch(`https://api.github.com/repos/jeffperoutka/brand-guardian/contents/${BRAND_CACHE_PREFIX}`, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return [];
    const files = await resp.json();
    return files
      .filter(f => f.name.endsWith('.json'))
      .map(f => f.name.replace('.json', '').replace(/-/g, ' '));
  } catch (err) { return []; }
}

/**
 * List all Client Info Docs from ClickUp.
 * Searches for docs with "Info Doc" / "Client Info" in the name
 * and returns an array of { name, docId } for each match.
 * The client name is extracted from the doc name (e.g. "Kobo Pickleball Info Doc" → "Kobo Pickleball").
 */
async function listInfoDocs() {
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;
  const token = process.env.CLICKUP_API_TOKEN;

  console.log('[listInfoDocs] workspaceId:', workspaceId ? `${workspaceId.slice(0, 6)}...` : 'MISSING');
  console.log('[listInfoDocs] token:', token ? `${token.slice(0, 6)}...` : 'MISSING');

  if (!workspaceId || !token) {
    console.error('[listInfoDocs] Missing CLICKUP_WORKSPACE_ID or CLICKUP_API_TOKEN');
    return [];
  }

  const seen = new Set();
  const results = [];

  // Search for "Client Info Doc" — this matches the naming convention
  const query = 'Client Info Doc';
  const url = `https://api.clickup.com/api/v3/workspaces/${workspaceId}/search`;

  try {
    console.log('[listInfoDocs] Searching ClickUp:', url);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, types: ['doc'], limit: 50 }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'unknown');
      console.error(`[listInfoDocs] HTTP ${resp.status}: ${errBody.slice(0, 500)}`);
      return [];
    }

    const data = await resp.json();
    console.log(`[listInfoDocs] Found ${data.results?.length || 0} docs`);

    for (const doc of (data.results || [])) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);

      const docName = doc.name || '';

      // Skip templates and non-client docs
      if (/template/i.test(docName)) continue;
      if (/definitions/i.test(docName)) continue;
      if (/^sprint\s+\d/i.test(docName)) continue;

      // Extract client name from doc title
      // Patterns: "ClientName Client Info Doc", "ClientName Info Doc", "ClientName info"
      const name = docName
        .replace(/\s*(client\s+)?info(\s+doc)?$/i, '')
        .trim();

      if (name) {
        results.push({ name, docId: doc.id, docName });
      }
    }
  } catch (err) {
    console.error(`[listInfoDocs] Error:`, err.message);
  }

  // Sort alphabetically
  results.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[listInfoDocs] Returning ${results.length} clients:`, results.map(r => r.name).join(', '));
  return results;
}

module.exports = {
  getOrBuildBrandProfile,
  listCachedBrands,
  listInfoDocs,
  findClientInfoDoc,
  readDocContent,
  appendResearchToDoc,
  deepCrawlWebsite,
  runDeepResearch,
  hasExistingResearch,
};
