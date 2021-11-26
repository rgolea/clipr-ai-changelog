const asana = require('asana');

/**
 * Finds an Asana task by its short numeric ID (generated by the custom Asana tool).
 */
async function findAsanaTask(taskId) {
  const personalAccessToken = process.env.ASANA_PAT;
  const workspaceGid = process.env.WORKSPACE_GID;

  // initialize the asana client
  const client = asana.Client.create().useAccessToken(personalAccessToken);

  const results = await client.tasks.searchTasksForWorkspace(workspaceGid, { text: taskId, fields: 'name,permalink_url' });

  if (!results.data || !results.data.length) throw new Error(`Could not find the Asana task with id ${taskId}`);
  if (results.data.length > 1) throw new Error(`Found multiple Asana tasks with id ${taskId}`);

  return results.data[0];
}

/**
 * Checks if an issue/PR has its associated Asana task link in the body. If it doesn't, it attempts to add it and updates the title to match the convention.
 */
module.exports = async ({ github, context, core }) => {
  if (!context.payload.pull_request) {
    console.error(`Unsupported payload: ${JSON.stringify(context.payload)}`);
    return;
  }

  const prBody = context.payload.pull_request.body;
  const prBranch = context.payload.pull_request.head.ref;

  const asanaLinkRegex = /Asana task: \[.+\]\(.*\)\n/;
  const branchFormatRegex = /(?<taskId>\d+)\-(?<taskSlug>.+)/;
  const asanaTaskNameRegex = /^(?<taskId>\d+)\ \-\ (?<taskName>.*$)/;

  const branchFormatMatch = prBranch.match(branchFormatRegex);

  if (!branchFormatRegex) {
    console.error(`Unsupported branch name format: ${prBranch}`);
    return;
  }

  const taskId = branchFormatMatch.groups.taskId;
  const asanaLinkPlaceholder = '_asanaTaskLink_';

  // check if the github PR needs an asana task link
  if (prBody && prBody.includes(asanaLinkPlaceholder)) {
    // the PR has a placeholder for the asana task link, so we need to add it
    // but first we need to search for the task in the workspace
    const task = await findAsanaTask(taskId);

    // replace the placeholder
    const newBody = prBody.replace(asanaLinkPlaceholder, `[${task.name}](${task.permalink_url})`);

    // add the asana task permalink to the issue body
    const updateParams = {
      issue_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
      body: newBody
    };

    // update the issue title to match the convention (if the asana task name matches convention too)
    const asanaTaskNameFormat = task.name.match(asanaTaskNameRegex);

    if (asanaTaskNameFormat) {
      updateParams.title = `[${asanaTaskNameFormat.groups.taskId}] ${asanaTaskNameFormat.groups.taskName}`
    }

    await github.issues.update(updateParams);

    console.log('Updated pull request details.');
  } else {
    console.log('Pull request doesn\'t need updating.');
  }
}


module.exports.replaceReleaseBodyAndPublish = async function (github, context) {
  const lines = process.env.BODY.split('\n');

  const TASK_ID_REGEX = /^\*(\s)(\[([0-9]*)\])(?!\(https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)\))/gi;

  const updatedLines = await Promise.all(lines.map(async line => {
    const match = line.match(TASK_ID_REGEX);
    if (match) {
      const taskId = match[0].match(/\d*/gi).filter(Boolean)[0];
      try {
        const task = await findAsanaTask(taskId);
        line = line.replace(match[0], `[${match[0]}(${task.permalink_url})]`);
      } catch (e) {
        console.info(e);
        return line;
      }
    }
    return line;
  }));

  const newBody = updatedLines.join('\n');

  await github.repos.updateRelease({
    owner: context.repo.owner,
    repo: context.repo.repo,
    release_id: process.env.RELEASE_ID,
    body: newBody,
    draft: false
  });
}
