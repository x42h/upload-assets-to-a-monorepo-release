"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const fast_glob_1 = __importDefault(require("fast-glob"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const mime_types_1 = __importDefault(require("mime-types"));
async function run() {
    try {
        const repo = github.context.repo;
        const glob = core.getInput("files", { required: true });
        const tag = core.getInput("release-tag");
        const org = core.getInput("monorepo-org");
        const releaseId = core.getInput("release-id");
        const token = core.getInput("repo-token", { required: true });
        const octokit = github.getOctokit(token);
        let releases = []; // list of (releaseId, assets[])
        if (releaseId && Number.isInteger(parseInt(releaseId))) {
            core.debug(`Using explicit release id ${releaseId}...`);
            const files = await (0, fast_glob_1.default)(glob.split(";"));
            if (!files.length) {
                core.setFailed("No files found");
                return;
            }
            releases.push([parseInt(releaseId), files]);
        }
        else if (tag) {
            core.debug(`Getting release id for ${tag}...`);
            const files = await (0, fast_glob_1.default)(glob.split(";"));
            if (!files.length) {
                core.setFailed("No files found");
                return;
            }
            const release = await octokit.rest.repos.getReleaseByTag({
                ...repo,
                tag,
            });
            releases.push([release.data.id, files]);
        }
        else if (org) {
            core.debug(`Monorepo release for org:${org}...`);
            const files = await (0, fast_glob_1.default)(glob.split(";"));
            if (!files.length) {
                core.setFailed("No files found");
                return;
            }
            const orgPkgVer = new RegExp(`${org}-([-_\\w]+)-((0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)).*`);
            const monorepoAssetsReleases = files.reduce((out, file) => {
                const match = file.match(orgPkgVer);
                if (match) {
                    if (match[1] in out) {
                        if (match[2] in out[match[1]]) {
                            out[match[1]][match[2]].push(match[0]);
                        }
                        else {
                            out[match[1]] = { [match[2]]: [match[0]] };
                        }
                    }
                    else {
                        out[match[1]] = { [match[2]]: [match[0]] };
                    }
                }
                return out;
            }, {});
            core.debug(`Monorepo releases: ${monorepoAssetsReleases}`);
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
        }
        else {
            core.debug(`Using release id from action ${github.context.payload.release.id}...`);
            const files = await (0, fast_glob_1.default)(glob.split(";"));
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
            const { data: { upload_url: upload_url, html_url: html_url }, } = await octokit.rest.repos.getRelease({ ...repo, release_id });
            const { data: existingAssets } = await octokit.rest.repos.listReleaseAssets({
                ...repo,
                release_id,
            });
            for (let file of files) {
                const existingAsset = existingAssets.find((a) => a.name === file);
                if (existingAsset) {
                    core.debug(`Removing existing asset '${file}' with ID ${existingAsset.id}...`);
                    octokit.rest.repos.deleteReleaseAsset({
                        ...repo,
                        asset_id: existingAsset.id,
                    });
                }
                const fileName = path_1.default.basename(file);
                const fileStream = fs_1.default.readFileSync(file);
                const contentType = mime_types_1.default.lookup(file) || "application/zip";
                console.log(`Uploading ${file}...`);
                core.debug(`Content-Type = '${contentType}'`);
                const headers = {
                    "content-type": contentType,
                    "content-length": fs_1.default.statSync(file).size,
                };
                await octokit.rest.repos.uploadReleaseAsset({
                    ...repo,
                    url: upload_url,
                    release_id: release_id,
                    headers,
                    name: fileName,
                    // Octokits typings only accept string, but the code also accepts Buffer, so this tricks Typescript into allowing the buffer
                    data: fileStream,
                });
            }
            console.log(`Upload complete: ${html_url}`);
        }
    }
    catch (error) {
        const message = error?.message || "Unknown error";
        core.setFailed(message);
    }
}
run();
//# sourceMappingURL=main.js.map