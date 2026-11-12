// Code node: "Attach Contact" (Run Once for All Items)
// Merges the optional HubSpot contact lookup (owner, contact ID) into the item. Works with or without a lookup result.
const incoming = $input.first().json;
const base = incoming.decision ? incoming : $('Decide Route').first().json;

let contact = {};
if (!incoming.decision && Array.isArray(incoming.results) && incoming.results[0]) {
  const r = incoming.results[0];
  contact = { hubspotContactId: String(r.id), ownerId: (r.properties && r.properties.hubspot_owner_id) || '' };
}

return [{ json: Object.assign({}, base, { contact }) }];
