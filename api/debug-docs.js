module.exports = async function handler(req, res) {
  const workspaceId = (process.env.CLICKUP_WORKSPACE_ID || '').trim();
  const token = (process.env.CLICKUP_API_TOKEN || '').trim();

  const results = {};

  // Test 1: v3 docs list (what listInfoDocs uses)
  try {
    const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs`, {
      method: 'GET',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
    });
    const body = await resp.text();
    results.v3DocsList = {
      status: resp.status,
      bodyPreview: body.slice(0, 2000),
    };
  } catch (err) {
    results.v3DocsList = { error: err.message };
  }

  // Test 2: v3 search
  try {
    const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/search`, {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Client Info Doc', types: ['doc'], limit: 5 }),
    });
    const body = await resp.text();
    results.v3Search = {
      status: resp.status,
      bodyPreview: body.slice(0, 2000),
    };
  } catch (err) {
    results.v3Search = { error: err.message };
  }

  return res.status(200).json({
    workspaceId: workspaceId ? `${workspaceId.slice(0, 4)}...` : 'MISSING',
    tokenPresent: !!token,
    results,
  });
};
