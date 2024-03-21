import * as core from "@actions/core";
import * as github from "@actions/github";
import fg from "fast-glob";
import fs from "fs";
import path from "path";
import mime from "mime-types";
import {inspect} from "node:util";

async function run() {
  try {
    const repo = github.context.repo;
    const glob = core.getInput("files", { required: true });
    const tag = core.getInput("release-tag");
    const org = core.getInput("monorepo-org");
    const releaseId = core.getInput("release-id");
    const token = core.getInput("repo-token", { required: true });

    const octokit = github.getOctokit(token);

    let releases: [number, string[]][] = [];  // list of (releaseId, assets[])

    if (releaseId && Number.isInteger(parseInt(releaseId))) {
      core.debug(`Using explicit release id ${releaseId}...`);

      const files = await fg(glob.split(";"));
      if (!files.length) {
        core.setFailed("No files found");
        return;
      }

      releases.push([parseInt(releaseId), files]);
    } else if (tag) {
      core.debug(`Getting release id for ${tag}...`);

      const files = await fg(glob.split(";"));
      if (!files.length) {
        core.setFailed("No files found");
        return;
      }
      const release = await octokit.rest.repos.getReleaseByTag({
        ...repo,
        tag,
      });

      releases.push([release.data.id, files]);
    } else if (org) {
      core.debug(`Monorepo release for org:${org}...`);

      const files = await fg(glob.split(";"));
      if (!files.length) {
        core.setFailed("No files found");
        return;
      }

      const orgPkgVer = new RegExp(`${org}-([-_\\w]+)-((0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)).*`);
      const monorepoAssetsReleases = files.reduce((out: {[key: string]: {[key: string]: string[]}}, file: string) => {
        const match = file.match(orgPkgVer);
        if (match && match.input) {
          if (match[1] in out) {
            if (match[2] in out[match[1]]) {
              out[match[1]][match[2]].push(match.input);
            } else {
              out[match[1]] = { [match[2]]: [match.input] };
            }
          } else {
            out[match[1]] = { [match[2]]: [match.input] };
          }
        }
        return out;
      }, {});

      core.debug(`Monorepo releases: ${inspect(monorepoAssetsReleases)}`);
      for (const pkg of Object.keys(monorepoAssetsReleases)) {
        for (const ver of Object.keys(monorepoAssetsReleases[pkg])) {
          const release = await octokit.rest.repos.getReleaseByTag({
            ...repo,
            tag: `@${org}/${pkg}@${ver}`,
          });
          core.debug(`Monorepo release tag:"@${org}/${pkg}@${ver}" id:${release.data.id}`);
          if (release.data.id) {
            releases.push([release.data.id, monorepoAssetsReleases[pkg][ver]]);
          }
        }
      }


    } else {
      core.debug(
        `Using release id from action ${github.context.payload.release.id}...`
      );

      const files = await fg(glob.split(";"));
      if (!files.length) {
        core.setFailed("No files found");
        return;
      }
      releases.push([github.context.payload.release.id, files]);
    }

    if (releases.length == 0) {
      core.setFailed("Could not find release");
      return;
    }

    for (const release of releases) {
      const [release_id, files] = release;
      core.debug(`Uploading assets to release: ${release_id}...`);

      const {
        data: { upload_url: upload_url, html_url: html_url },
      } = await octokit.rest.repos.getRelease({ ...repo, release_id });

      const { data: existingAssets } = await octokit.rest.repos.listReleaseAssets(
        {
          ...repo,
          release_id,
        }
      );

      for (let file of files) {
        const existingAsset = existingAssets.find((a: any) => a.name === file);
        if (existingAsset) {
          core.debug(
            `Removing existing asset '${file}' with ID ${existingAsset.id}...`
          );
          octokit.rest.repos.deleteReleaseAsset({
            ...repo,
            asset_id: existingAsset.id,
          });
        }

        const fileName = path.basename(file);
        const fileStream = fs.readFileSync(file);
        const contentType = mime.lookup(file) || "application/zip";

        console.log(`Uploading ${file}...`);
        core.debug(`Content-Type = '${contentType}'`);

        const headers = {
          "content-type": contentType,
          "content-length": fs.statSync(file).size,
        };

        await octokit.rest.repos.uploadReleaseAsset({
          ...repo,
          url: upload_url as string,
          release_id: release_id,
          headers,
          name: fileName,
          // Octokits typings only accept string, but the code also accepts Buffer, so this tricks Typescript into allowing the buffer
          data: fileStream as unknown as string,
        });
      }

      console.log(`Upload complete: ${html_url}`);
    }
  } catch (error: any) {
    const message = error?.message || "Unknown error";
    core.setFailed(message);
  }
}

run();
