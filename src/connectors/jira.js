// Jira Cloud REST v3. Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
import { send } from './http.js';

const cfg = () => ({
  base: process.env.JIRA_BASE_URL?.replace(/\/$/, ''),
  email: process.env.JIRA_EMAIL,
  token: process.env.JIRA_API_TOKEN,
  supportProject: process.env.JIRA_SUPPORT_PROJECT || 'SUP',
  onboardingProject: process.env.JIRA_ONBOARDING_PROJECT || 'ONB',
});
export const isLive = () => {
  const c = cfg();
  return Boolean(c.base && c.email && c.token);
};

const seq = { SUP: 2310, ONB: 118 };

// project: 'support' | 'onboarding'
export function createIssue({ project = 'support', type = 'Task', summary, description, priority = 'Medium', labels = [] }) {
  const c = cfg();
  const key = project === 'onboarding' ? c.onboardingProject : c.supportProject;
  return send({
    system: 'jira',
    action: type === 'Epic' ? 'Create epic' : 'Create issue',
    summary: (r) => `Opened ${type === 'Epic' ? 'onboarding epic' : type === 'Bug' ? 'engineering bug' : 'ticket'} ${r.key}`,
    method: 'POST',
    url: `${c.base || 'https://reeco.atlassian.net'}/rest/api/3/issue`,
    headers: { Authorization: `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}` },
    body: {
      fields: {
        project: { key },
        issuetype: { name: type },
        summary,
        priority: { name: priority },
        labels,
        // Jira v3 requires Atlassian Document Format for rich text
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: description || summary }] }],
        },
      },
    },
    live: isLive(),
    mockResponse: () => {
      seq[key] = (seq[key] ?? 100) + 1;
      return { id: String(10000 + seq[key]), key: `${key}-${seq[key]}`, self: `mock://jira/issue/${seq[key]}` };
    },
  });
}
