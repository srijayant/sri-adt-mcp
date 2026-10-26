import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { attrs, esc, findAll, parseXml } from '../adt/xml.js';

const NS = 'http://www.sap.com/adt/abapgit/repositories';

const gitAuth = {
  gitUser: z.string().optional().describe('Git remote user (private repos)'),
  gitPassword: z.string().optional().describe('Git remote password / token'),
};

function authHeaders(a: { gitUser?: string; gitPassword?: string }): Record<string, string> {
  const h: Record<string, string> = {};
  if (a.gitUser) h.Username = a.gitUser;
  if (a.gitPassword) h.Password = Buffer.from(a.gitPassword).toString('base64');
  return h;
}

export const abapgitTools = [
  tool({
    name: 'abapgit_list_repos',
    description: 'List abapGit repositories linked in the system (requires abapGit ADT backend).',
    schema: { ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get('/abapgit/repos', { accept: 'application/abapgit.adt.repos.v2+xml', destination: a.destination });
      return findAll(parseXml(r.body), 'repository').map((x: any) => ({
        key: x.key,
        package: x.package,
        url: x.url,
        branch: x.branchName,
        status: x.status,
        statusText: x.statusText,
        links: findAll(x, 'link').map(attrs).map((l) => ({ rel: l.rel, href: l.href })),
      }));
    },
  }),

  tool({
    name: 'abapgit_link_repo',
    description: 'Link (clone) a git repository into a package.',
    write: true,
    schema: {
      url: z.string(),
      packageName: z.string(),
      branch: z.string().default('refs/heads/main'),
      transport: z.string().optional(),
      ...gitAuth,
      ...destinationArg,
    },
    handler: async (a, { client }) =>
      (
        await client.post('/abapgit/repos', {
          contentType: 'application/abapgit.adt.repo.v3+xml',
          headers: authHeaders(a),
          body: `<?xml version="1.0" encoding="UTF-8"?><abapgitrepo:repository xmlns:abapgitrepo="${NS}"><abapgitrepo:package>${esc(a.packageName.toUpperCase())}</abapgitrepo:package><abapgitrepo:url>${esc(a.url)}</abapgitrepo:url><abapgitrepo:branchName>${esc(a.branch)}</abapgitrepo:branchName><abapgitrepo:transportRequest>${esc(a.transport ?? '')}</abapgitrepo:transportRequest><abapgitrepo:remoteUser>${esc(a.gitUser ?? '')}</abapgitrepo:remoteUser><abapgitrepo:remotePassword>${esc(a.gitPassword ?? '')}</abapgitrepo:remotePassword></abapgitrepo:repository>`,
          destination: a.destination,
        })
      ).body || 'Linked.',
  }),

  tool({
    name: 'abapgit_pull',
    description: 'Pull a linked abapGit repository into the system.',
    write: true,
    schema: {
      key: z.string().describe('Repository key from abapgit_list_repos'),
      branch: z.string().optional(),
      transport: z.string().optional(),
      ...gitAuth,
      ...destinationArg,
    },
    handler: async (a, { client }) =>
      (
        await client.post(`/abapgit/repos/${encodeURIComponent(a.key)}/pull`, {
          contentType: 'application/abapgit.adt.repo.v3+xml',
          headers: authHeaders(a),
          body: `<?xml version="1.0" encoding="UTF-8"?><abapgitrepo:repository xmlns:abapgitrepo="${NS}"><abapgitrepo:branchName>${esc(a.branch ?? '')}</abapgitrepo:branchName><abapgitrepo:transportRequest>${esc(a.transport ?? '')}</abapgitrepo:transportRequest><abapgitrepo:remoteUser>${esc(a.gitUser ?? '')}</abapgitrepo:remoteUser><abapgitrepo:remotePassword>${esc(a.gitPassword ?? '')}</abapgitrepo:remotePassword></abapgitrepo:repository>`,
          destination: a.destination,
        })
      ).body || 'Pull started.',
  }),

  tool({
    name: 'abapgit_stage',
    description: 'Show staging info (changed local/remote objects) for a repository. The returned XML can be edited and passed to abapgit_push.',
    write: true,
    schema: { key: z.string(), ...gitAuth, ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get(`/abapgit/repos/${encodeURIComponent(a.key)}/stage`, {
          accept: 'application/abapgit.adt.repo.stage.v1+xml',
          headers: authHeaders(a),
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'abapgit_push',
    description: 'Commit & push staged objects. `stagingXml` = output of abapgit_stage with the desired objects in <staged_objects> and a <comment>.',
    write: true,
    schema: { key: z.string(), stagingXml: z.string(), ...gitAuth, ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.post(`/abapgit/repos/${encodeURIComponent(a.key)}/push`, {
          contentType: 'application/abapgit.adt.repo.stage.v1+xml',
          headers: authHeaders(a),
          body: a.stagingXml,
          destination: a.destination,
        })
      ).body || 'Pushed.',
  }),
];
