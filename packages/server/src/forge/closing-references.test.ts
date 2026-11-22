import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, writeTestConfig, type Route } from "../testing/forge-fetch.js";

process.env.GITHUB_TOKEN = "gh-agent";
process.env.GITLAB_TOKEN = "gl-agent";
process.env.CRC_CONFIG_PATH = writeTestConfig({ gitlab_url: "https://gitlab.test" });

const github = await import("./github.js");
const gitlab = await import("./gitlab.js");
const { getForge } = await import("./index.js");

const MR = "https://gitlab.test/api/v4/projects/acme%2Fwidgets/merge_requests/5";
const PROJECT_ID = 77;

function closedIssue(iid: number, projectId = PROJECT_ID): Record<string, unknown> {
  return { id: 9000 + iid, iid, project_id: projectId, title: `Issue ${iid}` };
}

function gitlabRoutes(pages: unknown[][], detail: Record<string, unknown> = { iid: 5, target_project_id: PROJECT_ID }): Route[] {
  return [
    (request) => (request.url === MR ? { json: detail } : null),
    (request) => {
      if (!request.url.startsWith(`${MR}/closes_issues?`)) return null;
      const page = Number(new URL(request.url).searchParams.get("page"));
      return { json: pages[page - 1] ?? [] };
    },
  ];
}

