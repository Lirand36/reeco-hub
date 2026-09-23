// HubSpot CRM v3. Docs: https://developers.hubspot.com/docs/api/crm/deals
import { send } from './http.js';

const BASE = 'https://api.hubapi.com';
const token = () => process.env.HUBSPOT_TOKEN;
export const isLive = () => Boolean(token());
const auth = () => ({ Authorization: `Bearer ${token()}` });

export function updateDeal(dealId, properties, action = 'Update deal') {
  return send({
    system: 'hubspot',
    action,
    method: 'PATCH',
    url: `${BASE}/crm/v3/objects/deals/${dealId}`,
    headers: auth(),
    body: { properties },
    live: isLive(),
    mockResponse: { id: dealId, properties, updatedAt: new Date().toISOString() },
  });
}

// Notes are a CRM object associated to the company (association type 190 = note → company).
export function createNote(companyId, text) {
  return send({
    system: 'hubspot',
    action: 'Create note',
    method: 'POST',
    url: `${BASE}/crm/v3/objects/notes`,
    headers: auth(),
    body: {
      properties: { hs_note_body: text, hs_timestamp: new Date().toISOString() },
      associations: [
        { to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }] },
      ],
    },
    live: isLive(),
    mockResponse: () => ({ id: String(Math.floor(Math.random() * 1e10)), createdAt: new Date().toISOString() }),
  });
}
