module.exports = async function handler(req, res) {
  const workspaceId = (process.env.CLICKUP_WORKSPACE_ID || '').trim();
  const token = (process.env.CLICKUP_API_TOKEN || '').trim();

  // Paginate through all docs to find Info Docs
  let allDocs = [];
  let nextCursor = undefined;
  let pages = 0;

  while (pages < 10) {
    const url = nextCursor
      ? `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs?cursor=${nextCursor}`
      : `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs`;

    const resp = await fetch(url, {
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
    });

    if (!resp.ok) {
      return res.status(200).json({ error: `HTTP ${resp.status}`, page: pages });
    }

    const data = await resp.json();
    const docs = data.docs || [];
    allDocs.push(...docs);
    pages++;

    // Check for next page
    if (data.next_cursor) {
      nextCursor = data.next_cursor;
    } else {
      break;
    }
  }

  // Filter for Info Docs
  const infoDocs = allDocs.filter(d => {
    const name = (d.name || '').toLowerCase();
    return /(info|client info)/i.test(name) && !/template/i.test(name) && !/definitions/i.test(name) && !/^sprint/i.test(name);
  });

  return res.status(200).json({
    totalDocs: allDocs.length,
    pages,
    infoDocs: infoDocs.map(d => ({ id: d.id, name: d.name })),
    firstDocName: allDocs[0]?.name,
    lastDocName: allDocs[allDocs.length - 1]?.name,
  });
};