describe("GitLab closing references", () => {
  it("maps the issues the merge request closes to their references", async () => {
    const requests = stubFetch(gitlabRoutes([[closedIssue(123), closedIssue(4)]]));

    assert.deepEqual(await gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5"), ["#123", "#4"]);
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url} as ${request.token}`),
      [`GET ${MR} as gl-agent`, `GET ${MR}/closes_issues?per_page=100&page=1 as gl-agent`],
    );
  });

  it("reports nothing when the merge request closes no issue", async () => {
    stubFetch(gitlabRoutes([[]]));
    assert.deepEqual(await gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5"), []);
  });

  it("drops issues that belong to another project, even when the iid matches", async () => {
    stubFetch(gitlabRoutes([[closedIssue(123, 999), closedIssue(8)]]));
    assert.deepEqual(await gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5"), ["#8"]);
  });

  it("drops external-tracker entries that carry no project or iid", async () => {
    stubFetch(gitlabRoutes([[{ id: "PROJ-1", title: "Jira issue" }, closedIssue(8)]]));
    assert.deepEqual(await gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5"), ["#8"]);
  });

  it("follows pagination until a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => closedIssue(index + 1));
    const requests = stubFetch(gitlabRoutes([firstPage, [closedIssue(101)]]));

    const references = await gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5");

    assert.equal(references.length, 101);
    assert.equal(references[0], "#1");
    assert.equal(references[100], "#101");
    assert.deepEqual(
      requests.map((request) => request.url).filter((url) => url.includes("closes_issues")),
      [`${MR}/closes_issues?per_page=100&page=1`, `${MR}/closes_issues?per_page=100&page=2`],
    );
  });

  it("fails loudly when the forge rejects the request", async () => {
    stubFetch([
      (request) => (request.url === MR ? { json: { iid: 5, target_project_id: PROJECT_ID } } : null),
      (request) => (request.url.startsWith(`${MR}/closes_issues?`) ? { status: 500, text: "boom" } : null),
    ]);
    await assert.rejects(gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5"), /GitLab API error.*500.*boom/);
  });

  it("fails loudly when the merge request reports no target project", async () => {
    stubFetch(gitlabRoutes([[closedIssue(8)]], { iid: 5 }));
    await assert.rejects(
      gitlab.fetchMergeRequestClosingReferences("acme/widgets", "5"),
      /acme\/widgets!5 reported no target project id/,
    );
  });

  it("is what the GitLab forge exposes as getClosingWorkItemReferences", async () => {
    stubFetch(gitlabRoutes([[closedIssue(123)]]));
    assert.deepEqual(await getForge("gitlab").getClosingWorkItemReferences("acme/widgets", "5"), ["#123"]);
  });
});

interface ClosingNode {
  number: number;
  repository: { nameWithOwner: string };
}

function closingNode(number: number, nameWithOwner = "acme/widgets"): ClosingNode {
  return { number, repository: { nameWithOwner } };
}

function githubRoutes(pages: Array<{ nodes: ClosingNode[]; endCursor: string | null }>): Route[] {
  return [
    (request) => {
      if (request.url !== "https://api.github.com/graphql") return null;
      const { variables } = request.body as { variables: { cursor: string | null } };
      const index = variables.cursor === null ? 0 : pages.findIndex((page) => page.endCursor === variables.cursor) + 1;
      const page = pages[index];
      return {
        json: {
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  pageInfo: { hasNextPage: index < pages.length - 1, endCursor: page.endCursor },
                  nodes: page.nodes,
                },
              },
            },
          },
        },
      };
    },
  ];
}

describe("GitHub closing references", () => {
  it("asks GraphQL for the pull request's closing issues and maps them to references", async () => {
    const requests = stubFetch(githubRoutes([{ nodes: [closingNode(123), closingNode(4)], endCursor: null }]));

    assert.deepEqual(await github.fetchPullRequestClosingReferences("acme/widgets", "12"), ["#123", "#4"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].token, "gh-agent");
    const body = requests[0].body as { query: string; variables: Record<string, unknown> };
    assert.equal(body.query, github.CLOSING_ISSUES_QUERY);
    assert.match(body.query, /closingIssuesReferences\(first: 100, after: \$cursor\)/);
    assert.deepEqual(body.variables, { owner: "acme", name: "widgets", number: 12, cursor: null });
  });

  it("reports nothing when the pull request closes no issue", async () => {
    stubFetch(githubRoutes([{ nodes: [], endCursor: null }]));
    assert.deepEqual(await github.fetchPullRequestClosingReferences("acme/widgets", "12"), []);
  });

  it("drops issues that belong to another repository, even when the number matches", async () => {
    stubFetch(githubRoutes([{ nodes: [closingNode(123, "acme/other"), closingNode(8)], endCursor: null }]));
    assert.deepEqual(await github.fetchPullRequestClosingReferences("acme/widgets", "12"), ["#8"]);
  });

  it("matches the repository name case-insensitively, as GitHub does", async () => {
    stubFetch(githubRoutes([{ nodes: [closingNode(8, "Acme/Widgets")], endCursor: null }]));
    assert.deepEqual(await github.fetchPullRequestClosingReferences("acme/widgets", "12"), ["#8"]);
  });

  it("follows pagination through the cursor", async () => {
    const requests = stubFetch(
      githubRoutes([
        { nodes: [closingNode(1)], endCursor: "cursor-1" },
        { nodes: [closingNode(2)], endCursor: null },
      ]),
    );

    assert.deepEqual(await github.fetchPullRequestClosingReferences("acme/widgets", "12"), ["#1", "#2"]);
    assert.deepEqual(
      requests.map((request) => (request.body as { variables: { cursor: string | null } }).variables.cursor),
      [null, "cursor-1"],
    );
  });

  it("fails loudly when the pull request does not exist", async () => {
    stubFetch([() => ({ json: { data: { repository: { pullRequest: null } } } })]);
    await assert.rejects(
      github.fetchPullRequestClosingReferences("acme/widgets", "12"),
      /GitHub pull request not found: acme\/widgets#12/,
    );
  });

  it("fails loudly on a GraphQL error", async () => {
    stubFetch([() => ({ json: { errors: [{ message: "rate limited" }] } })]);
    await assert.rejects(github.fetchPullRequestClosingReferences("acme/widgets", "12"), /GitHub GraphQL error: rate limited/);
  });

  it("is what the GitHub forge exposes as getClosingWorkItemReferences", async () => {
    stubFetch(githubRoutes([{ nodes: [closingNode(123)], endCursor: null }]));
    assert.deepEqual(await getForge("github").getClosingWorkItemReferences("acme/widgets", "12"), ["#123"]);
  });
});
