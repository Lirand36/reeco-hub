// HubSpot CRM v3. Docs: https://developers.hubspot.com/docs/api/crm/deals
import { send } from './http.js';

const BASE = 'https://api.hubapi.com';
const token = () => process.env.HUBSPOT_TOKEN;
export const isLive = () => Boolean(token());
const auth = () => ({ Authorization: `Bearer ${token()}` });

export function updateDeal(dealId, properties, action = 'Update deal', summary = 'Updated the deal') {
  return send({
    system: 'hubspot',
    action,
    summary,
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
    summary: 'Saved the note on the company',
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

// Logs a sales email on the deal's timeline (association type 210 = email → deal).
export function logEmail(dealId, { to, subject, body }) {
  return send({
    system: 'hubspot',
    action: 'Log email',
    summary: `Logged the email “${subject}” on the deal`,
    method: 'POST',
    url: `${BASE}/crm/v3/objects/emails`,
    headers: auth(),
    body: {
      properties: { hs_timestamp: new Date().toISOString(), hs_email_direction: 'EMAIL', hs_email_status: 'SENT', hs_email_subject: subject, hs_email_text: body, hs_email_headers: JSON.stringify({ to: [{ email: to }] }) },
      associations: [{ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 210 }] }],
    },
    live: isLive(),
    mockResponse: () => ({ id: String(Math.floor(Math.random() * 1e10)), createdAt: new Date().toISOString() }),
  });
}
