// withScoutSiri.js — injects plugins/scout-siri/ScoutIntents.swift into the main
// iOS app target at prebuild, enabling the "Hey Siri, ask Scout …" App Intent
// (in-app App Intents, iOS 16+; no extension target). Registered in app.json
// `plugins`. Android is untouched.
const { withXcodeProject, IOSConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const FILE_NAME = "ScoutIntents.swift";

module.exports = function withScoutSiri(config) {
  return withXcodeProject(config, (config) => {
    const projectName = config.modRequest.projectName;
    const src = path.join(config.modRequest.projectRoot, "plugins", "scout-siri", FILE_NAME);
    const dstDir = path.join(config.modRequest.platformProjectRoot, projectName);
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, path.join(dstDir, FILE_NAME));

    const relPath = `${projectName}/${FILE_NAME}`;
    if (!config.modResults.hasFile(relPath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: relPath,
        groupName: projectName,
        project: config.modResults,
      });
    }
    return config;
  });
};
