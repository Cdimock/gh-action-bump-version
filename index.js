// test
const { execSync, spawn } = require('child_process');
const { existsSync } = require('fs');
const { EOL } = require('os');
const path = require('path');

// Change working directory if user defined PACKAGEJSON_DIR
if (process.env.PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
}

const workspace = process.env.GITHUB_WORKSPACE;

(async () => {
  const pkg = getPackageJson();
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};

  if (!event.commits) {
    console.log("Couldn't find any commits in this event, incrementing patch version...");
  }

  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || '';
  const messages = event.commits ? event.commits.map((commit) => commit.message + '\n' + commit.body) : [];

  const commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: Build Number bump to {{buildNumber}}';
  console.log('commit messages:', messages);

  const bumpPolicy = process.env['INPUT_BUMP-POLICY'] || 'all';
  const commitMessageRegex = new RegExp(commitMessage.replace(/{{buildNumber}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+`), 'ig');

  let isVersionBump = false;

  if (bumpPolicy === 'all') {
    isVersionBump = messages.find((message) => commitMessageRegex.test(message)) !== undefined;
  } else if (bumpPolicy === 'last-commit') {
    isVersionBump = messages.length > 0 && commitMessageRegex.test(messages[messages.length - 1]);
  } else if (bumpPolicy === 'ignore') {
    console.log('Ignoring any version bumps in commits...');
  } else {
    console.warn(`Unknown bump policy: ${bumpPolicy}`);
  }

  if (isVersionBump) {
    exitSuccess('No action necessary because we found a previous bump!');
    return;
  }

  // get default version bump
  let version = process.env.INPUT_DEFAULT;
  let foundWord = null;
  // get the pre-release prefix specified in action
  let preid = process.env.INPUT_PREID;

  // case: if user sets push to false, to skip pushing new tag/package.json
  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    exitSuccess('User requested to skip pushing new tag and package.json. Finished.');
    return;
  }

  // GIT logic
  try {
    const currentVersion = pkg.version.toString();
    const currentBuild = pkg.buildNumber.toString();
    const newBuild = parseInt(currentBuild) + 1;
    const buildTag = `${tagPrefix}${newBuild}`;
    // set git user
    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', [
      'config',
      'user.email',
      `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`,
    ]);

    let currentBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF)[1];
    let isPullRequest = false;
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF;
      isPullRequest = true;
    }
    if (process.env['INPUT_TARGET-BRANCH']) {
      // We want to override the branch that we are pulling / pushing to
      currentBranch = process.env['INPUT_TARGET-BRANCH'];
    }
    console.log('currentBranch:', currentBranch);
    // do it in the current checked out github branch (DETACHED HEAD)
    // important for further usage of the package.json version
    console.log('currentBuild:', currentBuild);
    console.log('newBuild:', newBuild);
    
    console.log('Step 1');

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      console.log('Step 1.1');
      // First fetch to get updated local version of branch
      await runInWorkspace('git', ['fetch']);
    }
    console.log('Step 2');
    await runInWorkspace('git', ['checkout', currentBranch]);
    console.log('Step 3');

    let calcedNum = execSync(`git tag -l --sort=-version:refname "build/[0-9]*"|head -n 1`).toString().split("/")[1];

    console.log('Calculated build number from tag');
    
    //update build Number here
    updateBuildNumber(newBuild);
    
    console.log('buildNumber in package.json', getPackageJson().buildNumber);
    try {
      // to support "actions/checkout@v1"
      if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
        await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{buildNumber}}/g, newBuild)]);
      }
    } catch (e) {
      console.warn(
        'git commit failed because you are using "actions/checkout@v2"; ' +
          'but that doesnt matter because you dont need that git commit, thats only for "actions/checkout@v1"',
      );
    }

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      await runInWorkspace('git', ['tag', buildTag]);
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo, '--follow-tags']);
        await runInWorkspace('git', ['push', remoteRepo, '--tags']);
      }
    } else {
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo]);
      }
    }
  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess('Version bumped!');
})();

function updateBuildNumber(buildNumber) {
  const fs = require('fs');
  const fileName = path.join(workspace, 'package.json');
  const file = require(fileName);
      
  file.buildNumber = `${buildNumber}`;
      
  fs.writeFile(fileName, JSON.stringify(file, null, 2), function writeJSON(err) {
    if (err) return console.log(err);
    // console.log(JSON.stringify(file));
    console.log('writing to ' + fileName);
  });
}

function getPackageJson() {
  const pathToPackage = path.join(workspace, 'package.json');
  if (!existsSync(pathToPackage)) throw new Error("package.json could not be found in your project's root.");
  return require(pathToPackage);
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
  //return execa(command, args, { cwd: workspace });
}
