const CLICKUP_API = 'https://api.clickup.com/api/v2';

function withTimeout(promise, ms, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function clickupFetch(endpoint, options = {}) {
  const token = process.env.CLICKUP_API_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${CLICKUP_API}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    return resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Search for docs in a space
async function searchDocs(workspaceId, query) {
  const resp = await clickupFetch(`/workspaceId/${workspaceId}/search?query=${encodeURIComponent(query)}&type=doc`);
  return resp;
}

// Get document pages
async function getDocPages(workspaceId, docId) {
  const resp = await clickupFetch(`/workspaceId/${workspaceId}/doc/${docId}/page`);
  return resp;
}

// Get a specific page content
async function getPageContent(workspaceId, docId, pageId) {
  const resp = await clickupFetch(`/workspaceId/${workspaceId}/doc/${docId}/page/${pageId}`);
  return resp;
}

// Search tasks (to find Client Info Docs via task search)
async function searchTasks(teamId, query) {
  const resp = await clickupFetch(`/team/${teamId}/task?name=${encodeURIComponent(query)}&include_closed=true`);
  return resp;
}

// Use ClickUp's universal search
async function universalSearch(teamId, query) {
  const resp = await fetch('https://api.clickup.com/api/v3/workspaces/' + teamId + '/search', {
    method: 'POST',
    headers: {
      'Authorization': process.env.CLICKUP_API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: query,
      types: ['doc'],
      limit: 10,
    }),
  });
  return resp.json();
}

// Get doc content via v3 API
async function getDocContent(workspaceId, docId) {
  const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`, {
    headers: {
      'Authorization': process.env.CLICKUP_API_TOKEN,
      'Content-Type': 'application/json',
    },
  });
  return resp.json();
}

// Get specific page content via v3
async function getDocPageContent(workspaceId, docId, pageId) {
  const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, {
    headers: {
      'Authorization': process.env.CLICKUP_API_TOKEN,
      'Content-Type': 'application/json',
    },
  });
  return resp.json();
}

module.exports = { clickupFetch, searchDocs, getDocPages, getPageContent, searchTasks, universalSearch, getDocContent, getDocPageContent };
